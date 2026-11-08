import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { catalogEntryKey, type CatalogEntry, type CatalogPayload, type PluginTrustTier } from "../../shared/plugins/catalog.ts";
import { catalogRevocation } from "./catalog.ts";
import { compareSemVer, parseSemVer } from "../../shared/plugins/semver.ts";
import { downloadPluginArtifact } from "./artifact.ts";
import { fetchCatalog } from "./catalog-source.ts";
import { PluginChannelStore, PluginChannelError } from "./channel-store.ts";
import { readLocalPluginPackage } from "./local-install.ts";
import { manifestDigest } from "./manifest-digest.ts";
import { PluginRegistryError, type PluginRegistry, type PluginSummary } from "./registry.ts";
import type { PluginInstallRecord } from "./store.ts";

export type MarketErrorCode =
  | "channel"
  | "not-found"
  | "revoked"
  | "artifact-missing"
  | "platform-unsupported"
  | "download"
  | "identity"
  | "version";

export class MarketError extends Error {
  readonly code: MarketErrorCode;
  readonly status: number;
  constructor(code: MarketErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = code === "not-found" || code === "artifact-missing" || code === "platform-unsupported" ? 404 : code === "download" ? 502 : 409;
  }
}

export interface MarketEntry extends CatalogEntry {
  sourceId: string;
  trust: PluginTrustTier;
  revoked: ReturnType<typeof catalogRevocation>;
  installed: { installationId: string; version: string; state: PluginInstallRecord["state"] } | null;
}

export interface MarketInstallRequest {
  sourceId: string;
  pluginId: string;
  version: string;
  platform?: string;
}

