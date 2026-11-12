import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { createPluginConfigHost, pluginWorkDir } from "../plugins/config-host.ts";
import { dispatchRoutes } from "./table.ts";

const owner = { kind: "session", session: { id: "s1" }, via: "bearer", scopes: ["admin", "client"] } as unknown as RequestAuth;
const client = { ...owner, scopes: ["client"] } as unknown as RequestAuth;
const folders: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function serve(options: { withConfig?: boolean } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "eac-plugin-routes-"));
  folders.push(folder);
  let nextId = 0;
  const store = new PluginInstallStore(folder, { installationId: () => `plg_${++nextId}` });
  const registry = new PluginRegistry(store, { hostVersion: "0.1.146", host: "server", platform: "win32-x64" });
  const packageDir = join(folder, "package");
  if (options.withConfig) {
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "eac-plugin.json"), JSON.stringify(manifestInput({ configSchema: "config.schema.json" })));
    writeFileSync(join(packageDir, "config.schema.json"), JSON.stringify({
      type: "object",
      properties: { url: { type: "string" }, token: { type: "string", secret: true } },
      required: ["url"],
      additionalProperties: false,
    }));
  }
  const installed = options.withConfig
    ? registry.install(manifest({ configSchema: "config.schema.json" }), "community", { packageDir })
    : registry.install(manifest(), "community");
  const channels = new PluginChannelStore(folder);
  const market = new PluginMarketService({ dataDir: folder, registry, channels, platform: "win32-x64" });
  const config = options.withConfig ? createPluginConfigHost({ dataDir: folder }) : undefined;
  const route = createPluginRoutes({ registry, channels, market, mayManage: (auth) => auth.kind === "loopback" || auth.scopes.includes("admin"), ...(config ? { config } : {}) });
  let auth = owner;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "next route" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, registry, installed, folder, setAuth: (next: RequestAuth) => { auth = next; } };
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

  it("says which installations have a configuration to fill in", async () => {
    const plain = await serve();
    expect((await call(plain.base, "GET", "/api/plugins")).body.plugins).toMatchObject([{ configurable: false }]);
    const configurable = await serve({ withConfig: true });
    expect((await call(configurable.base, "GET", "/api/plugins")).body.plugins).toMatchObject([{ configurable: true }]);
  });

  it("serves and writes a plugin's configuration, never returning a stored secret", async () => {
    const { base, installed, folder } = await serve({ withConfig: true });
    const empty = await call(base, "GET", `/api/plugins/${installed.installationId}/config`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ missing: ["url"], values: {} });
    expect(empty.body.fields).toMatchObject([{ key: "url", type: "string" }, { key: "token", type: "string", secret: true }]);

    const saved = await call(base, "PUT", `/api/plugins/${installed.installationId}/config`, { url: "ws://127.0.0.1:3001", token: "hush" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ values: { url: "ws://127.0.0.1:3001", token: { set: true } }, missing: [] });
    expect(JSON.stringify(saved.body)).not.toContain("hush");

    // The secret survives a form that submits an empty box.
    const kept = await call(base, "PUT", `/api/plugins/${installed.installationId}/config`, { url: "ws://new", token: "" });
    expect(kept.body).toMatchObject({ values: { url: "ws://new", token: { set: true } } });
    const file = JSON.parse(readFileSync(join(pluginWorkDir(folder, installed.installationId), "config.json"), "utf8"));
    expect(file).toEqual({ url: "ws://new", token: "hush" });
  });

  it("refuses an unknown key and a missing required field with a readable reason", async () => {
    const { base, installed } = await serve({ withConfig: true });
    const unknown = await call(base, "PUT", `/api/plugins/${installed.installationId}/config`, { url: "ws://x", extra: 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/not a field/);
    const missing = await call(base, "PUT", `/api/plugins/${installed.installationId}/config`, { token: "x" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/url is required/);
  });

  it("reports a plugin with no schema as a conflict rather than an empty form", async () => {
    const { base, registry } = await serve({ withConfig: true });
    // A second installation in the same workspace, this one declaring no configuration.
    const plain = registry.install(manifest({ pluginId: "eac.no-config" }), "community");
    const answer = await call(base, "GET", `/api/plugins/${plain.installationId}/config`);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "no-schema" });
  });

  it("does not answer config or status for an unknown installation", async () => {
    const { base } = await serve({ withConfig: true });
    expect((await call(base, "GET", "/api/plugins/plg_missing/config")).status).toBe(404);
    expect((await call(base, "GET", "/api/plugins/plg_missing/status")).status).toBe(404);
  });

  it("reports a plugin that cannot describe itself as a reason, not as healthy", async () => {
    const { base, installed } = await serve({ withConfig: true });
    const answer = await call(base, "GET", `/api/plugins/${installed.installationId}/status`);
    expect(answer.status).toBe(200);
    expect(answer.body.status).toMatchObject({ values: {} });
    // The fixture manifest is declarative, so it has no process to ask; either way the answer is a reason, never silence.
    expect((answer.body.status as { error: string }).error).toMatch(/no process|not running|no plugin runtime/);
  });

  it("leaves non-plugin paths to the next route", async () => {
    const { base } = await serve();
    expect(await (await fetch(`${base}/api/not-plugins`)).json()).toEqual({ from: "next route" });
  });
});
