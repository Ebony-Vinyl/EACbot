/**
 * Builds the real composition: the agent instances `core.json` describes, the
 * adapters they become, and the runtime those adapters serve.
 *
 * Nothing here opens a socket or reads the person's home. The data directory,
 * the process spawner, the HTTP client and the host environment all arrive as
 * options, so a test can compose the same object graph against a temporary
 * directory and scripted children. Starting the HTTP server is a separate step
 * (`startServer`), and this module never performs it.
 *
 * One protocol limitation is visible here: the mission wire type names an agent
 * by `AgentKind`, so a task command can only say "hermes", not which of two
 * configured hermes instances. When several instances share a kind, the first
 * enabled one in the file serves every task of that kind; the rest are reported
 * in `skipped` with that reason. `instanceFor` reports which one won.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type {
  AgentAdapter as ProtocolAdapter,
  AdapterHandle,
  AdapterStartRequest,
  AdapterSink,
} from "../../packages/agent-protocol/adapter.ts";
import type { AgentDescriptor, AgentKind, ModelRef } from "../../packages/agent-protocol/agents.ts";
import type { EnvironmentRef } from "../../packages/agent-protocol/environment.ts";
import type { CredentialRef } from "../../packages/agent-protocol/environment.ts";
import type { TerminalPort, TerminalStreamHandler } from "../http/ports.ts";
import type { AuthConfig } from "../agents/env.ts";
import type { AgentAdapter as CoreAgentAdapter } from "../agents/contracts.ts";
import { createAdapter, probeInstanceCatalog, type AgentInstanceConfig } from "../agents/index.ts";
import { agentDescriptor } from "../agents/registry.ts";
import type { FetchLike, SpawnFn } from "../agents/transport/types.ts";
import type { ModelCatalogReading } from "../agents/catalog.ts";
import { capabilitiesFor } from "../missions/capabilities.ts";
import { CoreAgentBridge } from "../missions/bridge.ts";
import { MissionRuntime } from "../missions/runtime.ts";
import { ProbedAgentCatalog } from "./agents.ts";
import { InMemoryEnvironmentStore } from "./environments.ts";
import {
  describeSecretRef,
  loadCoreConfig,
  resolveSecret,
  type CoreConfig,
  type CoreConfigAgent,
  type LoadedCoreConfig,
} from "./config.ts";

export interface ProductionDependencies {
  readonly spawn: SpawnFn;
  readonly fetch: FetchLike;
  /** The host environment the allowlist draws from. Never `process.env` by default. */
  readonly hostEnv: Record<string, string | undefined>;
  readonly clientVersion?: string;
}

export interface ProductionCompositionOptions extends ProductionDependencies {
  /** Holds `core.json` and `missions.db`. */
  readonly dataDir: string;
  readonly configPath?: string;
  readonly discoveredAgents?: readonly CoreConfigAgent[];
  readonly now?: () => string;
  readonly catalogTtlMs?: number;
  readonly onError?: (error: unknown, context: string) => void;
}

/** An instance the configuration named but this composition does not use.
 * `reason` names the field or the missing variable, never a value. */
export interface SkippedInstance {
  readonly instanceId: string;
  readonly agentId: AgentKind;
  readonly reason: string;
}

export interface ProductionComposition {
  readonly config: LoadedCoreConfig;
  readonly runtime: MissionRuntime;
  readonly agents: ProbedAgentCatalog;
  readonly environments: InMemoryEnvironmentStore;
  readonly terminals: TerminalPort;
  readonly terminalStreams: TerminalStreamHandler;
  readonly skipped: readonly SkippedInstance[];
  /** Which instance serves task commands for a kind, when any does. */
  readonly instanceFor: (kind: AgentKind) => string | undefined;
  readonly refreshCatalogs: () => Promise<void>;
  close(): void;
}

/** The composition, without a server. The caller passes `runtime` to
 * `startServer` and the other ports to its composition; nothing is listening
 * when this returns. */
