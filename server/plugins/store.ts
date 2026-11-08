import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { canTransitionPlugin, PLUGIN_STATES, type PluginState } from "../../shared/plugins/lifecycle.ts";
import { parsePluginManifest, type PluginManifest } from "../../shared/plugins/manifest.ts";
import type { PluginGrant } from "../../shared/plugins/permissions.ts";
import { manifestDigest } from "./manifest-digest.ts";

const grantSchema = z.object({
  grantId: z.string().min(1).max(120),
  installationId: z.string().min(1).max(120),
  botId: z.string().min(1).max(120),
  principalId: z.string().min(1).max(200),
  audienceId: z.string().min(1).max(200),
  permissionId: z.string().min(1).max(64),
  effect: z.enum(["read", "draft", "control", "write", "send", "delete", "financial", "security"]),
  resources: z.object({
    accounts: z.array(z.string().max(128)).max(50).optional(),
    devices: z.array(z.string().max(128)).max(50).optional(),
    memorySpaces: z.array(z.string().max(128)).max(50).optional(),
    resources: z.array(z.string().max(128)).max(50).optional(),
  }).strict(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  epoch: z.number().int().min(0),
  maxUses: z.number().int().min(0).optional(),
  uses: z.number().int().min(0),
}).strict();

const previousSchema = z.object({
  version: z.string().min(1).max(120),
  sourceId: z.string().min(1).max(200),
  manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  manifest: z.unknown(),
  packageDir: z.string().max(4_096).optional(),
}).strict();

const recordSchema = z.object({
  installationId: z.string().min(1).max(120),
  pluginId: z.string().min(1).max(100),
  version: z.string().min(1).max(120),
  sourceId: z.string().min(1).max(200),
  manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  manifest: z.unknown(),
  packageDir: z.string().max(4_096).optional(),
  previous: previousSchema.optional(),
  state: z.enum(PLUGIN_STATES),
  stateReason: z.string().max(500).optional(),
  installedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  grants: z.array(grantSchema).max(500),
}).strict();

const stateFileSchema = z.object({
  schemaVersion: z.literal(1),
  installations: z.array(recordSchema).max(500),
}).strict();

export interface PluginInstallRecord {
  installationId: string;
  pluginId: string;
  version: string;
  sourceId: string;
  manifestDigest: string;
  manifest: PluginManifest;
  /** Server-local package root; omitted from the public summary and never sent to a phone. */
  packageDir?: string;
  /** One prior version kept for rollback after an update. */
  previous?: {
    version: string;
    sourceId: string;
    manifestDigest: string;
    manifest: PluginManifest;
    packageDir?: string;
  };
  state: PluginState;
  stateReason?: string;
  installedAt: string;
  updatedAt: string;
  grants: PluginGrant[];
}

export type PluginStoreErrorCode = "corrupt" | "duplicate" | "not-found" | "invalid-transition" | "invalid-grant";

export class PluginStoreError extends Error {
  readonly code: PluginStoreErrorCode;

  constructor(code: PluginStoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PluginInstallStoreOptions {
  now?: () => string;
  installationId?: () => string;
}

export class PluginInstallStore {
  readonly dir: string;
  readonly file: string;
  private readonly now: () => string;
  private readonly newInstallationId: () => string;
  private records: PluginInstallRecord[] | null = null;

  constructor(dataDir: string, options: PluginInstallStoreOptions = {}) {
    this.dir = join(dataDir, "plugins");
    this.file = join(this.dir, "index.json");
    this.now = options.now ?? (() => new Date().toISOString());
    this.newInstallationId = options.installationId ?? (() => `plg_${randomUUID().replaceAll("-", "")}`);
  }

  list(): PluginInstallRecord[] {
    return this.load();
  }

  get(installationId: string): PluginInstallRecord | null {
    const record = this.load().find((item) => item.installationId === installationId);
    return record ? structuredClone(record) : null;
  }

  install(manifest: PluginManifest, options: { sourceId: string; installationId?: string; packageDir?: string }): PluginInstallRecord {
    if (!options.sourceId.trim()) throw new PluginStoreError("invalid-grant", "a plugin installation needs a source id");
    const records = this.load();
    if (records.some((record) => record.pluginId === manifest.pluginId)) {
      throw new PluginStoreError("duplicate", `plugin ${manifest.pluginId} is already installed`);
    }
    const now = this.now();
    const installationId = options.installationId ?? this.newInstallationId();
    if (records.some((record) => record.installationId === installationId)) {
      throw new PluginStoreError("duplicate", `installation ${installationId} already exists`);
    }
    const storedManifest = structuredClone(manifest);
    const record: PluginInstallRecord = {
      installationId,
      pluginId: storedManifest.pluginId,
      version: storedManifest.version,
      sourceId: options.sourceId,
      manifestDigest: manifestDigest(storedManifest),
      manifest: storedManifest,
      ...(options.packageDir ? { packageDir: options.packageDir } : {}),
      state: "installed-disabled",
      installedAt: now,
      updatedAt: now,
      grants: [],
    };
    records.push(record);
    this.persist(records);
    return structuredClone(record);
  }

  setState(installationId: string, state: PluginState, reason?: string): PluginInstallRecord {
    const records = this.load();
    const index = records.findIndex((record) => record.installationId === installationId);
    if (index < 0) throw new PluginStoreError("not-found", `no plugin installation ${installationId}`);
    const current = records[index]!;
    if (!canTransitionPlugin(current.state, state)) {
      throw new PluginStoreError("invalid-transition", `cannot move ${current.pluginId} from ${current.state} to ${state}`);
    }
    const next: PluginInstallRecord = {
      ...current,
      state,
      ...(reason ? { stateReason: reason.slice(0, 500) } : {}),
      updatedAt: this.now(),
      ...(state === "revoked" ? { grants: [] } : {}),
    };
    records[index] = next;
    this.persist(records);
    return structuredClone(next);
  }

  update(installationId: string, manifest: PluginManifest, options: { sourceId: string; packageDir?: string }): PluginInstallRecord {
    const records = this.load();
    const index = records.findIndex((record) => record.installationId === installationId);
    if (index < 0) throw new PluginStoreError("not-found", `no plugin installation ${installationId}`);
    const current = records[index]!;
    if (current.state === "revoked") throw new PluginStoreError("invalid-transition", "a revoked plugin cannot be updated");
    if (current.pluginId !== manifest.pluginId) throw new PluginStoreError("invalid-grant", "an update cannot change the plugin id");
    const storedManifest = structuredClone(manifest);
    const next: PluginInstallRecord = {
      ...current,
      version: storedManifest.version,
      sourceId: options.sourceId,
      manifestDigest: manifestDigest(storedManifest),
      manifest: storedManifest,
      ...(options.packageDir ? { packageDir: options.packageDir } : {}),
      previous: {
        version: current.version,
        sourceId: current.sourceId,
        manifestDigest: current.manifestDigest,
        manifest: current.manifest,
        ...(current.packageDir ? { packageDir: current.packageDir } : {}),
      },
      state: "installed-disabled",
      updatedAt: this.now(),
      grants: [],
    };
    delete next.stateReason;
    records[index] = next;
    this.persist(records);
    return structuredClone(next);
  }

  rollback(installationId: string): PluginInstallRecord {
    const records = this.load();
    const index = records.findIndex((record) => record.installationId === installationId);
    if (index < 0) throw new PluginStoreError("not-found", `no plugin installation ${installationId}`);
    const current = records[index]!;
    if (!current.previous) throw new PluginStoreError("invalid-transition", "this plugin has no previous version to restore");
    if (current.state === "revoked") throw new PluginStoreError("invalid-transition", "a revoked plugin cannot be rolled back");
    const previous = current.previous;
    const next: PluginInstallRecord = {
      ...current,
      version: previous.version,
      sourceId: previous.sourceId,
      manifestDigest: previous.manifestDigest,
      manifest: previous.manifest,
      ...(previous.packageDir ? { packageDir: previous.packageDir } : {}),
      state: "installed-disabled",
      updatedAt: this.now(),
      grants: [],
    };
    delete next.previous;
    delete next.stateReason;
    records[index] = next;
    this.persist(records);
    return structuredClone(next);
  }

  addGrant(installationId: string, grant: PluginGrant): PluginInstallRecord {
    const records = this.load();
    const index = records.findIndex((record) => record.installationId === installationId);
    if (index < 0) throw new PluginStoreError("not-found", `no plugin installation ${installationId}`);
    const record = records[index]!;
    if (record.state === "revoked") throw new PluginStoreError("invalid-grant", "a revoked plugin cannot receive grants");
    if (grant.installationId !== installationId) throw new PluginStoreError("invalid-grant", "the grant installation does not match");
    const permission = record.manifest.permissions.find((item) => item.id === grant.permissionId);
    if (!permission) throw new PluginStoreError("invalid-grant", "the grant names an unknown permission");
    if (permission.effect !== grant.effect) throw new PluginStoreError("invalid-grant", "the grant effect does not match the permission");
    if (record.grants.some((item) => item.grantId === grant.grantId)) throw new PluginStoreError("invalid-grant", "duplicate grant id");
    if (grant.uses < 0 || (grant.maxUses !== undefined && grant.uses > grant.maxUses)) {
      throw new PluginStoreError("invalid-grant", "the grant use count is out of range");
    }
    const next: PluginInstallRecord = {
      ...record,
      grants: [...record.grants, structuredClone(grant)],
      updatedAt: this.now(),
    };
    records[index] = next;
    this.persist(records);
    return structuredClone(next);
  }

  consumeGrant(installationId: string, grantId: string): PluginInstallRecord {
    const records = this.load();
    const index = records.findIndex((record) => record.installationId === installationId);
    if (index < 0) throw new PluginStoreError("not-found", `no plugin installation ${installationId}`);
    const record = records[index]!;
    const grantIndex = record.grants.findIndex((grant) => grant.grantId === grantId);
    if (grantIndex < 0) throw new PluginStoreError("not-found", `no grant ${grantId}`);
    const grant = record.grants[grantIndex]!;
    if (grant.maxUses !== undefined && grant.uses >= grant.maxUses) {
      throw new PluginStoreError("invalid-grant", "the grant has no uses left");
    }
    const grants = [...record.grants];
    grants[grantIndex] = { ...grant, uses: grant.uses + 1 };
    const next: PluginInstallRecord = { ...record, grants, updatedAt: this.now() };
    records[index] = next;
    this.persist(records);
    return structuredClone(next);
  }

  removeGrant(installationId: string, grantId: string): PluginInstallRecord {
    const records = this.load();
    const index = records.findIndex((record) => record.installationId === installationId);
    if (index < 0) throw new PluginStoreError("not-found", `no plugin installation ${installationId}`);
    const record = records[index]!;
    const grants = record.grants.filter((grant) => grant.grantId !== grantId);
    if (grants.length === record.grants.length) throw new PluginStoreError("not-found", `no grant ${grantId}`);
    const next: PluginInstallRecord = { ...record, grants, updatedAt: this.now() };
    records[index] = next;
    this.persist(records);
    return structuredClone(next);
  }

  remove(installationId: string): PluginInstallRecord {
    const records = this.load();
    const index = records.findIndex((record) => record.installationId === installationId);
    if (index < 0) throw new PluginStoreError("not-found", `no plugin installation ${installationId}`);
    const [removed] = records.splice(index, 1);
    this.persist(records);
    return structuredClone(removed!);
  }

  private load(): PluginInstallRecord[] {
    if (this.records) return this.records.map((record) => structuredClone(record));
    if (!existsSync(this.file)) {
      this.records = [];
      return [];
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new PluginStoreError("corrupt", "plugins/index.json is not valid JSON");
    }
    const parsed = stateFileSchema.safeParse(raw);
    if (!parsed.success) throw new PluginStoreError("corrupt", "plugins/index.json does not match schema version 1");
    const records: PluginInstallRecord[] = [];
    const pluginIds = new Set<string>();
    const installationIds = new Set<string>();
    for (const item of parsed.data.installations) {
      const manifest = parsePluginManifest(item.manifest);
      if (!manifest.ok) throw new PluginStoreError("corrupt", `plugin ${item.pluginId} has an invalid manifest`);
      if (manifest.manifest.pluginId !== item.pluginId || manifest.manifest.version !== item.version) {
        throw new PluginStoreError("corrupt", `plugin ${item.pluginId} does not match its manifest identity`);
      }
      if (manifestDigest(manifest.manifest) !== item.manifestDigest) {
        throw new PluginStoreError("corrupt", `plugin ${item.pluginId} does not match its recorded digest`);
      }
      let previous: PluginInstallRecord["previous"];
      if (item.previous) {
        const parsed = parsePluginManifest(item.previous.manifest);
        if (!parsed.ok || parsed.manifest.pluginId !== item.pluginId || parsed.manifest.version !== item.previous.version
          || manifestDigest(parsed.manifest) !== item.previous.manifestDigest) {
          throw new PluginStoreError("corrupt", `plugin ${item.pluginId} has an invalid rollback record`);
        }
        previous = { ...item.previous, manifest: parsed.manifest };
      }
      if (pluginIds.has(item.pluginId) || installationIds.has(item.installationId)) {
        throw new PluginStoreError("corrupt", "plugins/index.json contains duplicate identities");
      }
      pluginIds.add(item.pluginId);
      installationIds.add(item.installationId);
      const { previous: _storedPrevious, ...withoutPrevious } = item;
      records.push({ ...withoutPrevious, manifest: manifest.manifest, ...(previous ? { previous } : {}) });
    }
    this.records = records;
    return records.map((record) => structuredClone(record));
  }

  private persist(records: PluginInstallRecord[]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const data = JSON.stringify({ schemaVersion: 1, installations: records }, null, 2) + "\n";
    writeFileAtomic(this.file, data, { mode: 0o600 });
    this.records = records;
  }
}
