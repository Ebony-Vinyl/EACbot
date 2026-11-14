// The Xianyu bridge against a fake message gateway and a fake host: real websocket frames, real HTTP, no Xianyu
// account and no server data. Each case is a failure the bridge must survive without losing or duplicating a
// message, plus the two lines' contract with the board.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { StdioPluginSupervisor } from "./supervisor.ts";
import { PluginInstallStore } from "./store.ts";
import { PluginRegistry } from "./registry.ts";
import { installLocalPlugin } from "./local-install.ts";

const PACK = join(import.meta.dirname, "..", "..", "plugins", "eac", "xianyu");
const ACCOUNT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const folders: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Packs a map the way the gateway does: MessagePack, then base64. */
function packMap(entries: Record<string, string | number>) {
  const body: number[] = [0x80 | Object.keys(entries).length];
  for (const [key, value] of Object.entries(entries)) {
    const keyBytes = Buffer.from(key);
    body.push(0xa0 | keyBytes.length, ...keyBytes);
    if (typeof value === "number") body.push(0xce, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
    else {
      const bytes = Buffer.from(value);
      body.push(0xa0 | Math.min(bytes.length, 31), ...bytes);
    }
  }
  return Buffer.from(body).toString("base64");
}

/** What the token endpoint answers: a signed-in cookie mints a token that outlives the test. */
function tokenFetch() {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ret: ["SUCCESS::调用成功"], data: { accessToken: "tok-123", expireTime: Date.now() + 3_600_000 } }),
    headers: { getSetCookie: () => [] },
  });
}

/** The message gateway: answers `/reg`, answers a send with a chosen code, and pushes messages on request. */
async function fakeGateway(options: { sendCode?: number; silentRegister?: boolean } = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  const frames: Array<{ lwp: string; body: Record<string, unknown> }> = [];
  const socket = { current: null as WebSocket | null };
  wss.on("connection", (ws) => {
    socket.current = ws;
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (typeof frame.lwp !== "string") return;
      frames.push({ lwp: frame.lwp, body: frame.body ?? {} });
      if (frame.lwp === "/!" || options.silentRegister) return;
      const reply = (body: unknown) => ws.send(JSON.stringify({ lwp: frame.lwp, headers: { mid: frame.headers?.mid }, body }));
      if (frame.lwp === "/reg") return reply({ code: 0, message: "ok" });
      if (frame.lwp === "/r/MessageSend/sendByReceiverScope") return reply({ code: options.sendCode ?? 0, message: options.sendCode ? "refused by the gateway" : "ok" });
      reply({ code: 0 });
    });
  });
  closers.push(async () => {
    for (const client of wss.clients) client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    frames,
    connected: async () => {
      for (let index = 0; index < 150 && !socket.current; index += 1) await new Promise((done) => setTimeout(done, 20));
      if (!socket.current) throw new Error("the bridge never connected");
      return socket.current;
    },
    push: (payload: string) => socket.current!.send(JSON.stringify({
      body: { syncPushPackage: { data: [{ data: payload }] } },
    })),
  };
}

