// The JSON-RPC entry the harness proxy reaches for the music kind. tools/list is
// filtered by the turn's policy, so a read-only bot is not offered a control tool
// it would only be refused.
import { MUSIC_INSTRUCTIONS, MUSIC_TOOLS, isMusicToolName, runMusicTool, type MusicToolResult } from "./tools.ts";
import type { MusicToolContext } from "./tools.ts";

export const MUSIC_INTERNAL_MCP_PATH = "/api/internal/music/mcp";

export interface MusicRpcDeps extends Omit<MusicToolContext, "botId"> {
  botId: string;
  assertActive(): void;
  /** The tools this turn may see at all. */
  allowed(name: string): boolean;
}

export type MusicToolsList = { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>; instructions: string };

/** Which tools change playback, so `read` access can hide them. */
const CONTROL_TOOLS: ReadonlySet<string> = new Set([
  "MUSIC_PLAY",
  "MUSIC_CONTROL",
  "MUSIC_FAVORITE",
  "MUSIC_PLAN",
  "MUSIC_IDENTIFY",
]);

export function musicToolNeedsControl(name: string): boolean {
  return CONTROL_TOOLS.has(name);
}

export async function musicRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: MusicRpcDeps,
): Promise<MusicToolsList | MusicToolResult> {
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: MUSIC_TOOLS.filter((tool) => deps.allowed(tool.name)), instructions: MUSIC_INSTRUCTIONS };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported music method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  if (!isMusicToolName(params.name)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: { code: "invalid_input", message: `no music tool named "${String(params.name).slice(0, 60)}"` } }) }], isError: true };
  }
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  deps.assertActive();
  if (!deps.allowed(params.name)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: { code: "refused", message: "this conversation may not change the player" } }) }], isError: true };
  }
  const result = await runMusicTool({ ...deps, botId: deps.botId }, params.name, args);
  deps.assertActive();
  return result;
}