export interface PluginMarketOptions {
  dataDir: string;
  registry: PluginRegistry;
  channels: PluginChannelStore;
  platform: string;
  now?: () => Date;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export class PluginMarketService {
  private readonly options: PluginMarketOptions;
  private readonly cache = new Map<string, CatalogPayload>();

  constructor(options: PluginMarketOptions) {
    this.options = options;
  }

  async refresh(sourceId: string): Promise<{ ok: true; payload: CatalogPayload } | { ok: false; code: string; error: string }> {
    const channel = this.options.channels.get(sourceId);
    if (!channel || !channel.enabled) return { ok: false, code: "channel", error: `channel ${sourceId} is not enabled` };
    const result = await fetchCatalog(channel.url, {
      keys: { [channel.keyId]: { publicKey: channel.publicKeyPem, trust: channel.trust } },
      now: (this.options.now ?? (() => new Date()))(),
      minimumSequence: channel.sequence,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    if (!result.ok) {
      try { this.options.channels.failed(sourceId, result.error); } catch { /* the channel may have been removed meanwhile */ }
      return { ok: false, code: result.code, error: result.error };
    }
    this.cache.set(sourceId, result.payload);
    this.options.channels.accepted(sourceId, result.payload.sequence);
    return { ok: true, payload: result.payload };
  }

  async refreshAll(): Promise<Array<{ sourceId: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const channel of this.options.channels.list()) {
      if (!channel.enabled) continue;
      const result = await this.refresh(channel.sourceId);
      results.push({ sourceId: channel.sourceId, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
    }
    return results;
  }

  catalog(): MarketEntry[] {
    const installed = new Map(this.options.registry.store.list().map((record) => [record.pluginId, record]));
    const entries: MarketEntry[] = [];
    for (const channel of this.options.channels.list()) {
      if (!channel.enabled) continue;
      const payload = this.cache.get(channel.sourceId);
      if (!payload) continue;
      for (const entry of payload.entries) {
        const record = installed.get(entry.pluginId) ?? null;
        entries.push({
          ...entry,
          sourceId: channel.sourceId,
          trust: channel.trust,
          revoked: catalogRevocation(payload, entry),
          installed: record ? { installationId: record.installationId, version: record.version, state: record.state } : null,
        });
      }
    }
    return entries.sort((left, right) => catalogEntryKey(left).localeCompare(catalogEntryKey(right)));
  }

  async install(request: MarketInstallRequest): Promise<PluginSummary> {
    const payload = await this.ensure(request.sourceId);
    const entry = this.entry(payload, request.pluginId, request.version);
    this.assertNotRevoked(payload, entry);
    const artifact = this.artifact(entry, request.platform ?? this.options.platform);
    const packageDir = this.packageDir(entry, artifact.sha256);
    try {
      await downloadPluginArtifact(artifact.url, artifact.sha256, packageDir, this.options.fetch ? { fetch: this.options.fetch } : {});
      const local = readLocalPluginPackage(packageDir);
      this.assertIdentity(entry, local.manifest.pluginId, local.manifest.version, manifestDigest(local.manifest));
      return this.options.registry.install(local.manifest, request.sourceId, { packageDir });
    } catch (error) {
      rmSync(packageDir, { recursive: true, force: true });
      if (error instanceof MarketError || error instanceof PluginRegistryError) throw error;
      if (error instanceof Error && "code" in error) throw new MarketError("download", error.message);
      throw error;
    }
  }

  async update(installationId: string, options: { version?: string; platform?: string } = {}): Promise<PluginSummary> {
    const record = this.options.registry.store.get(installationId);
    if (!record) throw new MarketError("not-found", `no plugin installation ${installationId}`);
    const payload = await this.ensure(record.sourceId);
    const version = options.version ?? this.latestVersion(payload, record.pluginId);
    if (!version) throw new MarketError("not-found", `no update is published for ${record.pluginId}`);
    const current = parseSemVer(record.version);
    const next = parseSemVer(version);
    if (!current || !next || compareSemVer(next, current) <= 0) throw new MarketError("version", "the selected version is not newer than the installed one");
    const entry = this.entry(payload, record.pluginId, version);
    this.assertNotRevoked(payload, entry);
    const artifact = this.artifact(entry, options.platform ?? this.options.platform);
    const packageDir = this.packageDir(entry, artifact.sha256);
    try {
      await downloadPluginArtifact(artifact.url, artifact.sha256, packageDir, this.options.fetch ? { fetch: this.options.fetch } : {});
      const local = readLocalPluginPackage(packageDir);
      this.assertIdentity(entry, local.manifest.pluginId, local.manifest.version, manifestDigest(local.manifest));
      return await this.options.registry.update(installationId, local.manifest, { sourceId: record.sourceId, packageDir });
    } catch (error) {
      rmSync(packageDir, { recursive: true, force: true });
      if (error instanceof MarketError || error instanceof PluginRegistryError) throw error;
      if (error instanceof Error && "code" in error) throw new MarketError("download", error.message);
      throw error;
    }
  }

  async rollback(installationId: string): Promise<PluginSummary> {
    return this.options.registry.rollback(installationId);
  }

  private async ensure(sourceId: string): Promise<CatalogPayload> {
    const cached = this.cache.get(sourceId);
    if (cached) return cached;
    const refreshed = await this.refresh(sourceId);
    if (!refreshed.ok) throw new MarketError("channel", refreshed.error);
    return refreshed.payload;
  }

  private entry(payload: CatalogPayload, pluginId: string, version: string): CatalogEntry {
    const entry = payload.entries.find((candidate) => candidate.pluginId === pluginId && candidate.version === version);
    if (!entry) throw new MarketError("not-found", `${pluginId}@${version} is not in this channel`);
    return entry;
  }

  private assertNotRevoked(payload: CatalogPayload, entry: CatalogEntry): void {
    const revocation = catalogRevocation(payload, entry);
    if (revocation) throw new MarketError("revoked", `${catalogEntryKey(entry)} was revoked: ${revocation.reason}`);
  }

  private artifact(entry: CatalogEntry, platform: string): CatalogEntry["artifacts"][number] {
    const artifact = entry.artifacts.find((candidate) => candidate.platform === platform);
    if (!artifact) throw new MarketError("platform-unsupported", `${catalogEntryKey(entry)} has no artifact for ${platform}`);
    return artifact;
  }

  private packageDir(entry: CatalogEntry, sha256: string): string {
    return join(this.options.dataDir, "plugins", "packages", `${entry.pluginId}-${entry.version}-${sha256.slice(0, 12)}-${randomUUID().slice(0, 8)}`);
  }

  private latestVersion(payload: CatalogPayload, pluginId: string): string | null {
    const versions = payload.entries.filter((entry) => entry.pluginId === pluginId).map((entry) => entry.version)
      .map((version) => ({ version, parsed: parseSemVer(version) })).filter((item) => item.parsed !== null)
      .sort((left, right) => compareSemVer(right.parsed!, left.parsed!));
    return versions[0]?.version ?? null;
  }

  private assertIdentity(entry: CatalogEntry, pluginId: string, version: string, digest: string): void {
    if (entry.pluginId !== pluginId || entry.version !== version || entry.manifestDigest !== digest) {
      throw new MarketError("identity", "the downloaded manifest does not match its catalog entry");
    }
  }
}

export { PluginChannelError };
