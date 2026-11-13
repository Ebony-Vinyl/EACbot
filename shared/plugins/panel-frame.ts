import type { AppDocument } from "../app.ts";
import { mcpAppCsp } from "../app-frame/csp.ts";
import type { SandboxPanelSpec } from "./panels.ts";

export const PANEL_DATA_SOURCES = ["tasks", "usage", "platforms"] as const;
export type PanelDataSource = (typeof PANEL_DATA_SOURCES)[number];

export function pluginPanelDocument(spec: SandboxPanelSpec): AppDocument {
  const network = { connect: [], resources: [] };
  const csp = mcpAppCsp(network);
  return {
    v: 1,
    messageId: "plugin-panel",
    rev: 0,
    srcdoc: `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${csp}">${spec.html}`,
    csp,
    network,
    tool: { name: "panel_data", inputSchema: { type: "object" } },
    can: { serverTools: true, serverResources: false, message: false, openLinks: false, modelContext: false },
  };
}

export function panelFrameRpc(method: string, params: Record<string, unknown>, deps: {
  nonce: string;
  active(): boolean;
  read(source: PanelDataSource): unknown;
}): unknown {
  if (!deps.active() || params.nonce !== deps.nonce) throw new Error("Panel capability is unavailable.");
  if (method === "tools/list") {
    return { tools: [{ name: "panel_data", inputSchema: {
      type: "object", properties: { source: { type: "string", enum: PANEL_DATA_SOURCES } }, required: ["source"], additionalProperties: false,
    } }] };
  }
  const args = params.arguments;
  if (method !== "tools/call" || params.name !== "panel_data" || !args || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).some((key) => key !== "source") || !PANEL_DATA_SOURCES.includes((args as { source?: unknown }).source as PanelDataSource)) {
    throw new Error("This panel can only read tasks, usage or platforms.");
  }
  return { content: [{ type: "text", text: JSON.stringify(deps.read((args as { source: PanelDataSource }).source)) }] };
}
