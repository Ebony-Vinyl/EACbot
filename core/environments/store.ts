/**
 * Durable record of the computers a person has added.
 *
 * The store is a JSON document in a directory the caller injects, written by
 * replace-into-place so a crash leaves either the old file or the new one.
 * The file is created 0600 and its directory 0700: the record names a host, a
 * user and where a key lives, which is not public information.
 *
 * A record can never carry a secret. That is checked on the way in, so a bug
 * upstream cannot persist one, and again on the way out of a loaded file.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { SECRET_FIELD_NAMES } from "../../packages/agent-protocol/environment.ts";
import {
  DuplicateEnvironmentError,
  EnvironmentRevisionConflictError,
  EnvironmentStoreBusyError,
  EnvironmentStoreCorruptError,
  InvalidEnvironmentError,
  SecretInEnvironmentError,
  UnknownEnvironmentError,
} from "./errors.ts";
import {
  DOCUMENT_VERSION,
  ENVIRONMENT_STATUSES,
  TOOL_NAMES,
  TOOL_STATUSES,
  UNKNOWN_CAPABILITIES,
  type EnvironmentCapabilities,
  type EnvironmentDocument,
  type EnvironmentDraft,
  type EnvironmentRecord,
  type EnvironmentStatus,
  type InstalledTool,
  type ProbeSnapshot,
} from "./types.ts";

const FILE_NAME = "environments.json";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/** Field names this layer refuses anywhere in a record, including nested ones.
 * The protocol's list is the baseline; a pairing secret is this layer's own
 * addition, because a pairing flow is where one would otherwise be parked. */
const FORBIDDEN_FIELDS: readonly string[] = [...SECRET_FIELD_NAMES, "pairingSecret", "privateKeyBody"];

export interface StoreOptions {
  readonly dataDir: string;
  readonly fileName?: string;
}

export interface AddOptions {
  /** A caller-supplied id, for an idempotent retry of the same add. */
  readonly id?: string;
  readonly now?: string;
  /** Add a second record for the same computer instead of returning the first. */
  readonly allowDuplicateTarget?: boolean;
}

export interface RecordPatch {
  readonly label?: string;
  readonly status?: EnvironmentStatus;
  readonly lastSeen?: string | null;
  readonly capabilities?: EnvironmentCapabilities;
  readonly tools?: readonly InstalledTool[];
  readonly knownHostsFile?: string;
  readonly hostKeyFingerprint?: string;
  readonly identityFileRef?: string | null;
}

export class EnvironmentStore {
  readonly dataDir: string;
  readonly filePath: string;
  private records: EnvironmentRecord[] = [];
  private queue: Promise<void> = Promise.resolve();

  private constructor(options: StoreOptions) {
    this.dataDir = options.dataDir;
    this.filePath = join(options.dataDir, options.fileName ?? FILE_NAME);
  }

  static open(options: StoreOptions): EnvironmentStore {
    const store = new EnvironmentStore(options);
    mkdirSync(store.dataDir, { recursive: true, mode: DIRECTORY_MODE });
    store.records = store.readDocument();
    return store;
  }

  /** The records as a snapshot; mutating the returned array cannot reach the store. */
  list(): EnvironmentRecord[] {
    return this.records.map(cloneRecord);
  }

  get(id: string): EnvironmentRecord | null {
    const found = this.records.find((record) => record.id === id);
    return found ? cloneRecord(found) : null;
  }

  require(id: string): EnvironmentRecord {
    const found = this.get(id);
    if (!found) throw new UnknownEnvironmentError(id);
    return found;
  }

  /**
   * Adds a computer. The same computer added twice returns the record already
   * there, so a retried add is idempotent rather than a second row.
   */
  add(draft: EnvironmentDraft, options: AddOptions = {}): Promise<EnvironmentRecord> {
    return this.mutate((records, now) => {
      assertNoSecrets(draft);
      const existing = options.allowDuplicateTarget
        ? undefined
        : records.find(
            (record) =>
              record.host.toLowerCase() === draft.host.toLowerCase() &&
              record.user === draft.user &&
              record.port === (draft.port ?? 22) &&
              record.hostKeyFingerprint === draft.hostKeyFingerprint,
          );
      if (existing) {
        if (options.id !== undefined && existing.id !== options.id) throw new DuplicateEnvironmentError(options.id);
        return { records, value: cloneRecord(existing) };
      }
      const id = options.id ?? randomUUID();
      if (records.some((record) => record.id === id)) throw new DuplicateEnvironmentError(id);
      const stamp = options.now ?? now;
      const record = normalizeRecord({
        id,
        label: draft.label,
        host: draft.host,
        port: draft.port ?? 22,
        user: draft.user,
        knownHostsFile: draft.knownHostsFile,
        hostKeyFingerprint: draft.hostKeyFingerprint,
        identityFileRef: draft.identityFileRef ?? null,
        status: "unknown",
        lastSeen: null,
        capabilities: UNKNOWN_CAPABILITIES,
        tools: [],
        createdAt: stamp,
        updatedAt: stamp,
        revision: 1,
      });
      return { records: [...records, record], value: cloneRecord(record) };
    });
  }

