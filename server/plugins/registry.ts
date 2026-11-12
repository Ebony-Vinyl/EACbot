import { satisfiesSemVer } from "../../shared/plugins/semver.ts";
import type { PluginEffect, PluginManifest } from "../../shared/plugins/manifest.ts";
import { randomUUID } from "node:crypto";
import { authorizePluginCall, type PluginAuthorization, type PluginCallRequest, type PluginGrant, type PluginGrantResources, type PluginInstallSnapshot } from "../../shared/plugins/permissions.ts";
import { parseActionResult, type ActionResult } from "../../shared/plugins/rpc.ts";
import { PluginInstallStore, PluginStoreError, type PluginInstallRecord } from "./store.ts";
import type { PluginRuntime } from "./supervisor.ts";

const HOST_SERVICES: Readonly<Record<string, string>> = {
  "host.capabilities": "1.0.0",
  "host.media": "1.0.0",
  "host.models": "1.0.0",
  "host.memory": "1.0.0",
  "host.tasks": "1.0.0",
  "host.ui": "1.0.0",
};

export type PluginRegistryErrorCode =
  | "not-found"
  | "incompatible"
  | "conflict"
  | "dependency"
  | "runtime-unavailable"
  | "invalid-state";

export class PluginRegistryError extends Error {
  readonly code: PluginRegistryErrorCode;

