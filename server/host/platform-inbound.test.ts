import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PlatformAccountStore } from "../plugins/platform-accounts.ts";
import { PlatformOutboxStore } from "../plugins/platform-outbox.ts";
import { createPlatformInboundHost } from "./platform-inbound.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function setup(options: { names?: string[]; share?: number; recent?: Array<{ role: string; text: string; at: number }>; defer?: boolean } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "eac-platform-inbound-"));
  folders.push(folder);
  const accounts = new PlatformAccountStore(folder, { now: () => "2026-11-08T10:00:00.000Z" });
  const outbox = new PlatformOutboxStore(folder);
  const account = accounts.addAccount({ platform: "qq", externalAccountId: "self-1", displayName: "EAC QQ" });
  accounts.bind(account.accountId, "bot-1", "existing");
  const createdTasks: Array<{ botId: string; title?: string }> = [];
  const liveThreads = new Set<string>(["known-thread"]);
  let threadCounter = 0;
  const store = {
    taskByThread: (_botId: string, threadId: string) => (liveThreads.has(threadId) ? { threadId } : null),
    createTask: (botId: string, title?: string) => {
      createdTasks.push({ botId, title });
      const threadId = `th_${++threadCounter}`;
      liveThreads.add(threadId);
      return { threadId };
    },
  };
  const state = { busy: false, refuseStart: null as null | "thread_busy" };
  const turns: Array<{ botId: string; text: string; opts: Record<string, unknown> }> = [];
  const host = createPlatformInboundHost({
    accounts, outbox, dataDir: folder, store,
    canStart: () => true,
    threadBusy: () => state.busy,
    ...(options.names ? { namesOf: () => options.names! } : {}),
    ...(options.share !== undefined ? { replyShare: () => options.share! } : {}),
    ...(options.recent ? { recent: () => options.recent! } : {}),
    startTurn: async (botId, text, opts) => {
      if (state.refuseStart) throw Object.assign(new Error("blocked"), { code: state.refuseStart });
      turns.push({ botId, text, opts });
      if (!options.defer) opts.onSettled({ ok: true, text: "已回复" });
      return { ok: true, text: "已回复" };
    },
  });
  const event = (patch: Partial<Record<string, unknown>> = {}) => ({
    eventId: `ev_${Math.random().toString(36).slice(2, 8)}`,
    platform: "qq",
    accountId: account.accountId,
    conversation: { id: "conv-1", kind: "direct" },
    sender: { id: "friend-1", name: "小明" },
    receivedAt: "2026-11-08T10:00:00.000Z",
    text: "在吗？",
    ...patch,
  });
  return { folder, accounts, outbox, host, event, account, turns, createdTasks, state };
}

