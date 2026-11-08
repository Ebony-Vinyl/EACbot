// The plugin tools' MCP mount: what a bot turn sees as the eac-plugins server, and the JSON-RPC entry its harness
// proxy reaches. Tools of active plugins are auto-mounted; a call passes the same grant authorization an explicit
// API call would, against a turn grant this host issued for read/draft effects, or a grant the owner issued.
import { createHash } from "node:crypto";

import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { PLUGINS_INSTRUCTIONS } from "../plugins-instructions.ts";
import { PluginRegistryError, type PluginRegistry } from "../plugins/registry.ts";
import type { PluginEffect } from "../../shared/plugins/manifest.ts";
import type { PluginGrant } from "../../shared/plugins/permissions.ts";

export const PLUGINS_MCP_SERVER = "eac-plugins";
export const PLUGINS_INTERNAL_MCP_PATH = "/api/internal/plugins/mcp";

/** Effects a turn grant may cover on its own; anything stronger needs a grant the owner issued. */
const AUTO_GRANTED_EFFECTS: ReadonlySet<PluginEffect> = new Set<PluginEffect>(["read", "draft"]);

const TURN_GRANT_TTL_MS = 30 * 60_000;
const TURN_GRANT_MAX_USES = 200;
const MCP_TOOL_NAME_MAX = 64;

/** Mounted into a turn's `custom` servers, so every driver's user-server rules and the tool scope apply to it alike. */
export const pluginsMcpMount = (origin: string, token: string): { command: string; args: string[]; env: Record<string, string> } => ({
  command: process.execPath,
  args: [SPAWNED_PROXIES.harnessMcp, "plugins"],
  env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("plugins")]: token, EAC_HARNESS_URL: origin },
});

export function pluginsToolName(pluginId: string, toolId: string): string {
  const plugin = pluginId.replaceAll(".", "_");
  const full = `plugin_${plugin}__${toolId}`;
  if (full.length <= MCP_TOOL_NAME_MAX) return full;
  // Deterministic clipping: the plugin name carries a hash suffix, so two long ids never collapse into one name.
  const digest = createHash("sha256").update(pluginId).digest("hex").slice(0, 8);
  const room = MCP_TOOL_NAME_MAX - ("plugin_".length + 1 + digest.length + 2 + toolId.length);
  const clipped = plugin.slice(0, Math.max(1, room));
  return `plugin_${clipped}_${digest}__${toolId}`.slice(0, MCP_TOOL_NAME_MAX);
}

interface MountedTool {
  installationId: string;
  pluginId: string;
  toolId: string;
  name: string;
  effect: PluginEffect;
  permission: string;
  description?: string;
}

export interface PluginsMcpDeps {
  registry: PluginRegistry;
  origin: string;
}

/** A turn's capability, narrowed to what the plugin mount may know: which bot, which conversation. */
export type PluginsMcpCapability = { botId: string; threadId: string };

