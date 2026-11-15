/**
 * The user's own SSH computers, as the HTTP layer exposes them.
 *
 * Two implementations share one contract. `EnvironmentStorePort` is the real
 * one: it pins a host key through `firstContact`, probes the machine, and
 * persists through the environment layer's durable store, so a restart reads
 * back what was observed. `InMemoryEnvironmentStore` is the composition's
 * stand-in when no data directory is configured.
 *
 * A create carries connection facts only. Neither implementation has a field
 * for a password or a private key, and neither reports one: the known-hosts
 * file is this application's own pin file, and a record's credential reference
 * stays inside the environment layer.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import type { EnvironmentRef } from "../../packages/agent-protocol/environment.ts";
import { assertEnvironmentRef } from "../../packages/agent-protocol/guards.ts";
import { verifyEnvironment } from "../environments/connect.ts";
import { UnknownEnvironmentError } from "../environments/errors.ts";
import { firstContact } from "../environments/first-contact.ts";
import type { SshRunner } from "../environments/ssh.ts";
import type { EnvironmentStore } from "../environments/store.ts";
import type { EnvironmentRecord, EnvironmentStatus } from "../environments/types.ts";
import type { EnvironmentPort, EnvironmentSummary, EnvironmentTest, NewEnvironment } from "../http/ports.ts";

const KNOWN_HOSTS_DIR = "known-hosts";
const DEFAULT_PORT = 22;

export interface InMemoryEnvironmentStoreOptions {
  readonly now: () => string;
  readonly id?: () => string;
  readonly seed?: readonly EnvironmentRef[];
  /** The transport behind a check. Without one, a check reports that nothing
   * opened a connection rather than claiming the computer is reachable. */
  readonly probe?: (environment: EnvironmentSummary) => Promise<{ reachable: boolean; latencyMs?: number; detail?: string }>;
}

/** Environments held in memory: persistence belongs to `EnvironmentStorePort`,
 * and this class must not become a second place that holds one. */
export class InMemoryEnvironmentStore implements EnvironmentPort {
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #probe: ((environment: EnvironmentSummary) => Promise<{ reachable: boolean; latencyMs?: number; detail?: string }>) | undefined;
  readonly #byId = new Map<string, EnvironmentSummary>();
  readonly #tests = new Map<string, EnvironmentTest>();

  constructor(options: InMemoryEnvironmentStoreOptions) {
    this.#now = options.now;
    this.#newId = options.id ?? randomUUID;
    this.#probe = options.probe;
    for (const environment of options.seed ?? []) this.#byId.set(environment.id, seeded(environment));
  }

  list(): EnvironmentSummary[] {
    return [...this.#byId.values()];
  }

  get(id: string): EnvironmentSummary | undefined {
    return this.#byId.get(id);
  }

  async create(input: NewEnvironment): Promise<EnvironmentSummary> {
    const environment: EnvironmentSummary = {
      id: this.#newId(),
      label: input.label,
      host: input.host,
      port: input.port ?? DEFAULT_PORT,
      user: input.user,
      hostKeyFingerprint: input.hostKeyFingerprint,
      status: "unknown",
    };
    this.#byId.set(environment.id, environment);
    return environment;
  }

  async check(id: string): Promise<EnvironmentTest> {
    const environment = this.#byId.get(id);
    if (!environment) throw new UnknownEnvironmentError(id);
    const checkedAt = this.#now();
    const outcome = this.#probe
      ? await this.#probe(environment)
      : { reachable: false, detail: "no transport is configured for this environment" };
    const result: EnvironmentTest = {
      reachable: outcome.reachable,
      checkedAt,
      ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    };
    this.#tests.set(id, result);
    return result;
  }

  lastTest(id: string): EnvironmentTest | undefined {
    return this.#tests.get(id);
  }

  async remove(id: string): Promise<void> {
    this.#byId.delete(id);
    this.#tests.delete(id);
  }
}

export interface EnvironmentStorePortOptions {
  readonly store: EnvironmentStore;
  readonly runner: SshRunner;
  readonly now?: () => string;
  readonly id?: () => string;
  readonly readKnownHosts?: (path: string) => string | null;
  readonly writeKnownHosts?: (path: string, text: string) => void;
}

/**
 * The real port: one durable store, one ssh runner, and a known-hosts file per
 * computer under `known-hosts/` in the store's data directory.
 *
 * A create generates the record's id first, because the pin file is named for
 * it. The pin is resolved by `firstContact` (a fingerprint the person supplied
 * is the only thing that pins a key), the record is written, and only then is
 * the machine probed: a probe that fails leaves the record with the status that
 * failure earned and the error is thrown, so nothing is ever reported online
 * on the strength of an attempt.
 *
 * `lastTest` lives in memory, and so does the observation a status reports. A
 * restart therefore lists every computer as `unknown` with no test, and only
 * its `lastSeen` says when it was last observed: a status a previous process
 * wrote is not a claim this process can make.
 */
export class EnvironmentStorePort implements EnvironmentPort {
  readonly #store: EnvironmentStore;
  readonly #runner: SshRunner;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #readKnownHosts: (path: string) => string | null;
  readonly #writeKnownHosts: (path: string, text: string) => void;
  readonly #tests = new Map<string, EnvironmentTest>();