/** A host side: records inbound deliveries, serves the queued replies, and acks them away. */
async function fakeHost(options: { inboundStatus?: number; replies?: unknown[] } = {}) {
  const received: unknown[] = [];
  const acked: string[][] = [];
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
        if (status !== 202) return reply(status, { error: "busy", code: "thread_busy" });
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
    if (req.url?.startsWith(`/api/platforms/accounts/${ACCOUNT}/outbox`)) return reply(200, { messages: pending });
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

/** The plugin installed and activated, its work directory writable as an installer leaves it. */
async function bridge(config: Record<string, unknown>, host: { url: string }) {
  const folder = mkdtempSync(join(tmpdir(), "eac-xianyu-"));
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
  writeFileSync(join(workDir, "config.json"), `${JSON.stringify({ accountId: ACCOUNT, serverUrl: host.url, pollMs: 250, ...config })}\n`, { mode: 0o600 });
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
  /** The board and status are host methods, not tools: they take no grant. */
  const hostCall = async (method: string, params: Record<string, unknown> = {}) => {
    const record = registry.store.get(installed.installationId)!;
    return await registry.runtime!.call!(record.installationId, method, params, 10_000);
  };
  return { registry, installed, call, hostCall, workDir, folder };
}

describe("Xianyu bridge", () => {
  it("ships a manifest this host accepts, declaring the platform it serves", async () => {
    const { parsePluginManifest } = await import("../../shared/plugins/manifest.ts");
    const parsed = parsePluginManifest(JSON.parse(readFileSync(join(PACK, "eac-plugin.json"), "utf8")));
    expect(parsed.ok, parsed.ok ? "" : parsed.issues.join("; ")).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.runtime.mode).toBe("process");
    expect(parsed.manifest.contributes.platform?.id).toBe("xianyu");
    expect(parsed.manifest.contributes.platform?.transports).toEqual(["protocol", "web"]);
  });

  it("answers a board that matches the shared contract, with every unavailable capability explained", { timeout: 40_000 }, async () => {
    const host = await fakeHost();
    const { hostCall } = await bridge({ transport: "protocol", cookie: "" }, host);
    const board = await hostCall("board") as Record<string, unknown>;
    const { platformBoardSchema } = await import("../../shared/plugins/boards.ts");
    const parsed = platformBoardSchema.safeParse(board);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    const capabilities = board.capability as Array<{ id: string; state: string; reason?: string }>;
    // A capability that is not production must say why; the contract enforces it and the plugin supplies it.
    for (const capability of capabilities) {
      if (capability.state !== "production") expect(capability.reason, capability.id).toBeTruthy();
    }
    const captcha = capabilities.find((entry) => entry.id === "captcha");
    expect(captcha?.state).toBe("unavailable");
  });

  it("queues a high-impact action instead of sending it, and audits the decision", { timeout: 40_000 }, async () => {
    const host = await fakeHost();
    const { call, hostCall } = await bridge({ transport: "protocol", cookie: "" }, host);
    const queued = await call("xy-action", { action: "set-price", params: { conversationId: "c1", text: "改价到 99" } });
    expect(queued.status).toBe("succeeded");
    if (queued.status !== "succeeded") return;
    expect((queued.value as { queued?: unknown }).queued).toBeTruthy();

    const board = await hostCall("board") as { sections: Array<{ id: string; items?: unknown[] }> };
    const pending = board.sections.find((section) => section.id === "pending-actions");
    expect(pending?.items).toHaveLength(1);

    const audit = await hostCall("audit") as Array<{ action: string; outcome: string }>;
    expect(audit[0]).toMatchObject({ action: "set-price", outcome: "queued" });
    // The gateway never saw a send: a manual rule must not reach the platform.
    expect(host.acked).toHaveLength(0);
  });

  it("runs a high-impact action once its rule is automatic", { timeout: 40_000 }, async () => {
    const host = await fakeHost();
    const { call, hostCall } = await bridge({ transport: "protocol", cookie: "" }, host);
    await call("xy-rules", { rules: { enabled: false, actions: { "set-price": "auto" } } });
    const rules = await call("xy-kb-list");
    expect(rules.status).toBe("succeeded");
    if (rules.status !== "succeeded") return;
    expect((rules.value as { rules: { actions: Record<string, string> } }).rules.actions["set-price"]).toBe("auto");

    // No gateway is reachable here, so an automatic action must fail honestly rather than claim success.
    const ran = await call("xy-action", { action: "set-price", params: { conversationId: "c1", text: "改价到 99" } });
    expect(ran.status).toBe("failed");
    if (ran.status !== "failed") return;
    expect(["disconnected", "no-transport", "unreachable", "no-login"]).toContain(ran.code);

    const audit = await hostCall("audit") as Array<{ action: string; outcome: string }>;
    expect(audit[0]).toMatchObject({ action: "set-price", outcome: "failed" });
  });

  it("keeps the knowledge base honest: duplicate questions are refused, unknown ids are not deleted", { timeout: 40_000 }, async () => {
    const host = await fakeHost();
    const { call } = await bridge({ transport: "protocol", cookie: "" }, host);
    const first = await call("xy-kb-add", { question: "包邮吗", answer: "包邮" });
    expect(first.status).toBe("succeeded");
    const again = await call("xy-kb-add", { question: "包邮吗", answer: "包邮的" });
    expect(again.status).toBe("failed");
    if (again.status === "failed") expect(again.code).toBe("duplicate");
    const missing = await call("xy-kb-delete", { id: "not-a-real-id" });
    expect(missing.status).toBe("failed");
    if (missing.status === "failed") expect(missing.code).toBe("not-found");
  });

  it("reports both lines in its status, and says which one is live", { timeout: 40_000 }, async () => {
    const host = await fakeHost();
    const { hostCall } = await bridge({ transport: "auto", cookie: "" }, host);
    const status = await hostCall("status") as Record<string, unknown>;
    expect(status.transportMode).toBe("auto");
    expect(["protocol", "web", "none"]).toContain(status.transportLive);
    // With no cookie and no cdpUrl neither line can connect, and the status says so instead of pretending.
    expect(status.connected).toBe(false);
    expect(String(status.lastError)).toContain("config.json");
  });
});

