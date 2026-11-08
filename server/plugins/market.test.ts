import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, manifestDigest } from "./manifest-digest.ts";
import { manifestInput } from "./test-fixtures.ts";
import { PluginInstallStore } from "./store.ts";
import { PluginRegistry } from "./registry.ts";
import { PluginChannelStore } from "./channel-store.ts";
import { PluginMarketService } from "./market.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const now = new Date("2026-11-08T00:00:00.000Z");

async function packageArtifact(version: string) {
  const root = mkdtempSync(join(tmpdir(), `eac-market-${version}-`));
  folders.push(root);
  const source = join(root, "pkg");
  mkdirSync(source);
  const manifest = manifestInput({ version });
  writeFileSync(join(source, "eac-plugin.json"), JSON.stringify(manifest));
  writeFileSync(join(source, "server.mjs"), "process.stdin.resume();");
  const file = join(root, "artifact.tgz");
  await tar.c({ gzip: true, file, cwd: root }, ["pkg"]);
  const bytes = readFileSync(file);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    manifestDigest: manifestDigest(manifest),
    url: `https://plugins.example.com/eac-test-${version}.tgz`,
  };
}

function catalogPayload(sequence: number, entries: unknown[], revoked: unknown[] = []) {
  return {
    schemaVersion: 1,
    sourceId: "community",
    sequence,
    issuedAt: "2026-11-07T23:00:00.000Z",
    expiresAt: "2026-11-09T00:00:00.000Z",
    entries,
    revoked,
  };
}

function signed(payload: unknown) {
  return {
    schemaVersion: 1,
    keyId: "community-key",
    algorithm: "ed25519",
    payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64url"),
  };
}

function entry(version: string, artifact: Awaited<ReturnType<typeof packageArtifact>>) {
  return {
    pluginId: "eac.test",
    version,
    manifestDigest: artifact.manifestDigest,
    sourceRevision: "b".repeat(40),
    title: "Test plugin",
    artifacts: [{ platform: "win32-x64", url: artifact.url, sha256: artifact.sha256, size: artifact.bytes.length }],
    review: { tier: "community", checkedAt: "2026-11-07T23:00:00.000Z" },
  };
}

async function setup(payload: unknown, payloads: Map<string, Uint8Array>) {
  const folder = mkdtempSync(join(tmpdir(), "eac-market-service-"));
  folders.push(folder);
  const store = new PluginInstallStore(folder);
  const registry = new PluginRegistry(store, { hostVersion: "0.1.146", host: "server", platform: "win32-x64" });
  const channels = new PluginChannelStore(folder);
  const channel = channels.add({
    sourceId: "community", name: "Community", url: "https://plugins.example.com/catalog.json",
    keyId: "community-key", publicKeyPem: pem,
  });
  let current = signed(payload);
  const fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url === channel.url) return new Response(JSON.stringify(current), { status: 200, headers: { "content-type": "application/json" } });
    const bytes = payloads.get(url);
    return bytes
      ? new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } })
      : new Response("missing", { status: 404 });
  };
  const market = new PluginMarketService({ dataDir: folder, registry, channels, platform: "win32-x64", now: () => now, fetch });
  return { folder, store, registry, channels, market, refreshWith: (next: unknown) => { current = signed(next); } };
}

describe("plugin market", () => {
  it("refreshes, installs, updates and rolls back a signed catalog entry", async () => {
    const v1 = await packageArtifact("1.0.0");
    const v2 = await packageArtifact("2.0.0");
    const payload = catalogPayload(1, [entry("1.0.0", v1), entry("2.0.0", v2)]);
    const files = new Map([[v1.url, v1.bytes], [v2.url, v2.bytes]]);
    const { market, refreshWith } = await setup(payload, files);
    expect(await market.refresh("community")).toMatchObject({ ok: true });
    expect(market.catalog()).toMatchObject([{ pluginId: "eac.test", version: "1.0.0", installed: null }, { pluginId: "eac.test", version: "2.0.0", installed: null }]);

    const installed = await market.install({ sourceId: "community", pluginId: "eac.test", version: "1.0.0" });
    expect(installed).toMatchObject({ version: "1.0.0", state: "installed-disabled" });
    expect(market.catalog().find((item) => item.version === "1.0.0")?.installed).toMatchObject({ version: "1.0.0" });

    refreshWith(catalogPayload(2, [entry("1.0.0", v1), entry("2.0.0", v2)]));
    await market.refresh("community");
    const updated = await market.update(installed.installationId);
    expect(updated).toMatchObject({ version: "2.0.0", state: "installed-disabled" });
    expect(await market.rollback(installed.installationId)).toMatchObject({ version: "1.0.0", state: "installed-disabled" });
  });

  it("refuses a revoked version", async () => {
    const v1 = await packageArtifact("1.0.0");
    const payload = catalogPayload(1, [entry("1.0.0", v1)], [{ pluginId: "eac.test", version: "1.0.0", reason: "withdrawn", revokedAt: "2026-11-07T23:30:00.000Z" }]);
    const { market } = await setup(payload, new Map([[v1.url, v1.bytes]]));
    await market.refresh("community");
    await expect(market.install({ sourceId: "community", pluginId: "eac.test", version: "1.0.0" })).rejects.toMatchObject({ code: "revoked" });
  });

  it("refuses a platform without an artifact", async () => {
    const v1 = await packageArtifact("1.0.0");
    const { market } = await setup(catalogPayload(1, [entry("1.0.0", v1)]), new Map([[v1.url, v1.bytes]]));
    await market.refresh("community");
    await expect(market.install({ sourceId: "community", pluginId: "eac.test", version: "1.0.0", platform: "linux-x64" })).rejects.toMatchObject({ code: "platform-unsupported" });
  });

  it("refuses an artifact whose manifest does not match the catalog", async () => {
    const v1 = await packageArtifact("1.0.0");
    const bad = entry("1.0.0", v1);
    bad.manifestDigest = `sha256:${"d".repeat(64)}`;
    const { market } = await setup(catalogPayload(1, [bad]), new Map([[v1.url, v1.bytes]]));
    await market.refresh("community");
    await expect(market.install({ sourceId: "community", pluginId: "eac.test", version: "1.0.0" })).rejects.toMatchObject({ code: "identity" });
  });
});
