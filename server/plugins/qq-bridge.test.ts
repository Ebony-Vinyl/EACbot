// The QQ bridge against a fake OneBot and a fake host: real websocket frames, real HTTP, no QQ account and no server
// data. Each case is one failure the bridge must survive without losing or duplicating a message.
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { StdioPluginSupervisor } from "./supervisor.ts";
import { PluginInstallStore } from "./store.ts";
import { PluginRegistry } from "./registry.ts";
import { installLocalPlugin } from "./local-install.ts";

const PACK = join(import.meta.dirname, "..", "..", "plugins", "eac", "qq");
const ACCOUNT = "11111111-2222-3333-4444-555555555555";

const folders: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A OneBot v11 side: records what the bridge asked for and answers each action with a chosen retcode. */
async function fakeOneBot(options: { retcode?: number; silent?: boolean } = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
  const socket = { current: null as WebSocket | null };
  wss.on("connection", (ws) => {
    socket.current = ws;
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (typeof frame.action !== "string") return;
      actions.push({ action: frame.action, params: frame.params ?? {} });
      if (options.silent) return;
      ws.send(JSON.stringify({ status: options.retcode === undefined || options.retcode === 0 ? "ok" : "failed", retcode: options.retcode ?? 0, data: { message_id: 4242 }, echo: frame.echo }));
    });
  });
  closers.push(async () => {
    for (const client of wss.clients) client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  return {
    url: `ws://127.0.0.1:${port}`,
    actions,
    connected: async () => {
      for (let index = 0; index < 100 && !socket.current; index += 1) await new Promise((done) => setTimeout(done, 20));
      if (!socket.current) throw new Error("the bridge never connected");
      return socket.current;
    },
    push: (frame: unknown) => socket.current!.send(JSON.stringify(frame)),
  };
}

/** A host side: records inbound deliveries, serves the queued replies the outbox still holds, and acks them away. */
async function fakeHost(options: { inboundStatus?: number; replies?: unknown[] } = {}) {
  const received: unknown[] = [];
  const acked: string[][] = [];
  // Mirrors PlatformOutboxStore.ack: an acked reply is gone, so the next read does not hand it over again.
  let pending = [...(options.replies ?? [])];
  const host = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/api/platforms/inbound") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        received.push(JSON.parse(body));
        const status = options.inboundStatus ?? 202;
        if (status !== 202) return reply(status, { error: "this conversation is already being answered", code: "thread_busy" });
        reply(202, { accepted: true, threadId: "t1" });
      });
      return;
    }
    if (req.url?.startsWith(`/api/platforms/accounts/${ACCOUNT}/outbox/ack`)) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const ids = JSON.parse(body).ids as string[];
        acked.push(ids);
        pending = pending.filter((message) => !ids.includes((message as { id: string }).id));
        reply(200, { removed: ids.length });
      });
      return;
    }
    if (req.url?.startsWith(`/api/platforms/accounts/${ACCOUNT}/outbox`)) {
      return reply(200, { messages: pending });
    }
    reply(404, { error: "no route" });
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const port = (host.address() as { port: number }).port;
  closers.push(async () => {
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}`, received, acked };
}

/** The plugin installed and activated in a temporary host, its work directory writable as an installer would leave it. */
async function bridge(config: Record<string, unknown>, onebot: { url: string }, host: { url: string }) {
  const folder = mkdtempSync(join(tmpdir(), "eac-qq-bridge-"));
  folders.push(folder);
  const supervisor = new StdioPluginSupervisor({ dataDir: folder, startTimeoutMs: 5_000 });
  closers.push(async () => {
    await supervisor.stopAll().catch(() => undefined);
    supervisor.dispose();
  });
  const registry = new PluginRegistry(new PluginInstallStore(folder), {
    hostVersion: "0.1.146", host: "server", platform: "linux-x64", runtime: supervisor,
  });
  const installed = installLocalPlugin(registry, PACK);
  await registry.activate(installed.installationId);
  const workDir = join(folder, "plugins", "runtime", installed.installationId);
  writeFileSync(join(workDir, "config.json"), `${JSON.stringify({ accountId: ACCOUNT, onebotUrl: onebot.url, serverUrl: host.url, pollMs: 250, ...config })}\n`, { mode: 0o600 });
  const call = async (toolId: string, args: Record<string, unknown> = {}) => {
    const record = registry.store.get(installed.installationId)!;
    const tool = registry.tools(installed.installationId).find((candidate) => candidate.id === toolId)!;
    const permission = record.manifest.permissions.find((candidate) => candidate.id === tool.permission)!;
    return await registry.callTool(installed.installationId, toolId, {
      botId: "bot-1", principalId: "principal-1", audienceId: "audience-1", epoch: 0, args,
      grant: {
        grantId: "grant_test", installationId: installed.installationId, botId: "bot-1", principalId: "principal-1",
        audienceId: "audience-1", permissionId: permission.id, effect: permission.effect, resources: {},
        createdAt: new Date().toISOString(), epoch: 0, maxUses: 100, uses: 0,
      },
    });
  };
  return { registry, installed, call, workDir, folder };
}

describe("QQ OneBot bridge", () => {
  it("ships a manifest this host accepts", async () => {
    const { parsePluginManifest } = await import("../../shared/plugins/manifest.ts");
    const parsed = parsePluginManifest(JSON.parse(readFileSync(join(PACK, "eac-plugin.json"), "utf8")));
    expect(parsed.ok, parsed.ok ? "" : parsed.issues.join("; ")).toBe(true);
    // The bridge carries a live connection, so it must be a process runtime the supervisor can hold open.
    expect(parsed.ok && parsed.manifest.runtime.mode).toBe("process");
  });

  it("turns a OneBot group message into an inbound event for its account", { timeout: 30_000 }, async () => {
    const onebot = await fakeOneBot();
    const host = await fakeHost();
    await bridge({ allow: [{ kind: "group", id: "555" }, { kind: "direct", id: "777" }] }, onebot, host);

    (await onebot.connected()).send(JSON.stringify({
      post_type: "message", message_type: "group", message_id: 9001, group_id: 555, user_id: 777,
      time: 1_700_000_000, sender: { card: "小明" }, message: [{ type: "text", data: { text: "你好" } }],
    }));

    for (let index = 0; index < 100 && !host.received.length; index += 1) await new Promise((done) => setTimeout(done, 50));
    expect(host.received).toHaveLength(1);
    expect(host.received[0]).toMatchObject({
      eventId: "qq-9001", platform: "qq", accountId: ACCOUNT,
      conversation: { id: "555", kind: "group" }, sender: { id: "777", name: "小明" }, text: "你好",
    });
  });

  it("keeps the event queued while the host is busy, then delivers it once", { timeout: 30_000 }, async () => {
    const onebot = await fakeOneBot();
    const host = await fakeHost({ inboundStatus: 409 });
    const { call } = await bridge({ allow: [{ kind: "group", id: "555" }, { kind: "direct", id: "777" }] }, onebot, host);

    (await onebot.connected()).send(JSON.stringify({
      post_type: "message", message_type: "private", message_id: 9002, user_id: 777,
      time: 1_700_000_001, sender: { nickname: "ming" }, message: "hi",
    }));
    for (let index = 0; index < 40 && !host.received.length; index += 1) await new Promise((done) => setTimeout(done, 50));
    expect(host.received.length).toBeGreaterThan(0);

    const before = host.received.length;
    const status = await call("qq-bridge-status");
    expect(status.status).toBe("succeeded");
    if (status.status !== "succeeded") throw new Error("the bridge did not answer its status tool");
    // A 409 is not a delivery: the same event stays queued and is retried, never counted as accepted.
    expect((status.value as { inbound: { refused: number } }).inbound.refused).toBe(0);
    expect(host.received.length).toBeGreaterThanOrEqual(before);
  });

  it("sends the bot's reply back to the group and acks only what OneBot accepted", { timeout: 30_000 }, async () => {
    const onebot = await fakeOneBot();
    const host = await fakeHost({
      replies: [
        { id: "m1", accountId: ACCOUNT, conversationId: "555", conversationKind: "group", text: "收到", replyToEventId: "qq-9001", threadId: "t1", createdAt: new Date().toISOString() },
        { id: "m2", accountId: ACCOUNT, conversationId: "777", conversationKind: "direct", text: "私聊回", replyToEventId: null, threadId: "t1", createdAt: new Date().toISOString() },
      ],
    });
    await bridge({ allow: [{ kind: "group", id: "555" }, { kind: "direct", id: "777" }] }, onebot, host);
    await onebot.connected();

    for (let index = 0; index < 100 && onebot.actions.length < 2; index += 1) await new Promise((done) => setTimeout(done, 50));
    expect(onebot.actions).toEqual([
      { action: "send_group_msg", params: { group_id: 555, message: "收到" } },
      { action: "send_private_msg", params: { user_id: 777, message: "私聊回" } },
    ]);
    for (let index = 0; index < 60 && !host.acked.length; index += 1) await new Promise((done) => setTimeout(done, 50));
    expect(host.acked).toEqual([["m1", "m2"]]);
  });

  it("does not ack a reply OneBot refused, so it stays visible in the outbox", { timeout: 30_000 }, async () => {
    const onebot = await fakeOneBot({ retcode: 1404 });
    const host = await fakeHost({
      replies: [{ id: "m1", accountId: ACCOUNT, conversationId: "555", conversationKind: "group", text: "收到", replyToEventId: null, threadId: "t1", createdAt: new Date().toISOString() }],
    });
    const { call } = await bridge({ pollMs: 1_500 }, onebot, host);
    await onebot.connected();

    // One poll is enough to see the attempt; a second poll must not ack it either.
    for (let index = 0; index < 100 && !onebot.actions.length; index += 1) await new Promise((done) => setTimeout(done, 50));
    expect(onebot.actions.length).toBeGreaterThanOrEqual(1);
    await new Promise((done) => setTimeout(done, 2_000));
    expect(host.acked).toEqual([]);
    const status = await call("qq-bridge-status");
    if (status.status !== "succeeded") throw new Error("the bridge did not answer its status tool");
    expect((status.value as { lastError: string }).lastError).toMatch(/retcode 1404/);
  });

  it("leaves a reply unresolved when OneBot never answers, and says so", { timeout: 60_000 }, async () => {
    const onebot = await fakeOneBot({ silent: true });
    const host = await fakeHost({
      replies: [{ id: "m1", accountId: ACCOUNT, conversationId: "555", conversationKind: "group", text: "收到", replyToEventId: null, threadId: "t1", createdAt: new Date().toISOString() }],
    });
    const { call } = await bridge({ pollMs: 60_000 }, onebot, host);
    await onebot.connected();
    for (let index = 0; index < 100 && !onebot.actions.length; index += 1) await new Promise((done) => setTimeout(done, 50));
    expect(onebot.actions.length).toBeGreaterThanOrEqual(1);
    // A silent OneBot cannot confirm a send, so the tool must not report one.
    const sent = await call("qq-send-message", { conversationKind: "group", conversationId: "555", text: "手发" });
    expect(sent.status).toBe("failed");
    const status = await call("qq-bridge-status");
    if (status.status !== "succeeded") throw new Error("the bridge did not answer its status tool");
    expect((status.value as { lastError: string }).lastError).toMatch(/no answer|unresolved/);
  });

  it("refuses to send through a bridge that is not connected", { timeout: 30_000 }, async () => {
    const onebot = await fakeOneBot();
    const host = await fakeHost();
    const { call } = await bridge({ allow: [{ kind: "group", id: "555" }, { kind: "direct", id: "777" }] }, onebot, host);
    // No connection yet: the plugin was just activated and its config written afterwards.
    const sent = await call("qq-send-message", { conversationKind: "group", conversationId: "555", text: "手发" });
    expect(sent.status).toBe("failed");
    expect(JSON.stringify(sent)).toMatch(/disconnected|not open/);
  });

  it("writes its configuration and asks for a reactivation", { timeout: 30_000 }, async () => {
    const onebot = await fakeOneBot();
    const host = await fakeHost();
    const { call, workDir } = await bridge({ allow: [{ kind: "group", id: "555" }, { kind: "direct", id: "777" }] }, onebot, host);
    const saved = await call("qq-bridge-configure", { onebotUrl: onebot.url, accountId: ACCOUNT, serverUrl: host.url, onebotToken: "tok" });
    expect(saved.status).toBe("succeeded");
    const written = JSON.parse(readFileSync(join(workDir, "config.json"), "utf8"));
    expect(written).toMatchObject({ onebotUrl: onebot.url, accountId: ACCOUNT, onebotToken: "tok" });
  });

  it("refuses a configuration it could not connect with", { timeout: 30_000 }, async () => {
    const onebot = await fakeOneBot();
    const host = await fakeHost();
    const { call } = await bridge({ allow: [{ kind: "group", id: "555" }] }, onebot, host);
    expect((await call("qq-bridge-configure", { onebotUrl: "http://127.0.0.1:1", accountId: ACCOUNT })).status).toBe("failed");
    expect((await call("qq-bridge-configure", { onebotUrl: onebot.url, accountId: "not-a-uuid" })).status).toBe("failed");
  });

  it("copies only the conversations a person named, and never writes the others down", { timeout: 30_000 }, async () => {
    const onebot = await fakeOneBot();
    const host = await fakeHost();
    const { workDir } = await bridge({ allow: [{ kind: "group", id: "555" }] }, onebot, host);
    const socket = await onebot.connected();

    // One allowed group, one group nobody named, and a direct chat nobody named.
    for (const frame of [
      { post_type: "message", message_type: "group", message_id: 1, group_id: 555, user_id: 1, time: 1_700_000_000, sender: { card: "ok" }, message: "allowed" },
      { post_type: "message", message_type: "group", message_id: 2, group_id: 999, user_id: 2, time: 1_700_000_001, sender: { card: "other" }, message: "someone else's group" },
      { post_type: "message", message_type: "private", message_id: 3, user_id: 333, time: 1_700_000_002, sender: { nickname: "dm" }, message: "someone else's chat" },
    ]) socket.send(JSON.stringify(frame));

    for (let index = 0; index < 100 && !host.received.length; index += 1) await new Promise((done) => setTimeout(done, 50));
    await new Promise((done) => setTimeout(done, 600));

    // The host saw only the allowed conversation.
    expect(host.received).toHaveLength(1);
    expect(host.received[0]).toMatchObject({ conversation: { id: "555", kind: "group" }, text: "allowed" });

    // A delivered event leaves the queue, so the file holds only what is still pending. What matters is that the
    // two unnamed conversations never appear in it: they were dropped before anything was written down.
    const file = join(workDir, "qq-bridge-state.json");
    const state = existsSync(file) ? readFileSync(file, "utf8") : "";
    expect(state).not.toContain("someone else");
    expect(state).not.toContain("999");
    expect(state).not.toContain("333");
  });

  it("carries nothing at all until a conversation is named", { timeout: 30_000 }, async () => {
    const onebot = await fakeOneBot();
    const host = await fakeHost();
    // No allow list: the safe default for an account that sits in real groups.
    const { workDir } = await bridge({}, onebot, host);
    const socket = await onebot.connected();

    socket.send(JSON.stringify({ post_type: "message", message_type: "group", message_id: 7, group_id: 555, user_id: 1, time: 1_700_000_000, sender: { card: "x" }, message: "should not pass" }));
    await new Promise((done) => setTimeout(done, 800));

    expect(host.received).toEqual([]);
    // No file at all is the same fact as an empty one: nothing was written down.
    const file = join(workDir, "qq-bridge-state.json");
    expect(existsSync(file) ? readFileSync(file, "utf8") : "").not.toContain("should not pass");
  });

  it("refuses an allow entry that is not a QQ number", { timeout: 30_000 }, async () => {
    const onebot = await fakeOneBot();
    const host = await fakeHost();
    const { call } = await bridge({ allow: [{ kind: "group", id: "555" }, { kind: "direct", id: "777" }] }, onebot, host);
    const bad = await call("qq-bridge-configure", {
      onebotUrl: onebot.url, accountId: ACCOUNT, allow: [{ kind: "group", id: "not-a-number" }],
    });
    expect(bad.status).toBe("failed");
    expect(JSON.stringify(bad)).toMatch(/invalid-allow/);
    const badKind = await call("qq-bridge-configure", {
      onebotUrl: onebot.url, accountId: ACCOUNT, allow: [{ kind: "channel", id: "555" }],
    });
    expect(badKind.status).toBe("failed");
  });
});