  /** Applies a patch at the caller's revision; a stale revision is a conflict. */
  update(id: string, expectedRevision: number, patch: RecordPatch): Promise<EnvironmentRecord> {
    return this.mutate((records, now) => {
      assertNoSecrets(patch);
      const at = records.findIndex((record) => record.id === id);
      if (at === -1) throw new UnknownEnvironmentError(id);
      const current = records[at]!;
      if (current.revision !== expectedRevision) {
        throw new EnvironmentRevisionConflictError(id, expectedRevision, current.revision);
      }
      const updated = normalizeRecord({
        ...current,
        ...definedOnly(patch),
        updatedAt: now,
        revision: current.revision + 1,
      });
      return { records: records.map((record, index) => (index === at ? updated : record)), value: cloneRecord(updated) };
    });
  }

  /** Records what a probe saw. A probe is not a caller edit, so no revision is
   * required; it still takes the file lock, so a concurrent add survives it. */
  recordProbe(id: string, snapshot: ProbeSnapshot): Promise<EnvironmentRecord> {
    return this.mutate((records, now) => {
      assertNoSecrets(snapshot);
      const at = records.findIndex((record) => record.id === id);
      if (at === -1) throw new UnknownEnvironmentError(id);
      const current = records[at]!;
      const updated = normalizeRecord({
        ...current,
        status: snapshot.status,
        capabilities: snapshot.capabilities,
        tools: snapshot.tools,
        lastSeen: snapshot.lastSeen,
        updatedAt: now,
        revision: current.revision + 1,
      });
      return { records: records.map((record, index) => (index === at ? updated : record)), value: cloneRecord(updated) };
    });
  }