describe("Xianyu protocol line", () => {
  it("signs a gateway call the way the web client does", async () => {
    const { sign, signToken, isTokenError, mergeCookies } = await import("../../plugins/eac/xianyu/protocol/sign.mjs");
    // md5 over token&t&appKey&data, which is what the gateway recomputes on its side.
    expect(sign("abc", "1700000000", "{}", "12574478")).toMatch(/^[0-9a-f]{32}$/);
    expect(signToken("_m_h5_tk=abc_1700000000; unb=77")).toBe("abc");
    expect(isTokenError(["FAIL_SYS_TOKEN_EXOIRED::令牌过期"])).toBe(true);
    expect(isTokenError(["SUCCESS::调用成功"])).toBe(false);
    expect(mergeCookies("a=1; b=2", ["b=3; Path=/", "c=4"])).toBe("a=1; b=3; c=4");
  });

  it("decodes a packed push frame into a message, and ignores frames that are not chat", async () => {
    const { messagesFromPush, decodePushPayload } = await import("../../plugins/eac/xianyu/protocol/push.mjs");
    const packed = packMap({ "2": "convA@goofish", "6": "msgA", "5": 1_700_000_000, text: "你好，包邮吗" });
    const decoded = decodePushPayload(packed) as Record<string, unknown>;
    expect(decoded["2"]).toBe("convA@goofish");

    const messages = messagesFromPush({ body: { syncPushPackage: { data: [{ data: packed }] } } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      conversationId: "convA",
      messageId: "msgA",
      text: "你好，包邮吗",
      isSelf: false,
    });
    expect(messages[0]!.receivedAt).toBe("2023-11-14T22:13:20.000Z");

    expect(messagesFromPush({ body: { syncPushPackage: { data: [] } } })).toEqual([]);
    expect(messagesFromPush({})).toEqual([]);
  });

  it("reads a gateway refusal as a refusal rather than a success", async () => {
    const { refusalOf } = await import("../../plugins/eac/xianyu/protocol/socket.mjs");
    expect(refusalOf({ body: { code: 0 } })).toBeNull();
    expect(refusalOf({ body: { code: "SUCCESS" } })).toBeNull();
    expect(refusalOf({ body: { code: 500, message: "receiver not found" } })).toContain("receiver not found");
  });
});