describe("platform inbound turns", () => {
  it("keeps group and direct conversations with the same id on different threads", async () => {
    const { host, event, turns } = setup();
    await host.deliver(event({ conversation: { id: "123", kind: "direct" } }));
    await host.deliver(event({ conversation: { id: "123", kind: "group" } }));
    expect(turns[0]!.opts.threadId).not.toBe(turns[1]!.opts.threadId);
    expect(turns[1]!.opts.platformContext).toMatchObject({ conversation: { id: "123", kind: "group" }, sender: { id: "friend-1" } });
  });

  it("opens a new thread when an account is rebound to a different bot", async () => {
    const { host, event, accounts, account, turns } = setup();
    await host.deliver(event());
    accounts.unbind(account.accountId);
    accounts.bind(account.accountId, "bot-2", "existing");
    await host.deliver(event());
    expect(turns[1]!.botId).toBe("bot-2");
    expect(turns[1]!.opts.threadId).not.toBe(turns[0]!.opts.threadId);
  });

  it("suppresses a late reply after unbinding and delivers an unchanged accepted turn", async () => {
    const { host, event, turns, accounts, account, outbox } = setup({ defer: true });
    await host.deliver(event());
    const settle = turns[0]!.opts.onSettled as (result: { ok: boolean; text: string }) => void;
    settle({ ok: true, text: "first" });
    expect(outbox.list(account.accountId)).toHaveLength(1);
    accounts.unbind(account.accountId);
    settle({ ok: true, text: "late" });
    expect(outbox.list(account.accountId)).toHaveLength(1);
  });

  it("starts the bound bot's turn on its own thread and queues the reply when the turn settles", async () => {
    const { host, event, turns, createdTasks, outbox, account } = setup();
    const first = await host.deliver(event()) as { status: number; body: { threadId: string; route: { action: string }; accepted?: boolean } };
    expect(first.status).toBe(202);
    expect(first.body.route.action).toBe("delivered");
    expect(first.body.accepted).toBe(true);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.botId).toBe("bot-1");
    expect(turns[0]!.opts).toMatchObject({ threadId: first.body.threadId, unattended: true, automationSource: "webhook" });
    expect((turns[0]!.opts.sender as { name: string }).name).toBe("小明");
    expect(createdTasks[0]!.title).toContain("QQ");
    // The fake startTurn settles before deliver() returns; a reply that arrives with the settle is in the outbox.
    expect(outbox.list(account.accountId)).toHaveLength(1);
    expect(outbox.list(account.accountId)[0]!.text).toBe("已回复");

    // The same conversation keeps one thread; a new event is a new turn on it.
    const second = await host.deliver(event({ text: "帮我查个东西" })) as { status: number; body: { threadId: string } };
    expect(second.body.threadId).toBe(first.body.threadId);
    expect(createdTasks).toHaveLength(1);
    expect(turns).toHaveLength(2);
  });

  it("never delivers the same event twice, and an echo of the account's own message is ignored", async () => {
    const { host, event, turns } = setup();
    const raw = event({ eventId: "ev-fixed-1" });
    await host.deliver(raw);
    const again = await host.deliver(raw) as { status: number; body: { route: { action: string; reason?: string } } };
    expect(again.body.route).toMatchObject({ action: "ignored", reason: "duplicate" });
    expect(turns).toHaveLength(1);

    const echo = await host.deliver(event({ eventId: "ev-echo", sender: { id: "self-1" } })) as { status: number; body: { route: { reason: string } } };
    expect(echo.body.route.reason).toBe("echo");
    expect(turns).toHaveLength(1);
  });

  it("refuses while the thread is busy without consuming the event, so a later retry delivers", async () => {
    const { host, event, turns, state } = setup();
    const raw = event({ eventId: "ev-busy-1" });
    state.busy = true;
    const refused = await host.deliver(raw) as { status: number };
    expect(refused.status).toBe(409);
    expect(turns).toHaveLength(0);
    state.busy = false;
    const retried = await host.deliver(raw) as { status: number; body: { route: { action: string } } };
    expect(retried.status).toBe(202);
    expect(retried.body.route.action).toBe("delivered");
    expect(turns).toHaveLength(1);
  });

  it("retries after a startTurn thread_busy refusal, then delivers once admission passes", async () => {
    const { host, event, turns, state } = setup();
    const raw = event({ eventId: "ev-retry-1" });
    state.refuseStart = "thread_busy";
    const refused = await host.deliver(raw) as { status: number };
    expect(refused.status).toBe(409);
    expect(turns).toHaveLength(0);
    state.refuseStart = null;
    const delivered = await host.deliver(raw) as { status: number };
    expect(delivered.status).toBe(202);
    expect(turns).toHaveLength(1);
  });

  it("ignores an unbound account's event without consuming it, and delivers after binding", async () => {
    const { host, event, accounts, turns, account } = setup();
    accounts.unbind(account.accountId);
    const raw = event({ eventId: "ev-unbound" });
    const answer = await host.deliver(raw) as { status: number; body: { route: { action: string } } };
    expect(answer.status).toBe(200);
    expect(answer.body.route.action).toBe("unbound");
    expect(turns).toHaveLength(0);
    accounts.bind(account.accountId, "bot-1", "existing");
    const retried = await host.deliver(raw) as { status: number; body: { route: { action: string } } };
    expect(retried.body.route.action).toBe("delivered");
    expect(turns).toHaveLength(1);
  });

  it("consumes an empty event without a turn", async () => {
    const { host, event, turns } = setup();
    const raw = event({ eventId: "ev-empty", text: undefined });
    const answer = await host.deliver(raw) as { status: number };
    expect(answer.status).toBe(200);
    expect(turns).toHaveLength(0);
    const again = await host.deliver(raw) as { status: number; body: { route: { reason: string } } };
    expect(again.body.route.reason).toBe("duplicate");
  });

  it("keeps the conversation mapping on disk and reuses the thread after a new host reads it", async () => {
    const first = setup();
    const created = await first.host.deliver(first.event()) as { status: number; body: { threadId: string } };
    expect(created.status).toBe(202);
    expect(first.host.threadOf(first.account.accountId, "conv-1")).toBe(created.body.threadId);

    const second = createPlatformInboundHost({
      accounts: first.accounts, outbox: first.outbox, dataDir: first.folder,
      store: first.createdTasks.length ? {
        taskByThread: (_botId: string, threadId: string) => ({ threadId }),
        createTask: () => ({ threadId: "th_new" }),
      } : { taskByThread: () => null, createTask: () => null },
      canStart: () => true, threadBusy: () => false,
      startTurn: async () => ({ ok: true, text: "" }),
    });
    expect(second.threadOf(first.account.accountId, "conv-1")).toBe(created.body.threadId);
  });

  it("answers every message when no share is set, which is what an existing binding expects", async () => {
    const { host, event, turns } = setup();
    const delivered = await host.deliver(event({ text: "随便说一句" }));
    expect(delivered.status).toBe(202);
    expect(turns).toHaveLength(1);
  });

  it("stays silent on an unaddressed message when the share is low, without opening a turn", async () => {
    const { host, event, turns } = setup({ names: ["EACbot"], share: 0.1 });
    const delivered = await host.deliver(event({ text: "周六再说吧", conversation: { id: "g1", kind: "group" } }));
    // Delivered and deliberately not answered: the event is consumed, no turn runs, nothing is retried.
    expect(delivered).toMatchObject({ status: 200, body: { silent: true } });
    expect(turns).toHaveLength(0);
  });

  it("always answers a message that names the bot", async () => {
    const { host, event, turns } = setup({ names: ["EACbot"], share: 0.05 });
    const delivered = await host.deliver(event({ text: "EACbot 你来说说", conversation: { id: "g1", kind: "group" } }));
    expect(delivered.status).toBe(202);
    expect(turns).toHaveLength(1);
  });

  it("does not ask again for a message it chose not to answer", async () => {
    const { host, event, turns } = setup({ names: ["EACbot"], share: 0.05 });
    const payload = event({ text: "周六再说吧", conversation: { id: "g1", kind: "group" } });
    await host.deliver(payload);
    // The same event again is a duplicate, not a second chance to answer.
    const again = await host.deliver(payload);
    expect(again.status).toBe(200);
    expect(turns).toHaveLength(0);
  });
});
