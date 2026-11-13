// A real process bridge against a fake lark-cli and a fake EAC host. No Feishu account is used.
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installLocalPlugin } from "./local-install.ts";
import { PluginInstallStore } from "./store.ts";
import { PluginRegistry } from "./registry.ts";
import { StdioPluginSupervisor } from "./supervisor.ts";

const PACK = join(import.meta.dirname, "..", "..", "plugins", "eac", "feishu");
const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const folders: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fakeLark(folder: string): string {
  const script = join(folder, "fake-lark.mjs");
  const file = join(folder, "fake-lark.cmd");
  writeFileSync(script, String.raw`
import { readFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
if (args === "config strict-mode") { console.log("bot"); process.exit(0); }
if (args.startsWith("im +chat-list")) { console.log(JSON.stringify({ ok: true, data: { chats: [{ chat_id: "oc_chat1", name: "Test" }] } })); process.exit(0); }
if (args.startsWith("im +messages-reply") || args.startsWith("im +messages-send")) { readFileSync(0, "utf8"); console.log(JSON.stringify({ ok: true, data: { message_id: "om_out" } })); process.exit(0); }
if (args.startsWith("event consume")) {
  process.stderr.write("[event] ready event_key=im.message.receive_v1\n");
  console.log(JSON.stringify({ message_id: "om_9001", chat_id: "oc_chat1", chat_type: "group", message_type: "text", sender_id: "ou_user", sender_type: "user", content: "你好", create_time: "1700000000000", mentions: [{ id: "ou_bot", name: "Bot" }] }));
  setTimeout(() => process.exit(0), 20_000);
}
process.exit(2);
`.trimStart(), "utf8");
  writeFileSync(file, '@node "%~dp0fake-lark.mjs" %*\r\n', "ascii");
  return file;
}

async function fakeHost(): Promise<{ url: string; inbound: unknown[]; acked: string[][] }> {
  const inbound: unknown[] = [];
  const acked: string[][] = [];
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/api/platforms/inbound") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { inbound.push(JSON.parse(body)); reply(202, { accepted: true, threadId: "t1" }); });
      return;
    }
    if (req.method === "GET" && req.url === "/api/platforms/accounts/" + ACCOUNT + "/outbox") {
      reply(200, { messages: [{ id: "m1", accountId: ACCOUNT, conversationId: "oc_chat1", conversationKind: "group", text: "收到", replyToEventId: "feishu-om_9001", threadId: "t1", createdAt: new Date().toISOString() }] });
      return;
    }
    if (req.method === "POST" && req.url === "/api/platforms/accounts/" + ACCOUNT + "/outbox/ack") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { acked.push(JSON.parse(body).ids); reply(200, { removed: 1 }); });
      return;
    }
    reply(404, { error: "no route" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { url: "http://127.0.0.1:" + (server.address() as { port: number }).port, inbound, acked };
}

describe.skipIf(process.platform !== "win32")("Feishu bridge process", () => {
  it("delivers an event, replies to the source message, and acks the outbox", { timeout: 45_000 }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "eac-feishu-bridge-"));
    folders.push(folder);
    const host = await fakeHost();
    const cli = fakeLark(folder);
    const supervisor = new StdioPluginSupervisor({ dataDir: folder, startTimeoutMs: 8_000 });
    closers.push(async () => { await supervisor.stopAll().catch(() => undefined); supervisor.dispose(); });
    const registry = new PluginRegistry(new PluginInstallStore(folder), {
      hostVersion: "0.1.146", host: "server", platform: "win32-x64", runtime: supervisor,
    });
    const installed = installLocalPlugin(registry, PACK);
    const runtime = join(folder, "plugins", "runtime", installed.installationId);
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    writeFileSync(join(runtime, "config.json"), JSON.stringify({
      cli, larkConfigDir: join(folder, "lark-config"), accountId: ACCOUNT, botOpenId: "ou_bot",
      serverUrl: host.url, chats: "oc_chat1:mentions", allowedSenders: "ou_user", directMessages: true,
      otherChats: "none", pollMs: 250,
    }) + "\n", { mode: 0o600 });
    await registry.activate(installed.installationId);

    for (let index = 0; index < 120 && !host.inbound.length; index += 1) await new Promise((done) => setTimeout(done, 100));
    if (!host.inbound.length) {
      const status = await supervisor.call(installed.installationId, "status", {}).catch((error) => ({ error: String(error) }));
      throw new Error("bridge delivered nothing: " + JSON.stringify(status));
    }
    expect(host.inbound).toHaveLength(1);
    expect(host.inbound[0]).toMatchObject({ eventId: "feishu-om_9001", platform: "feishu", conversation: { id: "oc_chat1", kind: "group" }, text: "你好" });

    for (let index = 0; index < 120 && !host.acked.length; index += 1) await new Promise((done) => setTimeout(done, 100));
    if (!host.acked.length) {
      const status = await supervisor.call(installed.installationId, "status", {}).catch((error) => ({ error: String(error) }));
      throw new Error("bridge did not ack: " + JSON.stringify(status));
    }
    expect(host.acked).toEqual([["m1"]]);
  });
});