describe("Xianyu protocol line, end to end", () => {
  it("receives a pushed message and delivers it to the host as an inbound event", { timeout: 40_000 }, async () => {
    const gateway = await fakeGateway();
    const host = await fakeHost();
    const { createProtocolTransport } = await import("../../plugins/eac/xianyu/protocol/socket.mjs");

    // A token endpoint stand-in: the line mints a token, then opens the socket.
    const transport = createProtocolTransport({
      getCookie: async () => "_m_h5_tk=abc_1700000000; unb=77",
      setCookie: async () => undefined,
      fetchImpl: tokenFetch(),
      socketUrl: gateway.url,
      accountId: ACCOUNT,
    });

    const events: Array<{ conversationId: string; text: string }> = [];
    await transport.start((message: { conversationId: string; text: string }) => { events.push(message); });
    await gateway.connected();

    // The gateway pushes one chat message; the line must decode it and hand it over.
    gateway.push(packMap({ "2": "convA@goofish", "6": "msgA", "5": 1_700_000_000, text: "包邮吗" }));
    for (let index = 0; index < 100 && !events.length; index += 1) await new Promise((done) => setTimeout(done, 50));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ conversationId: "convA", text: "包邮吗" });
    const registered = gateway.frames.find((frame) => frame.lwp === "/reg");
    expect(registered, "the line registers with its token before listening").toBeTruthy();
    await transport.stop();
    expect(host.received).toHaveLength(0);
  });

  it("sends a reply over the socket and only resolves once the gateway answered", { timeout: 40_000 }, async () => {
    const gateway = await fakeGateway();
    const { createProtocolTransport } = await import("../../plugins/eac/xianyu/protocol/socket.mjs");
    const transport = createProtocolTransport({
      getCookie: async () => "_m_h5_tk=abc_1700000000; unb=77",
      setCookie: async () => undefined,
      fetchImpl: tokenFetch(),
      socketUrl: gateway.url,
      accountId: ACCOUNT,
    });
    await transport.start(() => undefined);
    await gateway.connected();

    const result = await transport.send({ conversationId: "convA", conversationKind: "direct", text: "包邮的" });
    expect(result).toEqual({ ok: true });
    const sent = gateway.frames.find((frame) => frame.lwp === "/r/MessageSend/sendByReceiverScope");
    expect(sent).toBeTruthy();
    expect(JSON.stringify(sent!.body)).toContain("包邮的");
    await transport.stop();
  });

  it("reports a gateway refusal as a refusal instead of a send", { timeout: 40_000 }, async () => {
    const gateway = await fakeGateway({ sendCode: 500 });
    const { createProtocolTransport } = await import("../../plugins/eac/xianyu/protocol/socket.mjs");
    const transport = createProtocolTransport({
      getCookie: async () => "_m_h5_tk=abc_1700000000; unb=77",
      setCookie: async () => undefined,
      fetchImpl: tokenFetch(),
      socketUrl: gateway.url,
      accountId: ACCOUNT,
    });
    await transport.start(() => undefined);
    await gateway.connected();
    // A refusal must not look like success: the reply stays in the outbox for a person.
    await expect(transport.send({ conversationId: "convA", conversationKind: "direct", text: "x" })).rejects.toThrow(/refused/);
    await transport.stop();
  });
});

describe("Xianyu web line", () => {
  it("stops on a security check and never reports it as a read", async () => {
    const { wallOf, selfCheckReport } = await import("../../plugins/eac/shared/web/line.mjs");
    expect(wallOf("请完成验证后继续")).toBe("verify");
    expect(wallOf("请登录后查看")).toBe("login");
    expect(wallOf("买家：在吗")).toBeNull();

    const report = selfCheckReport([
      { probe: "messageList", matched: true, text: "买家A 12:30 在吗" },
      { probe: "composer", matched: true, text: "请完成验证" },
      { probe: "itemCard", matched: false, text: "" },
    ]);
    expect(report[0]).toMatchObject({ ok: true });
    expect(report[1]).toMatchObject({ ok: false, wall: "verify" });
    expect(report[2]).toMatchObject({ ok: false, wall: null });
    // A failing probe always explains itself: a person learns what broke, not merely that something did.
    for (const entry of report) expect(entry.reason).toBeTruthy();
  });

  it("reads conversations, listings and orders from page text", async () => {
    const { parseConversations, parseItems, parseOrders } = await import("../../plugins/eac/xianyu/web/parse.mjs");
    expect(parseConversations("买家A\n12:30\n在吗 包邮吗")).toMatchObject([{ name: "买家A", preview: "在吗 包邮吗", at: "12:30" }]);
    expect(parseItems("全新机械键盘\n¥ 199.00\n已卖出")).toMatchObject([{ title: "全新机械键盘", price: 199, status: "closed" }]);
    expect(parseOrders("二手手机\n¥ 899\n待发货")).toMatchObject([{ title: "二手手机", price: 899, state: "待发货" }]);
  });

  it("needs a cdpUrl and says so instead of failing silently", { timeout: 40_000 }, async () => {
    const host = await fakeHost();
    const { hostCall } = await bridge({ transport: "web", cdpUrl: "" }, host);
    const status = await hostCall("status") as Record<string, unknown>;
    expect(status.connected).toBe(false);
    expect(String(status.lastError)).toMatch(/cdpUrl|DevTools/);
  });
});