export function buildProductionComposition(options: ProductionCompositionOptions): ProductionComposition {
  const config = loadCoreConfig(options.configPath ?? join(options.dataDir, "core.json"));
  const configuredKinds = new Set(config.config.agents.map((agent) => agent.agentId));
  const discovered = (options.discoveredAgents ?? []).filter((agent) => !configuredKinds.has(agent.agentId));
  const built = buildInstances({ ...config.config, agents: [...config.config.agents, ...discovered] }, options, options.onError);
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });

  const catalog = new ProbedAgentCatalog({
    kinds: [...built.kinds],
    describe: (kind) => describeKind(kind),
    probe: (kind) => {
      const instance = built.probeTargets.get(kind);
      if (!instance) {
        return Promise.resolve<ModelCatalogReading>({
          state: "unknown",
          agentId: kind,
          reason: `no enabled ${kind} instance is configured`,
        });
      }
      return probeInstanceCatalog(instance, {
        spawn: options.spawn,
        fetch: options.fetch,
        hostEnv: options.hostEnv,
        ...(options.clientVersion !== undefined ? { clientVersion: options.clientVersion } : {}),
      });
    },
    defaultModel: (kind) => built.defaultModels.get(kind),
    ...(options.catalogTtlMs !== undefined ? { ttlMs: options.catalogTtlMs } : {}),
    ...(options.onError !== undefined ? { onProbeError: (kind, error) => options.onError!(error, `catalog probe for ${kind}`) } : {}),
  });

  const runtime = new MissionRuntime({
    databasePath: join(options.dataDir, "missions.db"),
    adapters: (kind) => built.adapters.get(kind),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  const environments = new InMemoryEnvironmentStore({
    now: options.now ?? (() => new Date().toISOString()),
    seed: config.config.environments.map(toEnvironmentRef),
  });

  let closed = false;
  return {
    config,
    runtime,
    agents: catalog,
    environments,
    terminals: INERT_TERMINALS,
    terminalStreams: INERT_TERMINAL_STREAMS,
    skipped: built.skipped,
    instanceFor: (kind) => built.instanceFor.get(kind),
    refreshCatalogs: () => catalog.refreshAll(),
    close: () => {
      if (closed) return;
      closed = true;
      runtime.close();
      for (const adapter of built.adapters.values()) void adapter.dispose?.();
    },
  };
}

/** The ports `startServer` expects, so a launcher states each one once. */
export function productionPorts(composition: ProductionComposition): {
  readonly agents: ProbedAgentCatalog;
  readonly environments: InMemoryEnvironmentStore;
  readonly terminals: TerminalPort;
  readonly terminalStreams: TerminalStreamHandler;
} {
  return {
    agents: composition.agents,
    environments: composition.environments,
    terminals: composition.terminals,
    terminalStreams: composition.terminalStreams,
  };
}

interface BuiltInstances {
  readonly adapters: Map<AgentKind, ProtocolAdapter>;
  readonly kinds: AgentKind[];
  readonly instanceFor: Map<AgentKind, string>;
  readonly probeTargets: Map<AgentKind, AgentInstanceConfig>;
  readonly defaultModels: Map<AgentKind, ModelRef>;
  readonly skipped: SkippedInstance[];
}

/** Turns each configured instance into an adapter. Only the first enabled
 * instance of a kind is registered, because a task command names a kind and not
 * an instance; a later enabled one is reported in `skipped`. A reference that
 * resolves to nothing is reported the same way, so no instance fails silently. */
function buildInstances(config: CoreConfig, options: ProductionDependencies, onError?: (error: unknown, context: string) => void): BuiltInstances {
  const adapters = new Map<AgentKind, ProtocolAdapter>();
  const instanceFor = new Map<AgentKind, string>();
  const probeTargets = new Map<AgentKind, AgentInstanceConfig>();
  const defaultModels = new Map<AgentKind, ModelRef>();
  const kinds: AgentKind[] = [];
  const skipped: SkippedInstance[] = [];

  for (const agent of config.agents) {
    let instance: AgentInstanceConfig;
    let core: CoreAgentAdapter;
    try {
      instance = toInstanceConfig(agent, options.hostEnv);
      core = createAdapter(instance, {
        spawn: options.spawn,
        fetch: options.fetch,
        hostEnv: options.hostEnv,
        ...(options.clientVersion !== undefined ? { clientVersion: options.clientVersion } : {}),
      });
    } catch (error) {
      skipped.push({ instanceId: agent.id, agentId: agent.agentId, reason: describe(error) });
      continue;
    }
    if (!agent.enabled) continue;

    const serving = instanceFor.get(agent.agentId);
    if (serving !== undefined) {
      const reason = `another instance (${JSON.stringify(serving)}) already serves ${agent.agentId}; a task command names only an agent kind, so this instance is not registered`;
      skipped.push({ instanceId: agent.id, agentId: agent.agentId, reason });
      onError?.(new Error(`agent ${JSON.stringify(agent.id)}: ${reason}`), `compose agent ${JSON.stringify(agent.id)}`);
      continue;
    }
    if (!kinds.includes(agent.agentId)) kinds.push(agent.agentId);
    const model = agent.model === undefined ? undefined : modelRefOf(agent.agentId, agent.model);
    if (model !== undefined) defaultModels.set(agent.agentId, model);
    probeTargets.set(agent.agentId, instance);
    instanceFor.set(agent.agentId, agent.id);
    adapters.set(agent.agentId, withDefaultModel(new CoreAgentBridge({ adapter: core, kind: agent.agentId }), model));
  }
  return { adapters, kinds, instanceFor, probeTargets, defaultModels, skipped };
}

function modelRefOf(kind: AgentKind, model: NonNullable<CoreConfigAgent["model"]>): ModelRef {
  return {
    agent: kind,
    model: `${model.providerId}/${model.modelId}`,
    ...(model.variant !== undefined ? { variant: model.variant } : {}),
  };
}

/** Maps one configuration entry onto the adapter facade's input, resolving any
 * secret reference. A reference that resolves to nothing is a build failure
 * for that instance, reported by name rather than by an empty credential. */
export function toInstanceConfig(agent: CoreConfigAgent, hostEnv: Record<string, string | undefined>): AgentInstanceConfig {
  return {
    instanceId: agent.id,
    agentId: agent.agentId,
    home: agent.home,
    auth: authOf(agent, hostEnv),
    ...(agent.env !== undefined ? { env: agent.env } : {}),
    ...(agent.cli !== undefined ? { cli: agent.cli } : {}),
    ...(agent.baseUrl !== undefined ? { baseUrl: agent.baseUrl } : {}),
    ...(agent.token !== undefined ? { token: requireSecret(agent.token, "token", hostEnv) } : {}),
    ...(agent.agentId === "custom" && agent.cli !== undefined ? { command: agent.cli } : {}),
    ...(agent.args !== undefined ? { args: agent.args } : {}),
  };
}

function authOf(agent: CoreConfigAgent, hostEnv: Record<string, string | undefined>): AuthConfig {
  switch (agent.authMode) {
    case "subscription":
      return { mode: "subscription" };
    case "apiKey": {
      if (!agent.apiKey) throw new Error(`${agent.id}: apiKey auth needs apiKey.name and apiKey.value`);
      return {
        mode: "apiKey",
        apiKey: { name: agent.apiKey.name, value: requireSecret(agent.apiKey.value, "apiKey.value", hostEnv) },
      };
    }
    case "compatibleEndpoint": {
      const provider = agent.provider;
      if (!provider) throw new Error(`${agent.id}: compatibleEndpoint auth needs provider.baseUrl`);
      const apiKeyValue = provider.apiKeyName !== undefined && provider.apiKey !== undefined
        ? requireSecret(provider.apiKey, "provider.apiKey", hostEnv)
        : undefined;
      return {
        mode: "compatibleEndpoint",
        compatibleEndpoint: {
          baseUrl: provider.baseUrl,
          ...(provider.apiKeyName !== undefined ? { apiKeyName: provider.apiKeyName } : {}),
          ...(apiKeyValue !== undefined ? { apiKeyValue } : {}),
        },
      };
    }
    case "local": {
      const provider = agent.provider;
      if (!provider) throw new Error(`${agent.id}: local auth needs provider.baseUrl`);
      return { mode: "local", local: { baseUrl: provider.baseUrl } };
    }
  }
}

function requireSecret(
  ref: string | { readonly env: string },
  field: string,
  hostEnv: Record<string, string | undefined>,
): string {
  const value = resolveSecret(ref, hostEnv);
  if (value === undefined) throw new Error(`${field} is not set: ${describeSecretRef(ref)} is empty or missing`);
  return value;
}

/** A configured model fills the gap when a caller names none; it never replaces
 * a model the caller asked for, so the mission authority stays the chooser. */
function withDefaultModel(adapter: ProtocolAdapter, model: ModelRef | undefined): ProtocolAdapter {
  if (!model) return adapter;
  const fill = (request: AdapterStartRequest): AdapterStartRequest =>
    request.model === undefined ? { ...request, model } : request;
  return {
    kind: adapter.kind,
    describe: () => adapter.describe(),
    start: (request: AdapterStartRequest, sink: AdapterSink): Promise<AdapterHandle> => adapter.start(fill(request), sink),
    resume: (request: AdapterStartRequest, sink: AdapterSink): Promise<AdapterHandle> => adapter.resume(fill(request), sink),
    steer: (runId, input, commandId) => adapter.steer(runId, input, commandId),
    interrupt: (runId, reason) => adapter.interrupt(runId, reason),
    cancel: (runId, reason) => adapter.cancel(runId, reason),
    ...(adapter.dispose ? { dispose: (): Promise<void> => adapter.dispose!() } : {}),
  };
}

/** A descriptor read from the one registry, carrying no instance's home,
 * server URL or credential. */
function describeKind(kind: AgentKind): AgentDescriptor {
  const descriptor = agentDescriptor(kind);
  return {
    kind,
    label: descriptor.displayName,
    authModes: descriptor.authModes,
    capabilities: capabilitiesFor(kind),
    models: [],
  };
}

function toEnvironmentRef(environment: CoreConfig["environments"][number]): EnvironmentRef {
  return {
    id: environment.id,
    label: environment.label,
    kind: environment.kind,
    authMode: environment.authMode,
    ...(environment.host !== undefined ? { host: environment.host } : {}),
    ...(environment.port !== undefined ? { port: environment.port } : {}),
    ...(environment.user !== undefined ? { user: environment.user } : {}),
    ...(environment.credentialRef !== undefined ? { credentialRef: environment.credentialRef as CredentialRef } : {}),
    ...(environment.baseUrl !== undefined ? { baseUrl: environment.baseUrl } : {}),
    ...(environment.hostKeyFingerprint !== undefined ? { hostKeyFingerprint: environment.hostKeyFingerprint } : {}),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const INERT_TERMINALS: TerminalPort = { list: () => [], get: () => undefined, start: async () => { throw new Error("terminals are not configured"); } };

const INERT_TERMINAL_STREAMS: TerminalStreamHandler = {
  open: () => {
    throw new Error("terminal transport is not configured");
  },
};
