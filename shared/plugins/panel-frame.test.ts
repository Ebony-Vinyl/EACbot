import { describe, expect, it } from "vitest";

import { createAppBridge, type AppBridgeAdapter } from "../app-frame/bridge.ts";
import { panelFrameRpc, pluginPanelDocument } from "./panel-frame.ts";

const spec = { schemaVersion: 1, title: "Panel", slot: "workspace", html: "<p>Panel</p>" } as const;

describe("sandbox plugin panels", () => {
  it("blocks external network access and enables only read RPC", () => {
    const doc = pluginPanelDocument(spec);
    expect(doc.srcdoc).toContain("connect-src 'none'");
    expect(doc.srcdoc).toContain("frame-src 'none'");
    expect(doc.can).toEqual({ serverTools: true, serverResources: false, message: false, openLinks: false, modelContext: false });
    const deps = { nonce: "turn-nonce", active: () => true, read: () => [{ title: "Task" }] };
    expect(() => panelFrameRpc("tools/call", { nonce: "forged", name: "panel_data", arguments: { source: "tasks" } }, deps)).toThrow(/unavailable/);
    expect(() => panelFrameRpc("tools/call", { nonce: deps.nonce, name: "execute", arguments: { source: "tasks" } }, deps)).toThrow(/only read/);
    expect(() => panelFrameRpc("tools/call", { nonce: deps.nonce, name: "panel_data", arguments: { source: "private-memory" } }, deps)).toThrow(/only read/);
    expect(panelFrameRpc("tools/call", { nonce: deps.nonce, name: "panel_data", arguments: { source: "tasks" } }, deps)).toEqual({ content: [{ type: "text", text: '[{"title":"Task"}]' }] });
    expect(() => panelFrameRpc("tools/list", { nonce: deps.nonce }, { ...deps, active: () => false })).toThrow(/unavailable/);
  });

  it("ignores a forged source and refuses calls after disposal", async () => {
    const source = {};
    const sent: unknown[] = [];
    const adapter: AppBridgeAdapter = {
      post: (message) => { sent.push(message); }, callRpc: async () => ({}), sendMessage: async () => {},
      openLink: () => {}, setContext: () => {}, resize: () => {}, engaged: () => true, teardownRequested: () => {}, now: Date.now,
    };
    const bridge = createAppBridge({ doc: pluginPanelDocument(spec), hostContext: {}, adapter, source: () => source, hostVersion: "1.0.0" });
    const initialize = { jsonrpc: "2.0", id: 1, method: "ui/initialize" };
    bridge.handleMessage({ source: {}, data: initialize });
    expect(sent).toEqual([]);
    bridge.handleMessage({ source, data: initialize });
    expect(sent).toHaveLength(1);
    bridge.dispose();
    bridge.handleMessage({ source, data: initialize });
    expect(sent).toHaveLength(1);
  });
});
