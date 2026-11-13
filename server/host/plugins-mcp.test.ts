import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PluginInstallStore } from "../plugins/store.ts";
import { PluginRegistry } from "../plugins/registry.ts";
import { manifest } from "../plugins/test-fixtures.ts";
import { createPluginsMcp, pluginsToolName, PLUGINS_MCP_SERVER } from "./plugins-mcp.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type RuntimeCall = { installationId: string; method: string; params: unknown };

function setup(calls: RuntimeCall[]) {
  const folder = mkdtempSync(join(tmpdir(), "eac-plugins-mcp-"));
  folders.push(folder);
  const runtime = {
    start: async () => ({ ok: true as const }),
    stop: async () => {},
    call: async (installationId: string, method: string, params: unknown) => {
      calls.push({ installationId, method, params });
      return { status: "succeeded", value: { seen: (params as { toolId?: string }).toolId ?? null } };
    },
  };
  const registry = new PluginRegistry(new PluginInstallStore(folder), {
    hostVersion: "0.1.146",
    host: "server",
    platform: "win32-x64",
    runtime,
  });
  return { registry };
}

async function installReadAndSendPlugin(registry: PluginRegistry): Promise<string> {
  const installed = registry.install(manifest({
    pluginId: "eac.library",
    permissions: [
      { id: "read-library", capability: "library.read", effect: "read", scope: {}, reason: "Read the library." },
      { id: "send-request", capability: "library.request", effect: "send", scope: {}, reason: "Send a request." },
    ],
    contributes: {
      tools: [
        { id: "search", entry: "tools/search.mjs", effect: "read", description: "Search the library." },
        { id: "request", entry: "tools/request.mjs", effect: "send", permission: "send-request", description: "Send a request." },
      ],
    },
  }), "community");
  await registry.activate(installed.installationId);
  return installed.installationId;
}

