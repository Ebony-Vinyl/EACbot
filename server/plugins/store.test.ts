import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PluginInstallStore, PluginStoreError } from "./store.ts";
import { grant, manifest } from "./test-fixtures.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function store(options: { now?: () => string; installationId?: () => string } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "eac-plugin-store-"));
  folders.push(folder);
  return { folder, store: new PluginInstallStore(folder, options) };
}

describe("plugin installation store", () => {
  it("installs disabled, persists the pinned manifest and reloads it", () => {
    const { folder, store: first } = store({ installationId: () => "plg_fixed" });
    const installed = first.install(manifest(), { sourceId: "community" });
    expect(installed).toMatchObject({ installationId: "plg_fixed", state: "installed-disabled", grants: [] });
    expect(installed.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const second = new PluginInstallStore(folder);
    expect(second.list()).toMatchObject([{ installationId: "plg_fixed", pluginId: "eac.test", state: "installed-disabled" }]);
    expect(readFileSync(join(folder, "plugins", "index.json"), "utf8")).not.toContain("undefined");
  });

  it("refuses a second installation of the same plugin id", () => {
    const { store: installs } = store();
    installs.install(manifest(), { sourceId: "community" });
    expect(() => installs.install(manifest(), { sourceId: "community" })).toThrow(PluginStoreError);
  });

  it("refuses a reused installation id even for a different plugin", () => {
    const { store: installs } = store({ installationId: () => "plg_fixed" });
    installs.install(manifest(), { sourceId: "community" });
    expect(() => installs.install(manifest({ pluginId: "eac.other" }), { sourceId: "community" })).toThrow(/already exists/);
  });

  it("enforces the lifecycle graph", () => {
    const { store: installs } = store({ installationId: () => "plg_1" });
    installs.install(manifest(), { sourceId: "community" });
    expect(() => installs.setState("plg_1", "active")).toThrow(/cannot move/);
    expect(installs.setState("plg_1", "starting").state).toBe("starting");
    expect(installs.setState("plg_1", "active").state).toBe("active");
    expect(() => installs.setState("plg_1", "disabled")).toThrow(/cannot move/);
    expect(installs.setState("plg_1", "stopping").state).toBe("stopping");
    expect(installs.setState("plg_1", "disabled").state).toBe("disabled");
  });

  it("refuses a grant whose effect or permission does not match the manifest", () => {
    const { store: installs } = store({ installationId: () => "plg_1" });
    installs.install(manifest(), { sourceId: "community" });
    expect(() => installs.addGrant("plg_1", grant("plg_1", { effect: "send" }))).toThrow(/effect/);
    expect(() => installs.addGrant("plg_1", grant("plg_1", { permissionId: "nope" }))).toThrow(/unknown permission/);
  });

  it("consumes and removes grants", () => {
    const { store: installs } = store({ installationId: () => "plg_1" });
    installs.install(manifest(), { sourceId: "community" });
    installs.addGrant("plg_1", grant("plg_1", { maxUses: 1 }));
    expect(installs.consumeGrant("plg_1", "grant-1").grants[0]!.uses).toBe(1);
    expect(() => installs.consumeGrant("plg_1", "grant-1")).toThrow(/no uses left/);
    expect(installs.removeGrant("plg_1", "grant-1").grants).toEqual([]);
  });

  it("updates to a new version, clears grants, and restores the previous version", () => {
    const { store: installs, folder } = store({ installationId: () => "plg_1" });
    installs.install(manifest(), { sourceId: "community" });
    installs.addGrant("plg_1", grant("plg_1"));
    const updated = installs.update("plg_1", manifest({ version: "2.0.0" }), { sourceId: "community" });
    expect(updated).toMatchObject({ version: "2.0.0", state: "installed-disabled", grants: [], previous: { version: "1.0.0" } });
    const reloaded = new PluginInstallStore(folder).get("plg_1");
    expect(reloaded).toMatchObject({ version: "2.0.0", previous: { version: "1.0.0" } });
    expect(installs.rollback("plg_1")).toMatchObject({ version: "1.0.0", state: "installed-disabled" });
    expect(installs.get("plg_1")!.previous).toBeUndefined();
  });

  it("revokes grants with the installation", () => {
    const { store: installs } = store({ installationId: () => "plg_1" });
    installs.install(manifest(), { sourceId: "community" });
    installs.addGrant("plg_1", grant("plg_1"));
    expect(installs.setState("plg_1", "revoked", "withdrawn").grants).toEqual([]);
  });

  it("does not silently reset a corrupt state file", () => {
    const { folder } = store();
    mkdirSync(join(folder, "plugins"));
    writeFileSync(join(folder, "plugins", "index.json"), "{\"schemaVersion\":1,\"installations\":");
    expect(() => new PluginInstallStore(folder).list()).toThrow(/not valid JSON/);
  });
});
