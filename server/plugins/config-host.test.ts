// The config host against a real package on disk and a fake plugin process: the file lands where the plugin reads it,
// a secret is never read back out, and status needs no grant.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginConfigHost, pluginWorkDir } from "./config-host.ts";
import { PluginInstallStore } from "./store.ts";
import { manifest as baseManifest } from "./test-fixtures.ts";

/** The shared test manifest declares no configuration; these cases need the field the host reads. */
const manifest = (patch: Parameters<typeof baseManifest>[0] = {}) =>
  baseManifest({ configSchema: "config.schema.json", ...patch });

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fixture(options: { schema?: unknown; state?: "active" | "installed-disabled" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "eac-plugin-config-"));
  folders.push(root);
  const packageDir = join(root, "package");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "entry.mjs"), "process.stdin.resume();\n");
  writeFileSync(join(packageDir, "config.schema.json"), `${JSON.stringify(options.schema ?? {
    type: "object",
    properties: {
      url: { type: "string" },
      token: { type: "string", secret: true },
      retries: { type: "number" },
    },
    required: ["url"],
    additionalProperties: false,
  })}\n`);
  const store = new PluginInstallStore(root);
  const record = store.install(manifest({ pluginId: "eac.config-test", runtime: { mode: "process", entry: "entry.mjs", isolation: "none" } }), { sourceId: "local", packageDir });
  if (options.state === "active") {
    store.setState(record.installationId, "starting");
    store.setState(record.installationId, "active");
  }
  return { root, store, record, current: () => store.get(record.installationId)! };
}

describe("plugin configuration", () => {
  it("reads an empty config before anything is written, and names what is missing", () => {
    const { current } = fixture();
    const host = createPluginConfigHost({ dataDir: folders[0]! });
    const view = host.read(current());
    expect(view.values).toEqual({});
    expect(view.missing).toEqual(["url"]);
    expect(view.fields.map((field) => field.key)).toEqual(["url", "token", "retries"]);
  });

  it("writes the file the plugin process will read, owner-only", () => {
    const { current, root } = fixture();
    const host = createPluginConfigHost({ dataDir: root });
    const record = current();
    host.write(record, { url: "ws://127.0.0.1:3001", token: "abc", retries: "5" });
    const file = join(pluginWorkDir(root, record.installationId), "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: "ws://127.0.0.1:3001", token: "abc", retries: 5 });
  });

  it("never returns a stored secret", () => {
    const { current, root } = fixture();
    const host = createPluginConfigHost({ dataDir: root });
    const record = current();
    host.write(record, { url: "ws://x", token: "treasure" });
    const view = host.read(current());
    expect(view.values.token).toEqual({ set: true });
    expect(JSON.stringify(view)).not.toContain("treasure");
  });

  it("keeps the stored secret when the form submits an empty box", () => {
    const { current, root } = fixture();
    const host = createPluginConfigHost({ dataDir: root });
    const record = current();
    host.write(record, { url: "ws://old", token: "keep-me" });
    host.write(current(), { url: "ws://new", token: "" });
    const file = join(pluginWorkDir(root, record.installationId), "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: "ws://new", token: "keep-me" });
  });

  it("refuses a write missing a required field, and leaves the file untouched", () => {
    const { current, root } = fixture();
    const host = createPluginConfigHost({ dataDir: root });
    const record = current();
    host.write(record, { url: "ws://keep" });
    expect(() => host.write(current(), { url: "" })).toThrow(/url is required/);
    const file = join(pluginWorkDir(root, record.installationId), "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: "ws://keep" });
  });

  it("refuses a plugin that declares no schema", () => {
    const root = mkdtempSync(join(tmpdir(), "eac-plugin-config-noschema-"));
    folders.push(root);
    const packageDir = join(root, "package");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "entry.mjs"), "process.stdin.resume();\n");
    const store = new PluginInstallStore(root);
    const record = store.install(baseManifest({ pluginId: "eac.no-schema", runtime: { mode: "process", entry: "entry.mjs", isolation: "none" } }), { sourceId: "local", packageDir });
    const host = createPluginConfigHost({ dataDir: root });
    expect(() => host.read(record)).toThrow(/declares no configuration/);
  });

  it("says a restart is needed only while the plugin is running", () => {
    const idle = fixture();
    const idleHost = createPluginConfigHost({ dataDir: idle.root, isRunning: () => false });
    expect(idleHost.write(idle.current(), { url: "ws://x" }).restartRequired).toBe(false);
    expect(idleHost.write(idle.current(), { url: "ws://x", retries: 1 }).restartRequired).toBe(false);

    const live = fixture({ state: "active" });
    const liveHost = createPluginConfigHost({ dataDir: live.root, isRunning: () => true });
    expect(liveHost.write(live.current(), { url: "ws://y" }).restartRequired).toBe(true);
  });
});

describe("plugin status", () => {
  it("asks the running plugin for its own status", async () => {
    const { current, root } = fixture({ state: "active" });
    const asked: string[] = [];
    const host = createPluginConfigHost({
      dataDir: root,
      isRunning: () => true,
      call: async (_id, method) => {
        asked.push(method);
        return { connected: true, inboundQueued: 2, lastError: "" };
      },
    });
    const status = await host.status(current());
    expect(asked).toEqual(["status"]);
    expect(status.values).toEqual({ connected: true, inboundQueued: 2, lastError: "" });
    expect(status.error).toBeUndefined();
  });

  it("reports why a stopped plugin has no status instead of calling it healthy", async () => {
    const { current, root } = fixture();
    const host = createPluginConfigHost({ dataDir: root, isRunning: () => false, call: async () => { throw new Error("should not be called"); } });
    const status = await host.status(current());
    expect(status.values).toEqual({});
    expect(status.error).toMatch(/not running/);
  });

  it("reports a plugin that fails to answer instead of an empty success", async () => {
    const { current, root } = fixture({ state: "active" });
    const host = createPluginConfigHost({
      dataDir: root,
      isRunning: () => true,
      call: async () => { throw new Error("the plugin did not answer in time"); },
    });
    const status = await host.status(current());
    expect(status.error).toMatch(/did not answer/);
  });

  it("reports no runtime as a reason, not as a dead bridge", async () => {
    const { current, root } = fixture({ state: "active" });
    const status = await createPluginConfigHost({ dataDir: root }).status(current());
    expect(status.error).toMatch(/no plugin runtime/);
  });

  it("does not ask a declarative plugin for a process status", async () => {
    const root = mkdtempSync(join(tmpdir(), "eac-plugin-config-declarative-"));
    folders.push(root);
    const store = new PluginInstallStore(root);
    const record = store.install(manifest({ pluginId: "eac.declarative-status", runtime: { mode: "declarative" } }), { sourceId: "local" });
    const status = await createPluginConfigHost({ dataDir: root, isRunning: () => true, call: async () => ({}) }).status(record);
    expect(status.error).toMatch(/no process/);
  });
});
