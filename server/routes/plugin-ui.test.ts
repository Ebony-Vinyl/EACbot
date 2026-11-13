import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { PluginInstallStore } from "../plugins/store.ts";
import { PluginRegistry } from "../plugins/registry.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createPluginUiRoutes } from "./plugin-ui.ts";
import { dispatchRoutes } from "./table.ts";

const folders: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

it("authorizes generation and persists validated panels with revision checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "eac-plugin-ui-http-"));
  folders.push(root);
  const registry = new PluginRegistry(new PluginInstallStore(root), { hostVersion: "0.2.0", host: "server", platform: "win32-x64" });
  let output = JSON.stringify({ schemaVersion: 1, title: "Tasks", slot: "workspace", items: [{ type: "data", source: "tasks" }] });
  const route = createPluginUiRoutes({ registry, dataDir: root, mayManage: (auth) => auth.scopes.includes("admin"), generate: async () => output });
  const server = createServer((req, res) => {
    const auth = { kind: "loopback", scopes: req.headers.authorization === "owner" ? ["admin"] : ["client"] } as RequestAuth;
    const url = new URL(req.url!, "http://localhost");
    void dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method!, auth, json, readBody }).then((handled) => { if (!handled) json(res, 404, {}); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, method = "GET", body?: unknown, owner = true) => {
    const response = await fetch(base + path, { method, headers: { authorization: owner ? "owner" : "client", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  expect((await request("/api/plugins/ui", "GET", undefined, false)).status).toBe(403);
  const generated = await request("/api/plugins/ui/generate", "POST", { botId: "bot-a", prompt: "Show my tasks" });
  expect(generated.status).toBe(200);
  expect((await request("/api/plugins/ui/panels", "POST", { panelId: "my-panel", expectedRevision: 0, spec: generated.body.spec })).status).toBe(200);
  expect((await request("/api/plugins/ui")).body.saved).toHaveLength(1);
  expect((await request("/api/plugins/ui/panels", "POST", { panelId: "my-panel", expectedRevision: 0, spec: generated.body.spec })).status).toBe(409);
  output = JSON.stringify({ schemaVersion: 1, title: "Unsafe", slot: "workspace", items: [{ type: "data", source: "private-files" }] });
  expect((await request("/api/plugins/ui/generate", "POST", { botId: "bot-a", prompt: "Read private files" })).status).toBe(422);
});
