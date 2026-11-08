import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { manifestInput } from "./test-fixtures.ts";
import { installLocalPlugin, LocalInstallError, readLocalPluginPackage } from "./local-install.ts";
import { PluginInstallStore } from "./store.ts";
import { PluginRegistry } from "./registry.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function packageWith(manifest: unknown, files: Record<string, string> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "eac-plugin-package-"));
  folders.push(folder);
  writeFileSync(join(folder, "eac-plugin.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(folder, name, ".."), { recursive: true });
    writeFileSync(join(folder, name), text);
  }
  return folder;
}

function registry(folder: string) {
  const store = new PluginInstallStore(join(folder, "data"));
  return new PluginRegistry(store, { hostVersion: "0.1.146", host: "server", platform: "win32-x64" });
}

describe("local plugin packages", () => {
  it("reads a manifest and installs it disabled, keeping the path server-side", () => {
    const folder = packageWith(manifestInput({ configSchema: "config.schema.json" }), { "config.schema.json": "{}" });
    const installed = registry(folder);
    const summary = installLocalPlugin(installed, folder);
    expect(summary).toMatchObject({ pluginId: "eac.test", state: "installed-disabled" });
    expect(summary).not.toHaveProperty("packageDir");
    expect(installed.store.get(summary.installationId)!.packageDir).toBe(realpathSync(folder));
  });

  it("requires an absolute existing directory and a regular manifest", () => {
    expect(() => readLocalPluginPackage("relative/plugin")).toThrow(LocalInstallError);
    expect(() => readLocalPluginPackage(join(tmpdir(), "eac-no-such-plugin"))).toThrow(/does not exist/);
    const folder = mkdtempSync(join(tmpdir(), "eac-plugin-empty-"));
    folders.push(folder);
    expect(() => readLocalPluginPackage(folder)).toThrow(/no eac-plugin.json/);
  });

  it("allows a declared skill directory, while a missing file is still refused", () => {
    const folder = packageWith(manifestInput({ contributes: { skills: ["skills/example"] } }));
    mkdirSync(join(folder, "skills", "example"), { recursive: true });
    expect(readLocalPluginPackage(folder).manifest.contributes.skills).toEqual(["skills/example"]);
    expect(() => readLocalPluginPackage(packageWith(manifestInput({ contributes: { skills: ["skills/missing"] } })))).toThrow(/does not exist/);
  });

  it("refuses an intermediate link even when the final file exists", () => {
    const folder = packageWith(manifestInput({ configSchema: "linked/config.json" }));
    const outside = mkdtempSync(join(tmpdir(), "eac-plugin-outside-"));
    folders.push(outside);
    writeFileSync(join(outside, "config.json"), "{}");
    try {
      symlinkSync(outside, join(folder, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    expect(() => readLocalPluginPackage(folder)).toThrow(/runs through a link/);
  });

  it("refuses duplicate JSON keys before interpreting a manifest", () => {
    const folder = mkdtempSync(join(tmpdir(), "eac-plugin-duplicate-"));
    folders.push(folder);
    writeFileSync(join(folder, "eac-plugin.json"), '{"schemaVersion":1,"schemaVersion":1}');
    expect(() => readLocalPluginPackage(folder)).toThrow(/duplicate key/);
  });

  it("refuses a declared entry that is missing", () => {
    const folder = packageWith(manifestInput({ configSchema: "missing.json" }));
    expect(() => readLocalPluginPackage(folder)).toThrow(/missing\.json does not exist/);
  });

  it("refuses a package that already exists under the same plugin id", () => {
    const folder = packageWith(manifestInput());
    const installed = registry(folder);
    installLocalPlugin(installed, folder);
    expect(() => installLocalPlugin(installed, folder)).toThrow(/already installed/);
  });

  it("installs a process package disabled and still blocks activation without a supervisor", async () => {
    const folder = packageWith(manifestInput({
      pluginId: "eac.local-process",
      runtime: { mode: "process", entry: "server.mjs", isolation: "required" },
    }), { "server.mjs": "process.stdin.resume();" });
    const installed = registry(folder);
    const summary = installLocalPlugin(installed, folder);
    expect(summary.state).toBe("installed-disabled");
    expect(await installed.activate(summary.installationId)).toMatchObject({ ok: false, code: "runtime-unavailable" });
  });
});