export function createPluginsMcp(deps: PluginsMcpDeps) {
  const { registry } = deps;
  const turnGrants = new Map<string, PluginGrant>();

  const activeTools = (): MountedTool[] => registry.activeTools().map((tool) => ({
    installationId: tool.installationId,
    pluginId: tool.pluginId,
    toolId: tool.toolId,
    name: pluginsToolName(tool.pluginId, tool.toolId),
    effect: tool.effect,
    permission: tool.permission,
    ...(tool.description ? { description: tool.description } : {}),
  }));

  /** Turn identity is the bot, not the thread: an owner-issued grant names a bot it trusts, and any of that bot's
   * conversations may use it. The internal capability token is what keeps a call to one live turn. */
  const principalOf = (botId: string) => `bot:${botId}`;
  const audienceOf = principalOf;
  const grantKey = (threadId: string, tool: MountedTool) => `${threadId}\u0000${tool.installationId}\u0000${tool.toolId}`;

  /** One grant per (thread, installation, tool), held in memory only: it never reaches the persisted grant list. */
  const turnGrant = (capability: PluginsMcpCapability, tool: MountedTool, now: number): PluginGrant | null => {
    if (!AUTO_GRANTED_EFFECTS.has(tool.effect)) return null;
    const key = grantKey(capability.threadId, tool);
    const held = turnGrants.get(key);
    if (held && Date.parse(held.expiresAt ?? "") > now) return held;
    const grant: PluginGrant = {
      grantId: `turn_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
      installationId: tool.installationId,
      botId: capability.botId,
      principalId: principalOf(capability.botId),
      audienceId: audienceOf(capability.botId),
      permissionId: tool.permission,
      effect: tool.effect,
      resources: {},
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TURN_GRANT_TTL_MS).toISOString(),
      epoch: 0,
      maxUses: TURN_GRANT_MAX_USES,
      uses: 0,
    };
    turnGrants.set(key, grant);
    return grant;
  };

  const refusalText = (tool: MountedTool, detail: string): string => AUTO_GRANTED_EFFECTS.has(tool.effect)
    ? `The plugin call was refused: ${detail}`
    : `The plugin call was refused: this tool's effect is ${tool.effect}, and this bot holds no owner-issued grant for it. The owner can grant it from the plugin's grants page. (${detail})`;

  return {
    server: PLUGINS_MCP_SERVER,
    /** Whether this turn mounts the plugin tools at all: at least one active plugin tool must exist. */
    mounts(capability: PluginsMcpCapability, mint: () => string): PluginsMcpMount | null {
      const tools = activeTools();
      if (!tools.length) return null;
      const now = Date.now();
      for (const tool of tools) turnGrant(capability, tool, now);
      return pluginsMcpMount(deps.origin, mint());
    },
    /** A turn's grants die with it: dropped when the turn settles, and by a TTL so a crashed server holds nothing. */
    forgetTurn(threadId: string): void {
      for (const key of turnGrants.keys()) if (key.startsWith(`${threadId}\u0000`)) turnGrants.delete(key);
    },
    toolListing(): Array<{ name: string; description: string }> | null {
      const tools = activeTools();
      return tools.length ? tools.map((tool) => ({
        name: tool.name,
        description: `[${tool.pluginId} · effect: ${tool.effect}] ${tool.description ?? tool.toolId}`,
      })) : null;
    },

    /** The JSON-RPC entry the harness proxy reaches: tools/list and tools/call, each against this turn's capability. */
    async handle(body: unknown, capability: PluginsMcpCapability, assertActive: () => void): Promise<unknown> {
      const request = (body ?? {}) as { method?: unknown; params?: unknown };
      if (request.method === "tools/list") {
        assertActive();
        return { tools: this.toolListing() ?? [], instructions: PLUGINS_INSTRUCTIONS };
      }
      if (request.method !== "tools/call") throw Object.assign(new Error("unsupported plugins method"), { status: 400 });
      const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name.slice(0, 160) : "";
      const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
      assertActive();
      const tool = activeTools().find((candidate) => candidate.name === name);
      if (!tool) {
        return { content: [{ type: "text", text: `No installed, active plugin offers a tool named "${name || "<unnamed>"}".` }], isError: true };
      }
      const grant = turnGrant(capability, tool, Date.now());
      try {
        const result = await registry.callTool(tool.installationId, tool.toolId, {
          botId: capability.botId,
          principalId: principalOf(capability.botId),
          audienceId: audienceOf(capability.botId),
          epoch: 0,
          args,
          ...(grant ? { grant } : {}),
        });
        assertActive();
        const text = result.status === "succeeded"
          ? JSON.stringify(result.value ?? null)
          : result.status === "failed" ? `failed: ${result.message}` : result.status === "cancelled" ? `cancelled: ${result.reason}` : `indeterminate: ${result.operationId} (${result.verification})`;
        return { content: [{ type: "text", text }], isError: result.status !== "succeeded" };
      } catch (error) {
        const detail = error instanceof PluginRegistryError
          ? error.message
          : error instanceof Error ? error.message : "the plugin call failed";
        return { content: [{ type: "text", text: refusalText(tool, detail) }], isError: true };
      }
    },
  };
}

export type PluginsMcp = ReturnType<typeof createPluginsMcp>;
export interface PluginsMcpMount {
  command: string;
  args: string[];
  env: Record<string, string>;
}
