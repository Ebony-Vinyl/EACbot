import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PluginInstallStore } from "./store.ts";
import { StdioPluginSupervisor } from "./supervisor.ts";
import { manifest } from "./test-fixtures.ts";

const folders: string[] = [];
const supervisors: StdioPluginSupervisor[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.stopAll();
    supervisor.dispose();
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const APPROVED = `
process.stdin.setEncoding("utf8");
let buffer = "";
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === "initialize") send(message.id, { ok: true, apiVersion: "1.0.0" });
    if (message.method === "shutdown") { send(message.id, { ok: true }); process.exit(0); }
  }
});
`;

function recordScript(script: string) {
  const folder = mkdtempSync(join(tmpdir(), "eac-plugin-supervisor-"));
  folders.push(folder);
  writeFileSync(join(folder, "server.mjs"), script);
  const store = new PluginInstallStore(join(folder, "data"));
  const installed = store.install(manifest({
    pluginId: "eac.process-test",
    runtime: { mode: "process", entry: "server.mjs", isolation: "none" },
  }), { sourceId: "local", packageDir: folder });
  return { folder, record: installed };
}

function supervisor() {
  const folder = mkdtempSync(join(tmpdir(), "eac-plugin-supervisor-data-"));
  folders.push(folder);
  const created = new StdioPluginSupervisor({ dataDir: folder, startTimeoutMs: 1_000, stopTimeoutMs: 200 });
  supervisors.push(created);
  return created;
}

describe("stdio plugin supervisor", () => {
  it("performs the initialize handshake and stops on shutdown", async () => {
    const { record } = recordScript(APPROVED);
    const runtime = supervisor();
    expect(await runtime.start(record)).toEqual({ ok: true });
    expect(runtime.activeCount()).toBe(1);
    await runtime.stop(record);
    expect(runtime.activeCount()).toBe(0);
  });

  it("carries a tool call over the same stdio session", async () => {
    const { record } = recordScript(`
      process.stdin.setEncoding("utf8");
      let buffer = "";
      const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\\n");
          if (newline < 0) break;
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.method === "initialize") send(message.id, { ok: true });
          if (message.method === "tools/call") send(message.id, { status: "succeeded", value: message.params.arguments });
          if (message.method === "shutdown") { send(message.id, { ok: true }); process.exit(0); }
        }
      });
    `);
    const runtime = supervisor();
    expect(await runtime.start(record)).toEqual({ ok: true });
    await expect(runtime.call(record.installationId, "tools/call", { toolId: "ping", arguments: { text: "hi" } }))
      .resolves.toEqual({ status: "succeeded", value: { text: "hi" } });
    await expect(runtime.call(record.installationId, "tools/slow", {}, 50)).rejects.toThrow(/in time/);
    await runtime.stop(record);
  });

  it("does not pass the server's environment secrets into the child", async () => {
    const { record } = recordScript(`
      if (process.env.EAC_TEST_SECRET) process.exit(9);
      ${APPROVED}
    `);
    const previous = process.env.EAC_TEST_SECRET;
    process.env.EAC_TEST_SECRET = "must-not-cross";
    try {
      const runtime = supervisor();
      expect(await runtime.start(record)).toEqual({ ok: true });
      await runtime.stop(record);
    } finally {
      if (previous === undefined) delete process.env.EAC_TEST_SECRET;
      else process.env.EAC_TEST_SECRET = previous;
    }
  });

  it("reports an unexpected exit after a successful handshake", async () => {
    const { record } = recordScript(`
      process.stdin.setEncoding("utf8");
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\\n");
        if (newline < 0) return;
        const message = JSON.parse(buffer.slice(0, newline));
        if (message.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n");
          setTimeout(() => process.exit(3), 30);
        }
      });
      process.stdin.resume();
    `);
    const folder = mkdtempSync(join(tmpdir(), "eac-plugin-supervisor-exit-"));
    folders.push(folder);
    const exits: string[] = [];
    const runtime = new StdioPluginSupervisor({ dataDir: folder, onExit: (_id, reason) => exits.push(reason) });
    supervisors.push(runtime);
    expect(await runtime.start(record)).toEqual({ ok: true });
    for (let attempt = 0; attempt < 50 && exits.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exits).toHaveLength(1);
    expect(runtime.isRunning(record.installationId)).toBe(false);
  });

  it("refuses a timeout and a plugin that exits during its handshake", async () => {
    const { record } = recordScript("process.stdin.resume();");
    const runtime = supervisor();
    expect(await runtime.start(record)).toMatchObject({ ok: false });
    expect(runtime.activeCount()).toBe(0);

    const { record: exits } = recordScript("process.exit(2);");
    expect(await runtime.start(exits)).toMatchObject({ ok: false, error: expect.stringMatching(/exited|closed/) });
  });

  it("refuses required isolation, a missing package directory and a non-process runtime", async () => {
    const runtime = supervisor();
    const { record } = recordScript(APPROVED);
    expect(await runtime.start({ ...record, manifest: manifest({
      pluginId: "eac.process-required",
      runtime: { mode: "process", entry: "server.mjs", isolation: "required" },
    }) })).toMatchObject({ ok: false, error: expect.stringMatching(/isolation/) });
    expect(await runtime.start({ ...record, packageDir: undefined })).toMatchObject({ ok: false, error: expect.stringMatching(/package/) });
    expect(await runtime.start({ ...record, manifest: manifest({ pluginId: "eac.declarative" }) })).toMatchObject({ ok: false, error: expect.stringMatching(/not a process/) });
  });

  it("kills a plugin that ignores shutdown", async () => {
    const { record } = recordScript(`
      process.stdin.setEncoding("utf8");
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\\n");
          if (newline < 0) break;
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n");
          }
        }
      });
      process.stdin.resume();
    `);
    const runtime = supervisor();
    expect(await runtime.start(record)).toEqual({ ok: true });
    await runtime.stop(record);
    expect(runtime.activeCount()).toBe(0);
  });
});
