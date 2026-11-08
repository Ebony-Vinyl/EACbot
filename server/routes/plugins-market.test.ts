import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { canonicalJson, manifestDigest } from "../plugins/manifest-digest.ts";
import { manifestInput } from "../plugins/test-fixtures.ts";
import { PluginInstallStore } from "../plugins/store.ts";
import { PluginRegistry } from "../plugins/registry.ts";
import { PluginChannelStore } from "../plugins/channel-store.ts";
import { PluginMarketService } from "../plugins/market.ts";
import { createPluginRoutes } from "./plugins.ts";
import { dispatchRoutes } from "./table.ts";

const owner = { kind: "session", session: { id: "s1" }, via: "bearer", scopes: ["admin", "client"] } as unknown as RequestAuth;
const folders: string[] = [];
const servers: Server[] = [];
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function artifact() {
  const root = mkdtempSync(join(tmpdir(), "eac-market-route-"));
  folders.push(root);
  mkdirSync(join(root, "pkg"));
  const manifest = manifestInput({ version: "1.0.0" });
  writeFileSync(join(root, "pkg", "eac-plugin.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "pkg", "server.mjs"), "process.stdin.resume();");
  const file = join(root, "artifact.tgz");
  await tar.c({ gzip: true, file, cwd: root }, ["pkg"]);
  const bytes = readFileSync(file);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), manifestDigest: manifestDigest(manifest) };
}

describe("/api/plugins market", () => {
  it("adds a channel, refreshes a signed catalog and installs an artifact", async () => {
    const pkg = await artifact();
    const payload = {
      schemaVersion: 1, sourceId: "community", sequence: 1,
      issuedAt: "2026-11-07T23:00:00.000Z", expiresAt: "2026-11-09T00:00:00.000Z",
      entries: [{
        pluginId: "eac.test", version: "1.0.0", manifestDigest: pkg.manifestDigest, sourceRevision: "b".repeat(40),
        title: "Test plugin",
        artifacts: [{ platform: "win32-x64", url: "https://plugins.example.com/eac-test.tgz", sha256: pkg.sha256, size: pkg.bytes.length }],
        review: { tier: "community", checkedAt: "2026-11-07T23:00:00.000Z" },
      }],
      revoked: [],
    };
    const envelope = {
      schemaVersion: 1, keyId: "community-key", algorithm: "ed25519", payload,
      signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64url"),
    };
    const folder = mkdtempSync(join(tmpdir(), "eac-market-route-data-"));
    folders.push(folder);
    const registry = new PluginRegistry(new PluginInstallStore(folder), { hostVersion: "0.1.146", host: "server", platform: "win32-x64" });
    const channels = new PluginChannelStore(folder);
    const market = new PluginMarketService({
      dataDir: folder, registry, channels, platform: "win32-x64", now: () => new Date("2026-11-08T00:00:00.000Z"),
      fetch: async (input) => String(input) === "https://plugins.example.com/catalog.json"
        ? new Response(JSON.stringify(envelope), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(pkg.bytes, { status: 200, headers: { "content-length": String(pkg.bytes.length) } }),
    });
    const route = createPluginRoutes({ registry, channels, market, mayManage: () => true });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: owner, json, readBody });
      if (!handled) json(res, 404, { error: "not found" });
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(base + path, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as any };
    };

    expect(await call("POST", "/api/plugins/channels", {
      sourceId: "community", name: "Community", url: "https://plugins.example.com/catalog.json", keyId: "community-key", publicKeyPem: pem,
    })).toMatchObject({ status: 200 });
    const catalog = await call("GET", "/api/plugins/catalog?refresh=1");
    expect(catalog.status).toBe(200);
    expect(catalog.body.entries).toMatchObject([{ pluginId: "eac.test", version: "1.0.0", installed: null }]);
    const installed = await call("POST", "/api/plugins/install", { sourceId: "community", pluginId: "eac.test", version: "1.0.0" });
    expect(installed).toMatchObject({ status: 200, body: { plugin: { version: "1.0.0", state: "installed-disabled" } } });
    expect(installed.body.plugin).not.toHaveProperty("packageDir");
  });
});
