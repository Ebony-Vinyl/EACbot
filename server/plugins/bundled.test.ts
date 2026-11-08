// The bundled plugins under plugins/eac: every manifest must parse for this host, every process must complete its
// handshake, and one tool per plugin must actually run (locally, or against a fake server the plugin is pointed at).
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { parsePluginManifest } from "../../shared/plugins/manifest.ts";
import { PluginInstallStore } from "./store.ts";
import { PluginRegistry } from "./registry.ts";
import { StdioPluginSupervisor } from "./supervisor.ts";
import { installLocalPlugin } from "./local-install.ts";

const PACK_ROOT = join(import.meta.dirname, "..", "..", "plugins", "eac");
const PACKS = ["bilibili", "douyin", "health", "home-assistant", "muse", "tieba", "xianyu", "xiaohongshu"];

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

let fake: { server: ReturnType<typeof createServer>; url: string; seen: string[] };
beforeAll(async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/states") res.end(JSON.stringify([{ entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen" } }]));
    else if (req.url?.includes("/api/services")) res.end(JSON.stringify([{ domain: "light", services: { turn_off: {} } }]));
    else res.end(JSON.stringify({ data: { lists: [{ FileHash: "abc", SongName: "Test Song", SingerName: "Tester", Duration: 180, PayType: 0, AlbumID: "1" }] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake = { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
});
afterAll(async () => {
  fake.server.closeAllConnections();
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

describe("bundled plugins", () => {
  it("ships a valid manifest for this host", () => {
    for (const pack of PACKS) {
      const parsed = parsePluginManifest(JSON.parse(readFileSync(join(PACK_ROOT, pack, "eac-plugin.json"), "utf8")));
      expect(parsed.ok, `${pack}: ${parsed.ok ? "" : parsed.issues.join("; ")}`).toBe(true);
    }
  });

  it("runs one real tool call per plugin", { timeout: 180_000 }, async () => {
    for (const pack of PACKS) {
      const folder = mkdtempSync(join(tmpdir(), `eac-bundled-${pack}-`));
      folders.push(folder);
      const supervisor = new StdioPluginSupervisor({ dataDir: folder });
      try {
        const registry = new PluginRegistry(new PluginInstallStore(folder), {
          hostVersion: "0.1.146", host: "server", platform: "win32-x64", runtime: supervisor,
        });
        const installed = installLocalPlugin(registry, join(PACK_ROOT, pack));
        // The plugin's work directory is where it reads config.json and keeps its state.
        const runtimeDir = join(folder, "plugins", "runtime", installed.installationId);
        mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        const config = configFor(pack, fake.url);
        if (Object.keys(config).length) {
          writeFileSync(join(runtimeDir, "config.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
        }
        await registry.activate(installed.installationId);
        const record = registry.store.get(installed.installationId)!;
        expect(record.state, `${pack} activation state`).toBe("active");
        const tools = registry.tools(installed.installationId);
        expect(tools.length, `${pack} exposes tools`).toBeGreaterThan(0);
        const tool = toolFor(pack);
        const result = await registry.callTool(installed.installationId, tool.id, {
          botId: "bot-1", principalId: "principal-1", audienceId: "audience-1", epoch: 0,
          args: tool.args, grant: grantFor(registry, installed.installationId, tool.id),
        });
        expect(result.status, `${pack} ${tool.id} result: ${JSON.stringify(result).slice(0, 300)}`).toBe("succeeded");
        await registry.deactivate(installed.installationId);
      } finally {
        await supervisor.stopAll().catch(() => {});
        supervisor.dispose();
      }
    }
    expect(fake.seen.some((row) => row.startsWith("GET /api/states"))).toBe(true);
    expect(fake.seen.some((row) => row.includes("song/search") || row.includes("search/type"))).toBe(true);
  });
});

function configFor(pack: string, fakeUrl: string): Record<string, string> {
  if (pack === "home-assistant") return { baseUrl: fakeUrl, token: "test-token" };
  if (pack === "bilibili") return { apiBase: fakeUrl, cookie: "SESSDATA=x; bili_jct=csrf123" };
  if (pack === "muse") return { apiBase: fakeUrl };
  if (pack === "tieba") return { apiBase: fakeUrl, cookie: "TIEBA_USERTYPE=test", tbs: "tbs123" };
  if (pack === "xianyu") return { cookie: "_m_h5_tk=abc_123; unb=77" };
  return {};
}

/** One tool per plugin: local, or pointed at the fake server by config. */
function toolFor(pack: string): { id: string; args: Record<string, unknown> } {
  switch (pack) {
    case "health": return { id: "health-record-add", args: { metric: "steps", value: 6000 } };
    case "home-assistant": return { id: "ha-get-states", args: { domain: "light" } };
    case "muse": return { id: "muse-search", args: { keyword: "test" } };
    case "douyin": return { id: "dy-idea", args: { action: "add", title: "测试选题" } };
    case "xiaohongshu": return { id: "xhs-idea", args: { action: "add", title: "测试选题" } };
    case "tieba": return { id: "tieba-reply-draft", args: { action: "save", threadId: "1234567890", text: "草稿" } };
    case "xianyu": return { id: "xy-kb-add", args: { question: "包邮吗", answer: "包邮" } };
    case "bilibili": return { id: "bili-search-videos", args: { keyword: "test" } };
    default: throw new Error(`no tool mapped for ${pack}`);
  }
}

function grantFor(registry: PluginRegistry, installationId: string, toolId: string) {
  const tool = registry.tools(installationId).find((candidate) => candidate.id === toolId)!;
  const record = registry.store.get(installationId)!;
  const permission = record.manifest.permissions.find((candidate) => candidate.id === tool.permission)!;
  return {
    grantId: "grant_test", installationId, botId: "bot-1", principalId: "principal-1", audienceId: "audience-1",
    permissionId: permission.id, effect: permission.effect,
    resources: {}, createdAt: new Date().toISOString(), epoch: 0, maxUses: 10, uses: 0,
  };
}
