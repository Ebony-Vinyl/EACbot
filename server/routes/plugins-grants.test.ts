import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PluginInstallStore } from "../plugins/store.ts";
import { PluginRegistry } from "../plugins/registry.ts";
import { manifest } from "../plugins/test-fixtures.ts";
import { createPluginRoutes } from "./plugins.ts";
import { dispatchRoutes } from "./table.ts";

const owner = { kind: "session", session: { id: "s1" }, via: "bearer", scopes: ["admin", "client"] } as unknown as RequestAuth;
const folders: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function serve() {
  const folder = mkdtempSync(join(tmpdir(), "eac-plugin-grants-"));
  folders.push(folder);
  const call = vi.fn(async (): Promise<unknown> => ({ status: "succeeded", value: { pong: true } }));
  const runtime = { start: vi.fn(async () => ({ ok: true as const })), stop: vi.fn(async () => undefined), call };
  const store = new PluginInstallStore(folder);
  const registry = new PluginRegistry(store, { hostVersion: "0.1.146", host: "server", platform: "win32-x64", runtime });
  const installed = registry.install(manifest({
    contributes: { tools: [{ id: "ping", entry: "tools/ping.mjs", effect: "read", permission: "read-library", description: "Ping the plugin." }] },
  }), "community");
  const route = createPluginRoutes({
    registry,
    channels: undefined as never,
    market: undefined as never,
    mayManage: (auth) => auth.kind === "loopback" || auth.scopes.includes("admin"),
    botExists: (botId) => botId === "bot-1",
  });
  let auth = owner;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "next route" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, registry, installed };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("/api/plugins/:id/grants", () => {
  it("issues a grant for a tool, then a matching call runs and consumes it", async () => {
    const { base, installed } = await serve();
    const id = installed.installationId;
    expect((await call(base, "POST", `/api/plugins/${id}/activate`)).status).toBe(200);

    const granted = await call(base, "POST", `/api/plugins/${id}/grants`, {
      toolId: "ping", botId: "bot-1", principalId: "owner-1", audienceId: "private-owner-1",
      epoch: 1, maxUses: 2, resources: { accounts: ["music-1"] },
    });
    expect(granted.status).toBe(200);
    const grant = granted.body.grant as { grantId: string; permissionId: string; effect: string };
    expect(grant).toMatchObject({ permissionId: "read-library", effect: "read", epoch: 1, uses: 0, maxUses: 2 });
    expect((await call(base, "GET", `/api/plugins/${id}/grants`)).body.grants).toMatchObject([{ grantId: grant.grantId }]);

    const ran = await call(base, "POST", `/api/plugins/${id}/tools/ping/call`, {
      botId: "bot-1", principalId: "owner-1", audienceId: "private-owner-1", epoch: 1, accountId: "music-1", args: { text: "hi" },
    });
    expect(ran.status).toBe(200);
    expect(ran.body.result).toEqual({ status: "succeeded", value: { pong: true } });
    expect((await call(base, "GET", `/api/plugins/${id}/grants`)).body.grants).toMatchObject([{ grantId: grant.grantId, uses: 1 }]);

    expect((await call(base, "DELETE", `/api/plugins/${id}/grants/${grant.grantId}`)).status).toBe(200);
    const refused = await call(base, "POST", `/api/plugins/${id}/tools/ping/call`, {
      botId: "bot-1", principalId: "owner-1", audienceId: "private-owner-1", epoch: 1, args: {},
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "invalid-state", error: expect.stringContaining("NO_GRANT") });
  });

  it("refuses malformed grants, unknown bots and unknown tools", async () => {
    const { base, installed } = await serve();
    const id = installed.installationId;
    const base_body = { toolId: "ping", botId: "bot-1", principalId: "owner-1", audienceId: "private-owner-1", epoch: 1 };
    expect((await call(base, "POST", `/api/plugins/${id}/grants`, { ...base_body, botId: "bot-9" })).status).toBe(422);
    expect((await call(base, "POST", `/api/plugins/${id}/grants`, { ...base_body, epoch: -1 })).status).toBe(400);
    expect((await call(base, "POST", `/api/plugins/${id}/grants`, { ...base_body, expiresAt: "soon" })).status).toBe(400);
    expect((await call(base, "POST", `/api/plugins/${id}/grants`, { ...base_body, resources: { accounts: [""] } })).status).toBe(400);
    expect((await call(base, "POST", `/api/plugins/${id}/grants`, { ...base_body, toolId: "nope" })).status).toBe(404);
    expect((await call(base, "DELETE", `/api/plugins/${id}/grants/none`)).status).toBe(404);
  });
});
