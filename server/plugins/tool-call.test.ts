import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginInstallStore } from "./store.ts";
import { PluginRegistry } from "./registry.ts";
import { grant, manifest } from "./test-fixtures.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function registryWithTool() {
  const folder = mkdtempSync(join(tmpdir(), "eac-plugin-tool-"));
  folders.push(folder);
  const call = vi.fn(async (): Promise<unknown> => ({ status: "succeeded", value: { pong: true } }));
  const runtime = { start: vi.fn(async () => ({ ok: true as const })), stop: vi.fn(async () => undefined), call };
  const store = new PluginInstallStore(folder);
  const registry = new PluginRegistry(store, {
    hostVersion: "0.1.146", host: "server", platform: "win32-x64", runtime,
  });
  const installed = registry.install(manifest({
    contributes: { tools: [{ id: "ping", entry: "tools/ping.mjs", effect: "read", permission: "read-library", description: "Ping the plugin." }] },
  }), "community");
  await registry.activate(installed.installationId);
  return { folder, store, registry, installed, call };
}

function addGrant(store: PluginInstallStore, installationId: string) {
  store.addGrant(installationId, grant(installationId, { epoch: 1 }));
}

const context = {
  botId: "bot-1",
  principalId: "owner-1",
  audienceId: "private-owner-1",
  epoch: 1,
  accountId: "music-1",
  args: { text: "hello" },
};

describe("plugin tool calls", () => {
  it("lists a declared tool with the permission it consumes", async () => {
    const { registry, installed } = await registryWithTool();
    expect(registry.tools(installed.installationId)).toMatchObject([
      { id: "ping", effect: "read", permission: "read-library", description: "Ping the plugin." },
    ]);
  });

  it("consumes the grant before calling the runtime and returns its result", async () => {
    const { store, registry, installed, call } = await registryWithTool();
    addGrant(store, installed.installationId);
    await expect(registry.callTool(installed.installationId, "ping", context)).resolves.toEqual({ status: "succeeded", value: { pong: true } });
    expect(call).toHaveBeenCalledWith(installed.installationId, "tools/call", expect.objectContaining({
      toolId: "ping",
      arguments: { text: "hello" },
      context: expect.objectContaining({ grantId: "grant-1", botId: "bot-1", epoch: 1 }),
    }));
    expect(store.get(installed.installationId)?.grants[0]?.uses).toBe(1);
  });

  it("refuses a call whose bot has no grant, before the plugin runs", async () => {
    const { store, registry, installed, call } = await registryWithTool();
    addGrant(store, installed.installationId);
    await expect(registry.callTool(installed.installationId, "ping", { ...context, botId: "bot-2" })).rejects.toThrow(/another bot/);
    expect(call).not.toHaveBeenCalled();
  });

  it("turns an invalid plugin answer into a failed result, not success", async () => {
    const { store, registry, installed, call } = await registryWithTool();
    addGrant(store, installed.installationId);
    call.mockResolvedValueOnce({ ok: true });
    await expect(registry.callTool(installed.installationId, "ping", context)).resolves.toMatchObject({ status: "failed", code: "invalid-result" });
  });
});