describe("plugin tools MCP mount", () => {
  it("mounts nothing while no plugin tool is active, and a harness spec once one is", async () => {
    const calls: RuntimeCall[] = [];
    const { registry } = setup(calls);
    const mcp = createPluginsMcp({ registry, origin: "http://127.0.0.1:1234" });
    expect(mcp.mounts({ botId: "bot-1", threadId: "t1" }, () => "token")).toBeNull();

    await installReadAndSendPlugin(registry);
    const mount = mcp.mounts({ botId: "bot-1", threadId: "t1" }, () => "token-1");
    expect(mount).not.toBeNull();
    expect(mount?.args[1]).toBe("plugins");
    expect(mount?.env.EAC_MCP_TOKEN_PLUGINS).toBe("token-1");
    expect(mount?.env.EAC_HARNESS_URL).toBe("http://127.0.0.1:1234");
  });

  it("lists active tools under mounted names and refuses an unknown tool", async () => {
    const calls: RuntimeCall[] = [];
    const { registry } = setup(calls);
    const mcp = createPluginsMcp({ registry, origin: "http://127.0.0.1:1234" });
    await installReadAndSendPlugin(registry);
    const capability = { botId: "bot-1", threadId: "t1" };
    const active = () => true;

    const listing = await mcp.handle({ method: "tools/list" }, capability, active) as { tools: Array<{ name: string; description: string }> };
    expect(listing.tools.map((tool) => tool.name)).toEqual(["plugin_eac_library__search", "plugin_eac_library__request"]);
    expect(listing.tools[0]?.description).toContain("eac.library");
    expect(listing.tools[0]?.description).toContain("effect: read");

    const unknown = await mcp.handle({ method: "tools/call", params: { name: "plugin_eac_library__missing", arguments: {} } }, capability, active) as { isError: boolean };
    expect(unknown.isError).toBe(true);
  });

  it("auto-authorizes a read tool for the turn and refuses a send tool without an owner grant", async () => {
    const calls: RuntimeCall[] = [];
    const { registry } = setup(calls);
    const mcp = createPluginsMcp({ registry, origin: "http://127.0.0.1:1234" });
    const installationId = await installReadAndSendPlugin(registry);
    const capability = { botId: "bot-1", threadId: "t1" };
    const active = () => true;

    const read = await mcp.handle({ method: "tools/call", params: { name: "plugin_eac_library__search", arguments: { q: "x" } } }, capability, active) as { content: Array<{ text: string }>; isError: boolean };
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.content[0]!.text)).toEqual({ seen: "search" });
    expect(calls[0]?.installationId).toBe(installationId);
    const context = (calls[0]!.params as { context: { grantId: string; botId: string } }).context;
    expect(context.botId).toBe("bot-1");
    expect(context.grantId).toMatch(/^turn_/);

    const send = await mcp.handle({ method: "tools/call", params: { name: "plugin_eac_library__request", arguments: {} } }, capability, active) as { content: Array<{ text: string }>; isError: boolean };
    expect(send.isError).toBe(true);
    expect(send.content[0]!.text).toContain("owner-issued grant");
    expect(calls).toHaveLength(1);
  });

  it("keeps a turn's grants from reaching the persisted grant list, and drops them when the turn ends", async () => {
    const calls: RuntimeCall[] = [];
    const { registry } = setup(calls);
    const mcp = createPluginsMcp({ registry, origin: "http://127.0.0.1:1234" });
    await installReadAndSendPlugin(registry);
    const capability = { botId: "bot-1", threadId: "t1" };
    const active = () => true;
    await mcp.mounts(capability, () => "token-1");
    await mcp.handle({ method: "tools/call", params: { name: "plugin_eac_library__search", arguments: {} } }, capability, active);
    expect(registry.grants(registry.list()[0]!.installationId)).toEqual([]);

    mcp.forgetTurn("t1");
    const again = await mcp.handle({ method: "tools/call", params: { name: "plugin_eac_library__search", arguments: {} } }, capability, active) as { isError: boolean };
    expect(again.isError).toBe(false);
  });

  it("does not reuse a bot's owner grant or auto-grant private plugin reads to a platform audience", async () => {
    const calls: RuntimeCall[] = [];
    const { registry } = setup(calls);
    const installationId = await installReadAndSendPlugin(registry);
    registry.grantTool(installationId, { toolId: "request", botId: "bot-1", principalId: "bot:bot-1", audienceId: "bot:bot-1", epoch: 0 });
    const mcp = createPluginsMcp({ registry, origin: "http://127.0.0.1:1234", identity: () => ({
      principalId: "qq-member", audienceId: "qq-group", autoGrant: false,
    }) });
    for (const name of ["plugin_eac_library__search", "plugin_eac_library__request"]) {
      const result = await mcp.handle({ method: "tools/call", params: { name, arguments: {} } }, { botId: "bot-1", threadId: "group-thread" }, () => {}) as { isError: boolean };
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("uses an owner-issued platform grant only for its sender and audience", async () => {
    const calls: RuntimeCall[] = [];
    const { registry } = setup(calls);
    const installationId = await installReadAndSendPlugin(registry);
    const grant = registry.grantTool(installationId, {
      toolId: "search", botId: "bot-1", principalId: "qq-member", audienceId: "qq-group", epoch: 0,
    });
    const mcp = createPluginsMcp({ registry, origin: "http://127.0.0.1:1234", identity: ({ threadId }) => ({
      principalId: "qq-member", audienceId: threadId, autoGrant: false,
    }) });
    const call = (threadId: string) => mcp.handle({ method: "tools/call", params: {
      name: "plugin_eac_library__search", arguments: {},
    } }, { botId: "bot-1", threadId }, () => {}) as Promise<{ isError: boolean }>;
    expect((await call("qq-group")).isError).toBe(false);
    expect((await call("other-group")).isError).toBe(true);
    registry.removeGrant(installationId, grant.grantId);
    expect((await call("qq-group")).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("keeps mounted tool names within the MCP limit for a long plugin id", () => {
    const long = "eac.averyveryverylongpluginnamespace.superduperplugin";
    const name = pluginsToolName(long, "search-things");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^plugin_/);
    expect(name.endsWith("__search-things")).toBe(true);
    expect(pluginsToolName("eac.library", "search")).toBe("plugin_eac_library__search");
  });

  it("exposes the mount under the one server name turns attach", () => {
    expect(PLUGINS_MCP_SERVER).toBe("eac-plugins");
  });
});
