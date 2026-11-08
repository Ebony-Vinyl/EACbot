import { describe, expect, it } from "vitest";

import { isSafePackagePath, parsePluginManifest } from "./manifest.ts";

const base = () => ({
  schemaVersion: 1,
  pluginId: "eac.test",
  version: "1.0.0",
  apiVersion: "^1.0.0",
  name: "Test plugin",
  description: "A plugin used by contract tests.",
  publisher: "EAC Tests",
  license: "MIT",
  source: { repository: "https://github.com/example/eac-test", revision: "a".repeat(40) },
  compatibility: { hostVersion: "^0.1.0", hosts: ["server"], platforms: ["win32-x64"] },
  runtime: { mode: "declarative" },
  activation: ["manual"],
  permissions: [],
  contributes: {},
  stateVersion: 1,
});

describe("plugin manifest v1", () => {
  it("accepts a bounded declarative manifest", () => {
    expect(parsePluginManifest(base()).ok).toBe(true);
  });

  it("rejects unknown fields instead of silently ignoring a misspelled security field", () => {
    const parsed = parsePluginManifest({ ...base(), permisions: [] });
    expect(parsed).toMatchObject({ ok: false });
  });

  it("rejects duplicate permission ids", () => {
    const permission = { id: "read", capability: "music.library.read", effect: "read", scope: {}, reason: "read" };
    const parsed = parsePluginManifest({ ...base(), permissions: [permission, permission] });
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining("duplicate permission id") });
  });

  it("rejects package paths that can escape the package", () => {
    for (const path of ["../x", "/x", "a/../../x", "C:/x", "a\\b", "a//b", "./x", ""]) {
      expect(isSafePackagePath(path), path).toBe(false);
    }
    expect(isSafePackagePath("ui/panel.json")).toBe(true);
  });

  it("requires a pinned https source revision", () => {
    expect(parsePluginManifest({ ...base(), source: { repository: "http://example.com/x", revision: "a".repeat(40) } }).ok).toBe(false);
    expect(parsePluginManifest({ ...base(), source: { repository: "https://example.com/x", revision: "main" } }).ok).toBe(false);
  });

  it("does not let a tool use an effect the manifest did not declare", () => {
    const parsed = parsePluginManifest({
      ...base(),
      contributes: { tools: [{ id: "send", entry: "tools/send.json", effect: "send" }] },
    });
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining("undeclared effect") });
  });

  it("does not let a process plugin claim declarative isolation", () => {
    const parsed = parsePluginManifest({ ...base(), runtime: { mode: "process", entry: "server.mjs", isolation: "required" } });
    expect(parsed).toMatchObject({ ok: true });
    expect(parsePluginManifest({ ...base(), runtime: { mode: "process", isolation: "required" } }).ok).toBe(false);
  });

  it("bounds extension metadata", () => {
    let deep: unknown = "x";
    for (let index = 0; index < 8; index += 1) deep = { nested: deep };
    expect(parsePluginManifest({ ...base(), extensions: { deep } }).ok).toBe(false);
  });
});