  /** Removes the local record only. Nothing on the computer is touched. */
  remove(id: string, expectedRevision?: number): Promise<EnvironmentRecord> {
    return this.mutate((records) => {
      const current = records.find((record) => record.id === id);
      if (!current) throw new UnknownEnvironmentError(id);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new EnvironmentRevisionConflictError(id, expectedRevision, current.revision);
      }
      return { records: records.filter((record) => record.id !== id), value: cloneRecord(current) };
    });
  }

  /** Re-reads the file, which is how another process's write becomes visible. */
  reload(): void {
    this.records = this.readDocument();
  }

  document(): EnvironmentDocument {
    return { version: DOCUMENT_VERSION, environments: this.list() };
  }

  /**
   * One mutation, serialised in this process and across processes by a lock
   * file, always against a fresh read so no writer drops another's record.
   */
  private mutate<T>(fn: (records: EnvironmentRecord[], now: string) => { records: EnvironmentRecord[]; value: T }): Promise<T> {
    const run = async (): Promise<T> => {
      const release = await this.acquireLock();
      try {
        const records = this.readDocument();
        const next = fn(records, new Date().toISOString());
        this.writeDocument(next.records);
        this.records = next.records;
        return next.value;
      } finally {
        release();
      }
    };
    const started = this.queue.then(run, run);
    this.queue = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }

  private async acquireLock(): Promise<() => void> {
    const path = `${this.filePath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(path, "wx", FILE_MODE);
        try {
          writeSync(fd, String(process.pid), null, "utf8");
        } finally {
          closeSync(fd);
        }
        return () => rmSync(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (lockIsStale(path)) {
          rmSync(path, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new EnvironmentStoreBusyError(`another writer holds ${path}`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  private readDocument(): EnvironmentRecord[] {
    if (!existsSync(this.filePath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new EnvironmentStoreCorruptError(`cannot read ${this.filePath}`, { cause: error });
    }
    return migrate(parsed);
  }

  private writeDocument(records: readonly EnvironmentRecord[]): void {
    const text = `${JSON.stringify({ version: DOCUMENT_VERSION, environments: records }, null, 2)}\n`;
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", FILE_MODE);
    try {
      writeSync(fd, text, null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, this.filePath);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

function lockIsStale(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Reads either this shape or the bare array an earlier build wrote, and fills
 * fields a record from then does not have. An unrecognisable entry is an error
 * rather than a dropped row: a silently missing computer is worse.
 */
export function migrate(parsed: unknown): EnvironmentRecord[] {
  const entries = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.environments)
      ? parsed.environments
      : null;
  if (entries === null) throw new EnvironmentStoreCorruptError("the environments file is neither a document nor an array");
  return entries.map((entry, index) => {
    if (!isObject(entry)) throw new EnvironmentStoreCorruptError(`environment ${index} is not an object`);
    assertNoSecrets(entry);
    return normalizeRecord(entry as unknown as EnvironmentRecord);
  });
}

/** Validates and defaults one record. A missing required field is an error. */
export function normalizeRecord(input: EnvironmentRecord): EnvironmentRecord {
  assertNoSecrets(input);
  const id = requireString(input.id, "id");
  const label = requireString(input.label, "label");
  const host = requireString(input.host, "host");
  const user = requireString(input.user, "user");
  const knownHostsFile = requireString(input.knownHostsFile, "knownHostsFile");
  const hostKeyFingerprint = requireString(input.hostKeyFingerprint, "hostKeyFingerprint");
  const port = input.port === undefined ? 22 : input.port;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new InvalidEnvironmentError(`bad port ${port}`);
  const status = input.status === undefined ? "unknown" : input.status;
  if (!(ENVIRONMENT_STATUSES as readonly string[]).includes(status)) {
    throw new InvalidEnvironmentError(`bad environment status ${JSON.stringify(status)}`);
  }
  return {
    id,
    label,
    host,
    port,
    user,
    knownHostsFile,
    hostKeyFingerprint,
    identityFileRef: optionalString(input.identityFileRef),
    status,
    lastSeen: optionalString(input.lastSeen),
    capabilities: normalizeCapabilities(input.capabilities),
    tools: normalizeTools(input.tools),
    createdAt: input.createdAt ?? new Date(0).toISOString(),
    updatedAt: input.updatedAt ?? new Date(0).toISOString(),
    revision: Number.isSafeInteger(input.revision) && input.revision >= 1 ? input.revision : 1,
  };
}

function normalizeCapabilities(input: EnvironmentCapabilities | undefined): EnvironmentCapabilities {
  if (!isObject(input)) return UNKNOWN_CAPABILITIES;
  return {
    os: optionalString(input.os),
    arch: optionalString(input.arch),
    shell: optionalString(input.shell),
    homeDir: optionalString(input.homeDir),
    diskFreeBytes: Number.isFinite(input.diskFreeBytes) ? (input.diskFreeBytes as number) : null,
    nonRoot: typeof input.nonRoot === "boolean" ? input.nonRoot : null,
  };
}

function normalizeTools(input: readonly InstalledTool[] | undefined): InstalledTool[] {
  if (!Array.isArray(input)) return [];
  return input.map((tool, index) => {
    if (!isObject(tool)) throw new InvalidEnvironmentError(`tool ${index} is not an object`);
    if (!(TOOL_NAMES as readonly string[]).includes(tool.name as string)) {
      throw new InvalidEnvironmentError(`unknown tool ${JSON.stringify(tool.name)}`);
    }
    if (!(TOOL_STATUSES as readonly string[]).includes(tool.status as string)) {
      throw new InvalidEnvironmentError(`bad tool status ${JSON.stringify(tool.status)}`);
    }
    return {
      name: tool.name as InstalledTool["name"],
      status: tool.status as InstalledTool["status"],
      path: optionalString(tool.path),
      version: optionalString(tool.version),
      ...(tool.detail === undefined ? {} : { detail: String(tool.detail) }),
    };
  });
}

function cloneRecord(record: EnvironmentRecord): EnvironmentRecord {
  return {
    ...record,
    capabilities: { ...record.capabilities },
    tools: record.tools.map((tool) => ({ ...tool })),
  };
}

function definedOnly(patch: RecordPatch): Partial<EnvironmentRecord> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<EnvironmentRecord>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidEnvironmentError(`an environment record needs a non-empty ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Refuses any field whose name names a secret, at any depth. The field's value
 * is not echoed: a diagnostic that repeats a key is the leak it reports.
 */
export function assertNoSecrets(value: unknown, path = ""): void {
  const found: string[] = [];
  walk(value, path, found);
  if (found.length > 0) throw new SecretInEnvironmentError(found);
}

function walk(value: unknown, path: string, found: string[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, found));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (FORBIDDEN_FIELDS.includes(key)) found.push(here);
    walk(nested, here, found);
  }
}
