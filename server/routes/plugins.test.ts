import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { PluginInstallStore } from "../plugins/store.ts";
import { PluginRegistry } from "../plugins/registry.ts";
import { PluginChannelStore } from "../plugins/channel-store.ts";
import { PluginMarketService } from "../plugins/market.ts";
import { manifest, manifestInput } from "../plugins/test-fixtures.ts";
import { createPluginRoutes } from "./plugins.ts";
import { dispatchRoutes } from "./table.ts";

const owner = { kind: "session", session: { id: "s1" }, via: "bearer", scopes: ["admin", "client"] } as unknown as RequestAuth;
const client = { ...owner, scopes: ["client"] } as unknown as RequestAuth;
const folders: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function serve() {
  const folder = mkdtempSync(join(tmpdir(), "eac-plugin-routes-"));
  folders.push(folder);
  let nextId = 0;
  const store = new PluginInstallStore(folder, { installationId: () => `plg_${++nextId}` });
  const registry = new PluginRegistry(store, { hostVersion: "0.1.146", host: "server", platform: "win32-x64" });
  const installed = registry.install(manifest(), "community");
  const channels = new PluginChannelStore(folder);
  const market = new PluginMarketService({ dataDir: folder, registry, channels, platform: "win32-x64" });
  const route = createPluginRoutes({ registry, channels, market, mayManage: (auth) => auth.kind === "loopback" || auth.scopes.includes("admin") });
  let auth = owner;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "next route" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, registry, installed, setAuth: (next: RequestAuth) => { auth = next; } };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("/api/plugins", () => {
  it("is owner/admin only and defaults to the admin scope", async () => {
    const { base, setAuth } = await serve();
    setAuth(client);
    expect((await call(base, "GET", "/api/plugins")).status).toBe(403);
    expect(requiredScope("GET", "/api/plugins")).toBe("admin");
    expect(requiredScope("POST", "/api/plugins/plg_1/activate")).toBe("admin");
  });

  it("lists, activates, disables, revokes and removes an installation", async () => {
    const { base, installed } = await serve();
    const listed = await call(base, "GET", "/api/plugins");
    expect(listed.status).toBe(200);
    expect(listed.body.plugins).toMatchObject([{ installationId: installed.installationId, state: "installed-disabled" }]);

    const activated = await call(base, "POST", `/api/plugins/${installed.installationId}/activate`);
    expect(activated.status).toBe(200);
    expect(activated.body.plugin).toMatchObject({ state: "active" });

    const disabled = await call(base, "POST", `/api/plugins/${installed.installationId}/disable`);
    expect(disabled.body.plugin).toMatchObject({ state: "disabled" });

    const revoked = await call(base, "POST", `/api/plugins/${installed.installationId}/revoke`);
    expect(revoked.body.plugin).toMatchObject({ state: "revoked" });

    expect((await call(base, "DELETE", `/api/plugins/${installed.installationId}`)).status).toBe(200);
    expect((await call(base, "GET", "/api/plugins")).body.plugins).toEqual([]);
  });

  it("installs a local declarative package disabled and exposes it to the next request", async () => {
    const { base } = await serve();
    const packageDir = mkdtempSync(join(tmpdir(), "eac-plugin-local-route-"));
    folders.push(packageDir);
    writeFileSync(join(packageDir, "eac-plugin.json"), JSON.stringify(manifestInput({ pluginId: "eac.local" })));
    const installed = await call(base, "POST", "/api/plugins/local", { path: packageDir });
    expect(installed.status).toBe(200);
    expect(installed.body.plugin).toMatchObject({ pluginId: "eac.local", state: "installed-disabled" });
    const activated = await call(base, "POST", `/api/plugins/${(installed.body.plugin as { installationId: string }).installationId}/activate`);
    expect(activated.status).toBe(200);
    expect(activated.body.plugin).not.toHaveProperty("packageDir");
    expect(activated.body.plugin).not.toHaveProperty("manifest");
    expect(activated.body.plugin).not.toHaveProperty("grants");
    expect((await call(base, "GET", "/api/plugins")).body.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ pluginId: "eac.local" })]),
    );
  });

  it("does not claim success for a process plugin without a runtime", async () => {
    const { base, registry } = await serve();
    const processManifest = manifest({ pluginId: "eac.process", runtime: { mode: "process", entry: "server.mjs", isolation: "required" } });
    const installed = registry.install(processManifest, "community");
    const activated = await call(base, "POST", `/api/plugins/${installed.installationId}/activate`);
    expect(activated.status).toBe(409);
    expect(activated.body).toMatchObject({ code: "runtime-unavailable" });
  });

  it("leaves non-plugin paths to the next route", async () => {
    const { base } = await serve();
    expect(await (await fetch(`${base}/api/not-plugins`)).json()).toEqual({ from: "next route" });
  });
});