  constructor(options: EnvironmentStorePortOptions) {
    this.#store = options.store;
    this.#runner = options.runner;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.id ?? randomUUID;
    this.#readKnownHosts = options.readKnownHosts ?? readKnownHostsFile;
    this.#writeKnownHosts = options.writeKnownHosts ?? writeKnownHostsFile;
  }

  list(): EnvironmentSummary[] {
    return this.#store.list().map((record) => this.#summary(record));
  }

  get(id: string): EnvironmentSummary | undefined {
    const record = this.#store.get(id);
    return record === null ? undefined : this.#summary(record);
  }

  async create(input: NewEnvironment): Promise<EnvironmentSummary> {
    const port = input.port ?? DEFAULT_PORT;
    const id = this.#newId();
    const knownHostsFile = join(this.#store.dataDir, KNOWN_HOSTS_DIR, id);
    const fingerprint = input.hostKeyFingerprint.trim();
    let record: EnvironmentRecord;
    try {
      const contact = await firstContact(
        { host: input.host, port, user: input.user },
        {
          runner: this.#runner,
          fingerprint: fingerprint === "" ? null : fingerprint,
          knownHostsFile,
          readKnownHosts: this.#readKnownHosts,
          writeKnownHosts: this.#writeKnownHosts,
        },
      );
      record = await this.#store.add(
        {
          label: input.label,
          host: input.host,
          port,
          user: input.user,
          knownHostsFile,
          hostKeyFingerprint: contact.fingerprint,
        },
        { id, now: this.#now() },
      );
    } catch (error) {
      rmSync(knownHostsFile, { force: true });
      throw error;
    }
    const started = Date.now();
    const result = await verifyEnvironment(this.#store, record, {
      runner: this.#runner,
      readKnownHosts: this.#readKnownHosts,
      now: this.#now,
    }).catch((error: unknown) => {
      this.#tests.set(id, { reachable: false, latencyMs: Date.now() - started, checkedAt: this.#now(), detail: messageOf(error) });
      throw error;
    });
    const os = result.capabilities.os;
    this.#tests.set(id, {
      reachable: true,
      latencyMs: Date.now() - started,
      checkedAt: this.#now(),
      detail: os === null ? "the host key matched and the machine answered" : `the host key matched and ${os} answered`,
    });
    return summaryOf(result.record, result.status);
  }

  async check(id: string): Promise<EnvironmentTest> {
    const record = this.#store.get(id);
    if (record === null) throw new UnknownEnvironmentError(id);
    const checkedAt = this.#now();
    const started = Date.now();
    let test: EnvironmentTest;
    try {
      const result = await verifyEnvironment(this.#store, record, {
        runner: this.#runner,
        readKnownHosts: this.#readKnownHosts,
        now: this.#now,
      });
      const os = result.capabilities.os;
      test = {
        reachable: true,
        latencyMs: Date.now() - started,
        checkedAt,
        detail: os === null ? "the host key matched and the machine answered" : `the host key matched and ${os} answered`,
      };
    } catch (error) {
      test = { reachable: false, checkedAt, detail: messageOf(error) };
    }
    this.#tests.set(id, test);
    return test;
  }

  lastTest(id: string): EnvironmentTest | undefined {
    return this.#tests.get(id);
  }

  /** Drops this application's record and the pin file it wrote for it. Both are
   * local: nothing on the computer is touched, and no connection is opened,
   * because that data is the person's and a delete cannot be undone. */
  async remove(id: string): Promise<void> {
    const record = this.#store.require(id);
    await this.#store.remove(id);
    rmSync(record.knownHostsFile, { force: true });
    this.#tests.delete(id);
  }

  /** The status this process can stand behind. A record it has not observed
   * reports `unknown`, whatever a previous process persisted, so a restart
   * never claims a connection it did not make. */
  #summary(record: EnvironmentRecord): EnvironmentSummary {
    return summaryOf(record, this.#tests.has(record.id) ? record.status : "unknown");
  }
}

/** The wire-facing fields of a record. A credential reference and the
 * known-hosts path are deliberately absent: neither belongs in a response. */
function summaryOf(record: EnvironmentRecord, status: EnvironmentStatus): EnvironmentSummary {
  return {
    id: record.id,
    label: record.label,
    host: record.host,
    port: record.port,
    user: record.user,
    hostKeyFingerprint: record.hostKeyFingerprint,
    status,
    ...(record.lastSeen === null ? {} : { lastSeen: record.lastSeen }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
  };
}

/** A configured computer, as a composition seed. A local environment has no
 * host, which the empty string states rather than a fabricated address. */
function seeded(environment: EnvironmentRef): EnvironmentSummary {
  assertEnvironmentRef(environment);
  return {
    id: environment.id,
    label: environment.label,
    host: environment.host ?? "",
    port: environment.port ?? DEFAULT_PORT,
    user: environment.user ?? "",
    ...(environment.hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint: environment.hostKeyFingerprint }),
    status: "unknown",
  };
}

function readKnownHostsFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Replaced into place, 0600, so a crash leaves the old pin file or the new one
 * and never a half-written pin. */
function writeKnownHostsFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
