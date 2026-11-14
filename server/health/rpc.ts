// The JSON-RPC entry the harness proxy reaches for the health kind: tools/list and tools/call. The turn's
// capability must still be live before and after a call, and the caller decides who the turn's person is.
import { HEALTH_INSTRUCTIONS, HEALTH_TOOLS, isHealthToolName, runHealthTool, type HealthToolResult } from "./tools.ts";
import type { HealthStore } from "./store.ts";

export const HEALTH_INTERNAL_MCP_PATH = "/api/internal/health/mcp";

export interface HealthRpcDeps {
  store: HealthStore;
  assertActive(): void;
  /** Who this turn's health belongs to; a refusal is returned to the bot as a failed call. */
  authorize(name: string): { ok: true } | { ok: false; text: string };
  /** The names the bot may see, so a turn that cannot read health is not offered the tools at all. */
  allowed(name: string): boolean;
  confirmDelete?(sampleIds: readonly string[]): Promise<boolean>;
}

export type HealthToolsList = { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>; instructions: string };

export async function healthRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: HealthRpcDeps,
): Promise<HealthToolsList | HealthToolResult> {
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: HEALTH_TOOLS.filter((tool) => deps.allowed(tool.name)), instructions: HEALTH_INSTRUCTIONS };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported health method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  if (!isHealthToolName(params.name)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: { code: "invalid_input", message: `no health tool named "${String(params.name).slice(0, 60)}"` } }) }], isError: true };
  }
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  deps.assertActive();
  const verdict = deps.authorize(params.name);
  if (!verdict.ok) return { content: [{ type: "text", text: JSON.stringify({ error: { code: "refused", message: verdict.text } }) }], isError: true };
  const result = await runHealthTool({
    store: deps.store,
    ...(deps.confirmDelete ? { confirmDelete: deps.confirmDelete } : {}),
  }, params.name, args);
  deps.assertActive();
  return result;
}
