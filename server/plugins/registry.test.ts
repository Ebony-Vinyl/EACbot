import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PluginInstallStore } from "./store.ts";
import { PluginRegistry, PluginRegistryError, type PluginRegistryOptions } from "./registry.ts";
import { grant, manifest } from "./test-fixtures.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function setup(options: Partial<PluginRegistryOptions> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "eac-plugin-registry-"));
  folders.push(folder);
  const store = new PluginInstallStore(folder, { installationId: (() => {
    let index = 0;
    return () => `plg_${++index}`;
  })() });
  const registry = new PluginRegistry(store, {
    hostVersion: "0.1.146",
    host: "server",
    platform: "win32-x64",
    ...options,
  });
  return { folder, store, registry };
}

describe("plugin registry", () => {
  it("does not leave an unhandled rejection when a lifecycle call fails", async () => {
    const { registry } = setup();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await expect(registry.activate("plg_missing")).rejects.toThrow(/no plugin installation/);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toEqual([]);
  });

  it("installs disabled and activates a declarative plugin", async () => {
    const { registry } = setup();
    const installed = registry.install(manifest(), "community");
    expect(installed.state).toBe("installed-disabled");
    expect(await registry.activate(installed.installationId)).toMatchObject({ ok: true, record: { state: "active" } });
    expect((await registry.deactivate(installed.installationId)).state).toBe("disabled");
  });

  it("blocks process plugins until a real runtime supervisor is supplied", async () => {
    const processManifest = manifest({
      pluginId: "eac.process",
      runtime: { mode: "process", entry: "server.mjs", isolation: "required" },
    });
    const { registry } = setup();
    const installed = registry.install(processManifest, "community");
    expect(await registry.activate(installed.installationId)).toMatchObject({ ok: false, code: "runtime-unavailable", record: { state: "blocked" } });
    expect(await registry.activate(installed.installationId)).toMatchObject({ ok: false, code: "runtime-unavailable" });
  });

  it("blocks a missing required service and recovers after its provider is active", async () => {
    const { registry } = setup();
    const consumer = registry.install(manifest({ pluginId: "eac.consumer", requires: { "music.library": "^1.0.0" } }), "community");
    expect(await registry.activate(consumer.installationId)).toMatchObject({ ok: false, code: "dependency" });
    const provider = registry.install(manifest({ pluginId: "eac.provider", provides: { "music.library": "1.0.0" } }), "community");
    expect((await registry.activate(provider.installationId)).ok).toBe(true);
    expect((await registry.activate(consumer.installationId)).ok).toBe(true);
  });

  it("rejects a dependency cycle and duplicate service ownership", () => {
    const { registry } = setup();
    registry.install(manifest({ pluginId: "eac.a", provides: { "svc.a": "1.0.0" }, requires: { "svc.b": "^1.0.0" } }), "community");
    expect(() => registry.install(manifest({ pluginId: "eac.b", provides: { "svc.b": "1.0.0" }, requires: { "svc.a": "^1.0.0" } }), "community"))
      .toThrow(/cycle/);
    registry.install(manifest({ pluginId: "eac.c", provides: { "svc.c": "1.0.0" } }), "community");
    expect(() => registry.install(manifest({ pluginId: "eac.d", provides: { "svc.c": "1.0.0" } }), "community"))
      .toThrow(/already provided/);
  });

  it("refuses incompatible hosts, platforms and host-owned services", () => {
    const { registry } = setup();
    expect(() => registry.install(manifest({ compatibility: { hostVersion: "^2.0.0" } }), "community")).toThrow(PluginRegistryError);
    expect(() => registry.install(manifest({ pluginId: "eac.desktop", compatibility: { hosts: ["desktop"] } }), "community")).toThrow(/server host/);
    expect(() => registry.install(manifest({ pluginId: "eac.arm", compatibility: { platforms: ["linux-arm64"] } }), "community")).toThrow(/win32-x64/);
    expect(() => registry.install(manifest({ pluginId: "eac.host", provides: { "host.media": "1.0.0" } }), "community")).toThrow(/host/);
    expect(() => registry.install(manifest({ pluginId: "eac.api", apiVersion: "^2.0.0" }), "community")).toThrow(/plugin API/);
    expect(() => registry.install(manifest({
      pluginId: "eac.paths",
      permissions: [{ id: "read-library", capability: "music.library.read", effect: "read", scope: { paths: ["/tmp"] }, reason: "read" }],
    }), "community")).toThrow(/path and domain/);
  });

  it("authorizes only through an active installation and its exact grant", async () => {
    const { registry } = setup();
    const installed = registry.install(manifest(), "community");
    registry.store.addGrant(installed.installationId, grant(installed.installationId));
    const call = {
      installationId: installed.installationId,
      permissionId: "read-library",
      botId: "bot-1",
      principalId: "owner-1",
      audienceId: "private-owner-1",
      epoch: 1,
      now: "2026-11-07T01:00:00.000Z",
      accountId: "music-1",
    };
    expect(registry.authorize(call)).toMatchObject({ allowed: false, code: "PLUGIN_NOT_ACTIVE" });
    await registry.activate(installed.installationId);
    expect(registry.authorize(call)).toMatchObject({ allowed: true });
    expect(registry.authorizeAndConsume(call)).toMatchObject({ allowed: true });
    expect(registry.store.get(installed.installationId)!.grants[0]!.uses).toBe(1);
    await registry.revoke(installed.installationId, "test");
    expect(registry.authorize(call)).toMatchObject({ allowed: false, code: "PLUGIN_NOT_ACTIVE" });
  });

  it("marks an active process failed when its runtime reports a crash", async () => {
    const runtime = { async start() { return { ok: true as const }; }, async stop() {}, isRunning: () => false };
    const { registry } = setup({ runtime });
    const installed = registry.install(manifest({
      pluginId: "eac.process-crash",
      runtime: { mode: "process", entry: "server.mjs", isolation: "none" },
    }), "local");
    await registry.activate(installed.installationId);
    registry.markRuntimeFailure(installed.installationId, "the plugin exited (3)");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registry.get(installed.installationId)).toMatchObject({ state: "failed", stateReason: "the plugin exited (3)" });
  });

  it("serializes overlapping lifecycle calls for one installation", async () => {
    let starts = 0;
    const { registry } = setup({
      runtime: {
        async start() {
          starts += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ok: true as const };
        },
        async stop() {},
      },
    });
    const installed = registry.install(manifest({
      pluginId: "eac.process-overlap",
      runtime: { mode: "process", entry: "server.mjs", isolation: "none" },
    }), "local");
    const [first, second] = await Promise.all([
      registry.activate(installed.installationId),
      registry.activate(installed.installationId),
    ]);
    expect(first).toMatchObject({ ok: true, record: { state: "active" } });
    expect(second).toMatchObject({ ok: true, record: { state: "active" } });
    expect(starts).toBe(1);
  });

  it("restarts an active process plugin when the registry is reconstructed", async () => {
    let starts = 0;
    const runtime = {
      async start() { starts += 1; return { ok: true as const }; },
      async stop() {},
    };
    const { folder, registry } = setup({ runtime });
    const installed = registry.install(manifest({
      pluginId: "eac.process-restart",
      runtime: { mode: "process", entry: "server.mjs", isolation: "none" },
    }), "local");
    expect((await registry.activate(installed.installationId)).ok).toBe(true);
    expect(starts).toBe(1);
    const restarted = new PluginRegistry(new PluginInstallStore(folder), {
      hostVersion: "0.1.146", host: "server", platform: "win32-x64", runtime,
    });
    await restarted.reconcile();
    expect(starts).toBe(2);
    expect(restarted.get(installed.installationId)).toMatchObject({ state: "active" });
  });

  it("removes an active plugin without leaving it in the registry", async () => {
    const { registry } = setup();
    const installed = registry.install(manifest(), "community");
    await registry.activate(installed.installationId);
    expect((await registry.remove(installed.installationId)).pluginId).toBe("eac.test");
    expect(registry.list()).toEqual([]);
  });
});
