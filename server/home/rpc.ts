// The JSON-RPC entry the harness proxy reaches for the home kind. tools/list is filtered by the turn's policy,
// so a read-only bot is not offered a command tool it would only be refused.
import { HOME_INSTRUCTIONS, HOME_TOOLS, isHomeToolName, runHomeTool, type HomeToolResult } from "./tools.ts";
import type { HomeToolContext } from "./tools.ts";

export const HOME_INTERNAL_MCP_PATH = "/api/internal/home/mcp";

export interface HomeRpcDeps extends Omit<HomeToolContext, "actor"> {
  assertActive(): void;
  /** The tools this turn may see at all. */
  allowed(name: string): boolean;
  actor: () => { id: string; threadId?: string };
}

export type HomeToolsList = { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>; instructions: string };

export async function homeRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: HomeRpcDeps,
): Promise<HomeToolsList | HomeToolResult> {
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: HOME_TOOLS.filter((tool) => deps.allowed(tool.name)), instructions: HOME_INSTRUCTIONS };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported home method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  if (!isHomeToolName(params.name)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: { code: "invalid_input", message: `no home tool named "${String(params.name).slice(0, 60)}"` } }) }], isError: true };
  }
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  deps.assertActive();
  if (!deps.allowed(params.name)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: { code: "refused", message: "this conversation may not use the home's devices" } }) }], isError: true };
  }
  const result = await runHomeTool(deps, params.name, args);
  deps.assertActive();
  return result;
}