  constructor(code: PluginRegistryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PluginRegistryOptions {
  hostVersion: string;
  host: "server" | "desktop" | "web";
  platform: string;
  /** Declarative plugins activate without a process. A process plugin needs an explicit runtime opt-in. */
  runtime?: PluginRuntime;
}

export interface PluginActivationResult {
  ok: boolean;
  record: PluginInstallRecord;
  code?: "dependency" | "runtime-unavailable" | "runtime-failed";
  error?: string;
}

export interface PluginSummary {
  installationId: string;
  pluginId: string;
  version: string;
  sourceId: string;
  state: PluginInstallRecord["state"];
  stateReason?: string;
  updatedAt: string;
  runtime: { mode: "declarative" | "process" | "external"; isolation: "required" | "preferred" | "none" | null; enforced: boolean };
  permissions: Array<{ id: string; capability: string; effect: string; reason: string }>;
  provides: Record<string, string>;
  requires: Record<string, string>;
  /** True when the plugin declares values a person fills in its work directory. */
  configurable: boolean;
}

function runtimeSummary(runtime: PluginManifest["runtime"]): PluginSummary["runtime"] {
  if (runtime.mode === "declarative") return { mode: runtime.mode, isolation: null, enforced: true };
  return { mode: runtime.mode, isolation: runtime.isolation, enforced: false };
}

function summary(record: PluginInstallRecord): PluginSummary {
  return {
    installationId: record.installationId,
    pluginId: record.pluginId,
    version: record.version,
    sourceId: record.sourceId,
    state: record.state,
    ...(record.stateReason ? { stateReason: record.stateReason } : {}),
    updatedAt: record.updatedAt,
    runtime: runtimeSummary(record.manifest.runtime),
    permissions: record.manifest.permissions.map(({ id, capability, effect, reason }) => ({ id, capability, effect, reason })),
    provides: record.manifest.provides ?? {},
    requires: record.manifest.requires ?? {},
    configurable: typeof record.manifest.configSchema === "string",
  };
}

function dependencyCycle(records: readonly PluginInstallRecord[], candidate: PluginManifest): boolean {
  const manifests = new Map<string, PluginManifest>(records.filter((record) => record.state !== "revoked").map((record) => [record.pluginId, record.manifest]));
  manifests.set(candidate.pluginId, candidate);
  const provider = new Map<string, string>();
  for (const [pluginId, manifest] of manifests) {
    for (const service of Object.keys(manifest.provides ?? {})) provider.set(service, pluginId);
  }
  const graph = new Map<string, string[]>();
  for (const [pluginId, manifest] of manifests) {
    graph.set(pluginId, Object.keys(manifest.requires ?? {}).flatMap((service) => {
      const owner = provider.get(service);
      return owner ? [owner] : [];
    }));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (pluginId: string): boolean => {
    if (visiting.has(pluginId)) return true;
    if (visited.has(pluginId)) return false;
    visiting.add(pluginId);
    for (const dependency of graph.get(pluginId) ?? []) if (visit(dependency)) return true;
    visiting.delete(pluginId);
    visited.add(pluginId);
    return false;
  };
  return [...graph.keys()].some(visit);
}

export class PluginRegistry {
  readonly store: PluginInstallStore;
  private readonly options: PluginRegistryOptions;
  private readonly lifecycle = new Map<string, Promise<unknown>>();

  constructor(store: PluginInstallStore, options: PluginRegistryOptions) {
    this.store = store;
    this.options = options;
  }

  /** The supervisor, for host-side methods that are not tool calls: configuration and live status. */
  get runtime(): PluginRuntime | undefined {
    return this.options.runtime;
  }

  private serial<T>(installationId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.lifecycle.get(installationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const tracked = next.finally(() => {
      if (this.lifecycle.get(installationId) === tracked) this.lifecycle.delete(installationId);
    });
    this.lifecycle.set(installationId, tracked.catch(() => undefined));
    return next;
  }

  list(): PluginSummary[] {
    return this.store.list().map(summary);
  }

  /** An unexpected child exit leaves the persisted installation active; this closes that state drift. */
  markRuntimeFailure(installationId: string, reason: string): void {
    void this.serial(installationId, async () => {
      const record = this.store.get(installationId);
      if (!record) return;
      if (record.state === "active" || record.state === "starting") this.store.setState(installationId, "failed", reason);
    }).catch(() => undefined);
  }

  /** A process active before a restart has no live child; restart it, or make the missing runtime visible. */
  async reconcile(): Promise<void> {
    for (const record of this.store.list()) {
      if (record.state !== "active" || record.manifest.runtime.mode === "declarative") continue;
      await this.serial(record.installationId, async () => {
        const current = this.require(record.installationId);
        if (current.state !== "active") return;
        const currentRuntime = current.manifest.runtime;
        if (currentRuntime.mode === "declarative") return;
        if (!this.options.runtime || currentRuntime.isolation === "required") {
          this.store.setState(record.installationId, "failed", "the plugin runtime is unavailable after a restart");
          return;
        }
        this.store.setState(record.installationId, "stopping");
        this.store.setState(record.installationId, "disabled");
        const starting = this.store.setState(record.installationId, "starting");
        try {
          const started = await this.options.runtime.start(starting);
          if (started.ok) this.store.setState(record.installationId, "active");
          else this.store.setState(record.installationId, "failed", started.error);
        } catch {
          this.store.setState(record.installationId, "failed", "the plugin runtime could not restart");
        }
      });
    }
  }

  get(installationId: string): PluginSummary | null {
    const record = this.store.get(installationId);
    return record ? summary(record) : null;
  }

  install(manifest: PluginManifest, sourceId: string, options: { packageDir?: string } = {}): PluginSummary {
    this.assertCompatible(manifest);
    if (manifest.permissions.some((permission) => (permission.scope.paths?.length ?? 0) > 0 || (permission.scope.domains?.length ?? 0) > 0)) {
      throw new PluginRegistryError("incompatible", "path and domain scopes are not enforced in this host yet");
    }
    const records = this.store.list();
    for (const service of Object.keys(manifest.provides ?? {})) {
      if (HOST_SERVICES[service]) throw new PluginRegistryError("conflict", `${service} is provided by the host`);
      const existing = records.find((record) => record.state !== "revoked" && record.manifest.provides?.[service] !== undefined);
      if (existing) throw new PluginRegistryError("conflict", `${service} is already provided by ${existing.pluginId}`);
    }
    if (dependencyCycle(records, manifest)) throw new PluginRegistryError("dependency", "the plugin dependency graph would contain a cycle");
    try {
      return summary(this.store.install(manifest, { sourceId, ...(options.packageDir ? { packageDir: options.packageDir } : {}) }));
    } catch (error) {
      if (error instanceof PluginStoreError) throw new PluginRegistryError(error.code === "duplicate" ? "conflict" : "invalid-state", error.message);
      throw error;
    }
  }

  activate(installationId: string): Promise<PluginActivationResult> {
    return this.serial(installationId, () => this.activateLocked(installationId));
  }

  private async activateLocked(installationId: string): Promise<PluginActivationResult> {
    const record = this.require(installationId);
    if (record.state === "active") {
      if (record.manifest.runtime.mode !== "declarative" && this.options.runtime?.isRunning && !this.options.runtime.isRunning(installationId)) {
        const reason = "the plugin runtime is not running";
        return { ok: false, record: this.store.setState(installationId, "failed", reason), code: "runtime-failed", error: reason };
      }
      return { ok: true, record };
    }
    if (record.state === "revoked") throw new PluginRegistryError("invalid-state", "a revoked plugin cannot be activated");
    const starting = record.state === "starting" ? record : this.store.setState(installationId, "starting");
    const dependencyError = this.missingDependency(starting);
    if (dependencyError) {
      const blocked = this.store.setState(installationId, "blocked", dependencyError);
      return { ok: false, record: blocked, code: "dependency", error: dependencyError };
    }
    const runtime = starting.manifest.runtime;
    if (runtime.mode !== "declarative") {
      if (runtime.isolation === "required") {
        const reason = "required OS isolation is not available in this host";
        return { ok: false, record: this.store.setState(installationId, "blocked", reason), code: "runtime-unavailable", error: reason };
      }
      if (runtime.mode === "external") {
        const reason = "external plugin runtimes are not implemented in this host";
        return { ok: false, record: this.store.setState(installationId, "blocked", reason), code: "runtime-unavailable", error: reason };
      }
      if (!this.options.runtime) {
        const reason = "this build has no opt-in plugin runtime for process plugins";
        return { ok: false, record: this.store.setState(installationId, "blocked", reason), code: "runtime-unavailable", error: reason };
      }
      const started = await this.options.runtime.start(starting);
      if (!started.ok) {
        return { ok: false, record: this.store.setState(installationId, "blocked", started.error), code: "runtime-failed", error: started.error };
      }
    }
    return { ok: true, record: this.store.setState(installationId, "active") };
  }

  deactivate(installationId: string): Promise<PluginSummary> {
    return this.serial(installationId, () => this.deactivateLocked(installationId));
  }

  private async deactivateLocked(installationId: string): Promise<PluginSummary> {
    const record = this.require(installationId);
    if (record.state === "revoked") return summary(record);
    if (record.state === "active" || record.state === "starting") this.store.setState(installationId, "stopping");
    const current = this.require(installationId);
    if (current.state === "stopping") {
      if (current.manifest.runtime.mode !== "declarative" && this.options.runtime) {
        try {
          await this.options.runtime.stop(current);
        } catch {
          return summary(this.store.setState(installationId, "failed", "the plugin runtime did not stop cleanly"));
        }
      }
      return summary(this.store.setState(installationId, "disabled"));
    }
    if (current.state === "installed-disabled" || current.state === "blocked" || current.state === "failed") {
      return summary(this.store.setState(installationId, "disabled"));
    }
    return summary(current);
  }

  revoke(installationId: string, reason: string): Promise<PluginSummary> {
    return this.serial(installationId, () => this.revokeLocked(installationId, reason));
  }

  private async revokeLocked(installationId: string, reason: string): Promise<PluginSummary> {
    const record = this.require(installationId);
    if (record.state === "revoked") return summary(record);
    if (record.state === "active" || record.state === "starting" || record.state === "stopping") await this.deactivateLocked(installationId);
    return summary(this.store.setState(installationId, "revoked", reason));
  }

  async update(installationId: string, manifest: PluginManifest, options: { sourceId: string; packageDir?: string }): Promise<PluginSummary> {
    const record = this.require(installationId);
    if (record.state === "active" || record.state === "starting" || record.state === "stopping") await this.deactivate(installationId);
    try {
      return summary(this.store.update(installationId, manifest, options));
    } catch (error) {
      if (error instanceof PluginStoreError) throw new PluginRegistryError("invalid-state", error.message);
      throw error;
    }
  }

  async rollback(installationId: string): Promise<PluginSummary> {
    const record = this.require(installationId);
    if (record.state === "active" || record.state === "starting" || record.state === "stopping") await this.deactivate(installationId);
    try {
      return summary(this.store.rollback(installationId));
    } catch (error) {
      if (error instanceof PluginStoreError) throw new PluginRegistryError("invalid-state", error.message);
      throw error;
    }
  }

  remove(installationId: string): Promise<PluginSummary> {
    return this.serial(installationId, () => this.removeLocked(installationId));
  }

  private async removeLocked(installationId: string): Promise<PluginSummary> {
    const record = this.require(installationId);
    if (record.state === "active" || record.state === "starting" || record.state === "stopping") await this.deactivateLocked(installationId);
    return summary(this.store.remove(installationId));
  }

  tools(installationId: string): Array<{ id: string; effect: string; description?: string; permission: string }> {
    const record = this.require(installationId);
    const tools = Array.isArray(record.manifest.contributes.tools) ? record.manifest.contributes.tools : [];
    return tools.flatMap((tool) => {
      // Without an explicit permission the effect must identify exactly one declared permission; otherwise which grant a
      // call consumes would depend on array order.
      const named = tool.permission ?? null;
      const candidates = record.manifest.permissions.filter((candidate) => candidate.effect === tool.effect);
      const permission = named ?? (candidates.length === 1 ? candidates[0]!.id : null);
      return permission ? [{ id: tool.id, effect: tool.effect, ...(tool.description ? { description: tool.description } : {}), permission }] : [];
    });
  }

  grants(installationId: string): readonly PluginGrant[] {
    return this.require(installationId).grants;
  }

  /** Issues a grant for one tool's permission, so a call with the same principal, audience and epoch may run it. */
  grantTool(installationId: string, input: {
    toolId: string; botId: string; principalId: string; audienceId: string; epoch: number;
    maxUses?: number; expiresAt?: string; resources?: PluginGrantResources;
  }): PluginGrant {
    const tool = this.tools(installationId).find((candidate) => candidate.id === input.toolId);
    if (!tool) throw new PluginRegistryError("not-found", `no tool ${input.toolId} in this installation`);
    const grant: PluginGrant = {
      grantId: `grant_${randomUUID().replaceAll("-", "")}`,
      installationId,
      botId: input.botId, principalId: input.principalId, audienceId: input.audienceId,
      permissionId: tool.permission, effect: tool.effect as PluginEffect,
      resources: input.resources ?? {},
      createdAt: new Date().toISOString(),
      epoch: input.epoch, uses: 0,
      ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    try {
      this.store.addGrant(installationId, grant);
    } catch (error) {
      if (error instanceof PluginStoreError) {
        throw new PluginRegistryError(error.code === "not-found" ? "not-found" : "invalid-state", error.message);
      }
      throw error;
    }
    return grant;
  }

  removeGrant(installationId: string, grantId: string): void {
    try {
      this.store.removeGrant(installationId, grantId);
    } catch (error) {
      if (error instanceof PluginStoreError) {
        throw new PluginRegistryError(error.code === "not-found" ? "not-found" : "invalid-state", error.message);
      }
      throw error;
    }
  }

  /**
   * The host resolves the permission and consumes the grant before the plugin sees the call. A plugin that returns
   * anything but the declared result is treated as a failure, never as success. `grant` hands in a grant the host
   * issued itself for this turn (a mounted tool): it passes the same checks a stored grant would, and is consumed in
   * memory, because it is not part of the installation's persisted grant list.
   */
  async callTool(installationId: string, toolId: string, context: {
    botId: string;
    principalId: string;
    audienceId: string;
    epoch: number;
    args: Record<string, unknown>;
    now?: string;
    accountId?: string;
    deviceId?: string;
    memorySpaceId?: string;
    resourceId?: string;
    grant?: PluginGrant;
  }): Promise<ActionResult> {
    const record = this.require(installationId);
    const tool = this.tools(installationId).find((candidate) => candidate.id === toolId);
    if (!tool) throw new PluginRegistryError("not-found", `no tool ${toolId} in this installation`);
    if (!this.options.runtime?.call) throw new PluginRegistryError("runtime-unavailable", "this host cannot call plugin tools without a runtime");
    if (record.state !== "active") throw new PluginRegistryError("invalid-state", `the plugin is ${record.state}`);
    const authorization = context.grant
      ? this.authorizeHeldGrant(record, tool.permission, context, context.grant)      : this.authorizeAndConsume({
        installationId,
        permissionId: tool.permission,
        botId: context.botId,
        principalId: context.principalId,
        audienceId: context.audienceId,
        epoch: context.epoch,
        now: context.now ?? new Date().toISOString(),
        ...(context.accountId ? { accountId: context.accountId } : {}),
        ...(context.deviceId ? { deviceId: context.deviceId } : {}),
        ...(context.memorySpaceId ? { memorySpaceId: context.memorySpaceId } : {}),
        ...(context.resourceId ? { resourceId: context.resourceId } : {}),
      });
    if (!authorization.allowed) {
      throw new PluginRegistryError("invalid-state", `${authorization.code}: ${authorization.error}`);
    }
    let result: unknown;
    try {
      result = await this.options.runtime.call(installationId, "tools/call", {
        toolId,
        arguments: context.args,
        context: {
          installationId,
          grantId: authorization.grant.grantId,
          botId: context.botId,
          principalId: context.principalId,
          audienceId: context.audienceId,
          epoch: context.epoch,
        },
      });
    } catch {
      return { status: "failed", code: "runtime-error", message: "the plugin did not answer", retryable: false };
    }
    const parsed = parseActionResult(result);
    if (!parsed.ok) return { status: "failed", code: "invalid-result", message: parsed.error, retryable: false };
    return parsed.value;
  }

  authorize(call: PluginCallRequest): PluginAuthorization {
    const record = this.require(call.installationId);
    return authorizePluginCall(
      { installationId: record.installationId, manifest: record.manifest, state: record.state, grants: record.grants },
      call,
    );
  }

  /** Use this on the dispatch path: it persists the use before the caller performs the effect. */
  authorizeAndConsume(call: PluginCallRequest): PluginAuthorization {
    const result = this.authorize(call);
    if (!result.allowed) return result;
    try {
      this.store.consumeGrant(call.installationId, result.grant.grantId);
    } catch (error) {
      if (error instanceof PluginStoreError) {
        return { allowed: false, code: "GRANT_EXHAUSTED", error: "the grant could not be consumed" };
      }
      throw error;
    }
    return result;
  }

  /** A turn grant the host issued in memory: every field a stored grant is matched on, checked the same way. */
  private authorizeHeldGrant(
    record: PluginInstallRecord,
    permissionId: string,
    context: { botId: string; principalId: string; audienceId: string; epoch: number; now?: string },
    grant: PluginGrant,
  ): PluginAuthorization {
    const request: PluginCallRequest = {
      installationId: record.installationId,
      permissionId,
      botId: context.botId,
      principalId: context.principalId,
      audienceId: context.audienceId,
      epoch: context.epoch,
      now: context.now ?? new Date().toISOString(),
    };
    const snapshot: PluginInstallSnapshot = { installationId: record.installationId, manifest: record.manifest, state: record.state, grants: [grant] };
    const result = authorizePluginCall(snapshot, request);
    if (result.allowed) grant.uses += 1;
    return result;
  }

  /** Tools of every active installation, resolved the way callTool resolves them: name, effect and permission. */
  activeTools(): Array<{
    installationId: string;
    pluginId: string;
    toolId: string;
    effect: PluginEffect;
    permission: string;
    description?: string;
  }> {
    const out: Array<{
      installationId: string;
      pluginId: string;
      toolId: string;
      effect: PluginEffect;
      permission: string;
      description?: string;
    }> = [];
    for (const record of this.store.list()) {
      if (record.state !== "active") continue;
      for (const tool of this.tools(record.installationId)) {
        out.push({
          installationId: record.installationId,
          pluginId: record.pluginId,
          toolId: tool.id,
          effect: tool.effect as PluginEffect,
          permission: tool.permission,
          ...(tool.description ? { description: tool.description } : {}),
        });
      }
    }
    return out;
  }

  private require(installationId: string): PluginInstallRecord {
    const record = this.store.get(installationId);
    if (!record) throw new PluginRegistryError("not-found", `no plugin installation ${installationId}`);
    return record;
  }

  private assertCompatible(manifest: PluginManifest): void {
    if (!satisfiesSemVer("1.0.0", manifest.apiVersion)) {
      throw new PluginRegistryError("incompatible", `plugin needs plugin API ${manifest.apiVersion}, this host provides 1.0.0`);
    }
    if (!satisfiesSemVer(this.options.hostVersion, manifest.compatibility.hostVersion)) {
      throw new PluginRegistryError("incompatible", `plugin needs host ${manifest.compatibility.hostVersion}, this host is ${this.options.hostVersion}`);
    }
    if (!manifest.compatibility.hosts.includes(this.options.host)) {
      throw new PluginRegistryError("incompatible", `plugin does not support the ${this.options.host} host`);
    }
    if (!manifest.compatibility.platforms.includes(this.options.platform)) {
      throw new PluginRegistryError("incompatible", `plugin does not support ${this.options.platform}`);
    }
  }

  private missingDependency(record: PluginInstallRecord): string | null {
    const active = this.store.list().filter((item) => item.state === "active" && item.installationId !== record.installationId);
    const providers = new Map<string, string>(Object.entries(HOST_SERVICES));
    for (const item of active) for (const [service, version] of Object.entries(item.manifest.provides ?? {})) providers.set(service, version);
    for (const [service, range] of Object.entries(record.manifest.requires ?? {})) {
      const version = providers.get(service);
      if (!version) return `required service ${service} is not provided by an active plugin or the host`;
      if (!satisfiesSemVer(version, range)) return `required service ${service} is ${version}, outside ${range}`;
    }
    return null;
  }
}
