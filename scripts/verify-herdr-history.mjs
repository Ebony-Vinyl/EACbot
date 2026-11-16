import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discoverLocalComputer } from "../core/environments/local.ts";
import { createProductionTerminalService } from "../core/terminal/bootstrap.ts";
import { HerdrSessions } from "../core/herdr/sessions.ts";

const directory = mkdtempSync("/tmp/eac-herdr-history-");
const hc = process.env.EAC_HERDR_PROGRAM ?? "herdr-core";
for (const name of Object.keys(process.env)) if (!["PATH", "LANG", "SHELL", "TMPDIR"].includes(name)) delete process.env[name];
Object.assign(process.env, {
  HOME: directory, CODEX_HOME: join(directory, "codex"),
  XDG_CONFIG_HOME: join(directory, "config"), XDG_STATE_HOME: join(directory, "state"),
  XDG_CACHE_HOME: join(directory, "cache"), XDG_RUNTIME_DIR: directory,
  HC_SOCKET: join(directory, "hc.sock"), HC_SESSION: "herdr-history-fixture",
});
const cli = execFileSync("/bin/sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
const bin = join(directory, "bin");
mkdirSync(bin);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
writeFileSync(join(bin, "codex"), `#!/bin/sh
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY=localhost,127.0.0.1
export no_proxy=localhost,127.0.0.1
exec ${quote(cli)} "$@"
`, { mode: 0o700 });
process.env.PATH = `${bin}:${process.env.PATH}`;
mkdirSync(process.env.CODEX_HOME);
writeFileSync(join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "herdr-fixture-key" }));
let requests = 0;
const model = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  if (request.method !== "POST") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"models":[]}'); return; }
  requests++;
  const item = { id: `msg_${requests}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: body.includes("Second fixture turn") ? "HERDR_FIXTURE_REPLY_2" : "HERDR_FIXTURE_REPLY_1", annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `resp_${requests}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item] } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
writeFileSync(join(process.env.CODEX_HOME, "config.toml"), `model="gpt-6-sol"
model_provider="fixture"
approval_policy="on-request"
sandbox_mode="workspace-write"
[model_providers.fixture]
name="Fixture"
base_url="http://127.0.0.1:${model.address().port}/v1"
wire_api="responses"
requires_openai_auth=true
[projects.${JSON.stringify(realpathSync(directory))}]
trust_level="trusted"
`);
let composition;
let sessions;
let created;
try {
  const local = await discoverLocalComputer(process.env);
  composition = createProductionTerminalService({ environments: { get: id => id === "local" ? local : null }, refsPath: join(directory, "terminals.json") });
  sessions = new HerdrSessions(composition.service, local, directory);
  created = await sessions.create({ project: directory, tool: "codex", title: "隔离历史验收" });
  await delay(1500);
  const initialTerminal = composition.service.get(created.terminalId);
  assert.equal(initialTerminal.closedAt, undefined, `Native TUI exited: ${JSON.stringify(initialTerminal)}`);
  const attachment = await composition.service.attach({ terminalId: created.terminalId, viewerId: "fixture", cols: 100, rows: 30, history: 100 });
  let screen = "";
  attachment.stream.on("data", bytes => { screen += Buffer.from(bytes).toString(); });
  await delay(500);
  assert.ok(screen.length > 0, "Native TUI must paint");
  const nativeTerminal = await composition.service.inspect(created.terminalId);
  for (let attempt = 0; attempt < 80; attempt++) {
    const view = execFileSync(hc, ["read", nativeTerminal.address], { env: process.env, encoding: "utf8" });
    if (view.includes("Try new model")) {
      execFileSync(hc, ["keys", nativeTerminal.address, "down"], { env: process.env });
      await delay(100);
      execFileSync(hc, ["keys", nativeTerminal.address, "enter"], { env: process.env });
    }
    if (view.includes("context left") || view.includes("for shortcuts")) { console.log("native prompt ready"); break; }
    if (attempt === 79) throw new Error("Native prompt did not become ready: " + view);
    await delay(250);
  }
  await attachment.stream.detach();
  assert.deepEqual((await sessions.conversation(created.id)).messages, []);
  console.log("empty history passed");
  const waitReply = async expected => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await sessions.conversation(created.id);
      if (snapshot.messages.some(message => message.text === expected) && !snapshot.running) return snapshot;
      if (snapshot.error) throw new Error(snapshot.error);
      await delay(200);
    }
    throw new Error("Timed out waiting for the loopback fixture reply");
  };
  await sessions.send(created.id, "Reply with the fixture response. Do not use tools.");
  await waitReply("HERDR_FIXTURE_REPLY_1");
  console.log("first reply passed");
  sessions = new HerdrSessions(composition.service, local, directory);
  assert.ok((await sessions.conversation(created.id)).messages.some(message => message.text === "HERDR_FIXTURE_REPLY_1"));
  await sessions.send(created.id, "Second fixture turn. Do not use tools.");
  const snapshot = await waitReply("HERDR_FIXTURE_REPLY_2");
  assert.equal(snapshot.messages.filter(message => message.role === "assistant").length, 2);
  assert.equal(snapshot.messages.filter(message => message.role === "user").length, 2);
  assert.ok(requests >= 2);
  await sessions.end(created.id); created = undefined;
  console.log(JSON.stringify({ emptySession: true, nativeTerminalPaint: true, twoTurns: true, historyReconnect: true, realCodexAndHerdr: true, modelRequests: requests, model: "loopback fixture" }));
 } catch (error) {
  if (created) { const native = await composition.service.inspect(created.terminalId); console.error(execFileSync(hc, ["read", native.address], { env: process.env, encoding: "utf8" })); }
  throw error;
} finally {
  if (created) await sessions.end(created.id).catch(error => console.error("Fixture cleanup:", error.message));
  composition?.close();
  try { execFileSync(hc, ["server", "stop"], { env: process.env, stdio: "pipe", timeout: 5000 }); }
  finally { await new Promise(resolve => model.close(resolve)); rmSync(directory, { recursive: true, force: true }); }
}
