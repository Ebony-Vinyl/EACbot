import type { AgentAdapter, AgentId } from "./contracts.ts";
import { buildAgentEnv, type AuthConfig } from "./env.ts";
import { agentDescriptor, type AgentDescriptor } from "./registry.ts";
import { CustomAcpAdapter } from "./adapters/acp/session.ts";
import { ClaudeAdapter } from "./adapters/claude/session.ts";
import { CodexAdapter } from "./adapters/codex/session.ts";
import { HermesAdapter } from "./adapters/hermes/session.ts";
import { JsonlRpcAdapter } from "./adapters/jsonl-rpc/session.ts";
import { OpenCodeAdapter } from "./adapters/opencode/session.ts";
import type { FetchLike, SpawnFn } from "./transport/types.ts";
import { probeModelCatalog, type ModelCatalogReading } from "./catalog.ts";
import type { ModelBilling } from "./models.ts";

/** One agent instance: the agent, its own home, its own auth mode and its own model list. Two
 * instances of the same agent are separate in every one of those. */
export interface AgentInstanceConfig {
  instanceId: string;
  agentId: AgentId;
  /** Absolute path this instance's home lives at. Distinct per instance, always. */
  home: string;
  auth: AuthConfig;
  /** Overrides for this instance only; the allowlist still applies. */
  env?: Record<string, string>;
  /** The engine's executable, when it differs from the descriptor's. */
  cli?: string;
  /** HTTP agents only: the server this instance talks to. */
  baseUrl?: string;
  /** HTTP agents only: the bearer the server requires. */
  token?: string;
  /** A custom ACP agent's argv. */
  command?: string;
  args?: readonly string[];
}

export interface CreateAdapterOptions {
  spawn: SpawnFn;
  fetch: FetchLike;
  /** The host environment the allowlist draws from. */
  hostEnv: Record<string, string | undefined>;
  clientVersion?: string;
}

/** Builds the adapter for one configured instance. The environment is built here, once, so no
 * adapter has to remember the allowlist and no caller can pass one the allowlist rejected. */
export function createAdapter(instance: AgentInstanceConfig, options: CreateAdapterOptions): AgentAdapter {
  const descriptor: AgentDescriptor = agentDescriptor(instance.agentId);
  const agentId: AgentId = instance.agentId;
  const adapter = buildAdapter(agentId, descriptor, instance, options);
  const env = instanceEnv(instance, options.hostEnv);
  return {
    agentId: adapter.agentId,
    transport: adapter.transport,
    capabilities: adapter.capabilities,
    create: (input) => adapter.create({ ...input, env }),
  };
}

function buildAdapter(
  agentId: AgentId,
  descriptor: AgentDescriptor,
  instance: AgentInstanceConfig,
  options: CreateAdapterOptions,
): AgentAdapter {
  switch (agentId) {
    case "pi":
    case "ohMyPi":
      return new JsonlRpcAdapter(descriptor, {
        spawn: options.spawn,
        cli: instance.cli ?? descriptor.cli ?? agentId,
        home: instance.home,
        negotiateProtocol: true,
        settleOnAgentSettled: agentId === "pi",
      });
    case "claudeCode":
      return new ClaudeAdapter({ spawn: options.spawn, home: instance.home, ...(instance.cli ? { cli: instance.cli } : {}) });
    case "codex":
      return new CodexAdapter({
        spawn: options.spawn,
        home: instance.home,
        ...(instance.cli ? { cli: instance.cli } : {}),
        ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
      });
    case "openCode":
      return new OpenCodeAdapter({
        baseUrl: requireBaseUrl(instance),
        fetch: options.fetch,
        ...(instance.token ? { token: instance.token } : {}),
      });
    case "hermes":
      return new HermesAdapter({
        baseUrl: requireBaseUrl(instance),
        fetch: options.fetch,
        token: requireToken(instance),
      });
    case "custom":
      return new CustomAcpAdapter({
        spawn: options.spawn,
        command: instance.command ?? "custom-acp-agent",
        args: instance.args ?? [],
        home: instance.home,
      });
    default: {
      const exhaustive: never = agentId;
      throw new Error(`unknown agent ${String(exhaustive)}`);
    }
  }
}

function requireBaseUrl(instance: AgentInstanceConfig): string {
  if (!instance.baseUrl) throw new Error(`${instance.agentId} needs the server's base URL`);
  return instance.baseUrl.replace(/\/+$/, "");
}

function requireToken(instance: AgentInstanceConfig): string {
  if (!instance.token) throw new Error("Hermes' API server refuses every run without a bearer key");
  return instance.token;
}

/** The environment one instance's child process gets, including the engine's own home variable.
 * Exported so a caller can show exactly what will cross before a process starts. */
export function instanceEnv(instance: AgentInstanceConfig, hostEnv: Record<string, string | undefined>): Record<string, string> {
  const descriptor = agentDescriptor(instance.agentId);
  const homeEnv = descriptor.homeEnv ? { [descriptor.homeEnv]: instance.home } : {};
  return buildAgentEnv({
    host: hostEnv,
    instance: { ...instance.env, ...homeEnv, HOME: instance.home },
    auth: instance.auth,
  });
}

/** How this instance's models are billed, which the engine's own catalog never says. */
function instanceBilling(auth: AuthConfig): ModelBilling {
  if (auth.mode === "apiKey") return "api-key";
  if (auth.mode === "local") return "local";
  return "subscription";
}

/** Reads this instance's model catalog from the engine itself, with the instance's own home,
 * environment and server. An engine with no catalog surface says so rather than returning a list. */
export function probeInstanceCatalog(
  instance: AgentInstanceConfig,
  options: CreateAdapterOptions,
): Promise<ModelCatalogReading> {
  const descriptor = agentDescriptor(instance.agentId);
  return probeModelCatalog({
    agentId: instance.agentId,
    spawn: options.spawn,
    fetch: options.fetch,
    env: instanceEnv(instance, options.hostEnv),
    ...(instance.cli ? { cli: instance.cli } : descriptor.cli ? { cli: descriptor.cli } : {}),
    ...(instance.baseUrl ? { baseUrl: instance.baseUrl.replace(/\/+$/, "") } : {}),
    ...(instance.token ? { token: instance.token } : {}),
    billing: instanceBilling(instance.auth),
  });
}
