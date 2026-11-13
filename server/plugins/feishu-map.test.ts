// Feishu event <-> EAC platform wire, without a Feishu account.
import { describe, expect, it } from "vitest";

interface InboundWire {
  eventId: string; platform: string; accountId: string;
  conversation: { id: string; kind: string };
  sender: { id: string; name?: string };
  receivedAt: string; text: string; replyTo?: string;
}
type ReplyPlan = { unsupported?: string; args?: string[]; reply?: boolean; text?: string };
const map = (await import(new URL("../../plugins/eac/feishu/map.mjs", import.meta.url).href)) as {
  parseChatModes(value: unknown): Map<string, string>;
  parseAllowedSenders(value: unknown): Set<string>;
  filterInbound(event: unknown, config: Record<string, unknown>): { ok: boolean; mode?: string; reason?: string };
  toInbound(event: unknown, options: { accountId: string; botOpenId: string }): InboundWire | null;
  toReplyPlan(message: unknown): ReplyPlan;
};
const { parseChatModes, parseAllowedSenders, filterInbound, toInbound, toReplyPlan } = map;

const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const BOT = "ou_bot";
const at = (patch: Record<string, unknown> = {}) => ({
  type: "im.message.receive_v1",
  message_id: "om_9001",
  chat_id: "oc_chat1",
  chat_type: "group",
  message_type: "text",
  sender_id: "ou_user",
  sender_type: "user",
  content: "你好",
  create_time: "1700000000000",
  mentions: [{ id: BOT, name: "Bot" }],
  ...patch,
});

const config = (patch: Record<string, unknown> = {}) => ({
  botOpenId: BOT,
  botAppId: "cli_bot",
  chats: "oc_chat1:mentions",
  allowedSenders: "ou_user",
  directMessages: true,
  otherChats: "none",
  ...patch,
});

describe("Feishu bridge configuration", () => {
  it("parses chat modes and ignores malformed entries", () => {
    expect([...parseChatModes("oc_a:mentions, oc_b:all, bad, oc_c:nope")]).toEqual([["oc_a", "mentions"], ["oc_b", "all"]]);
    expect(parseAllowedSenders("ou_a, ou_b, bad").size).toBe(2);
  });

  it("fails closed when the allowed sender list is empty", () => {
    expect(filterInbound(at(), config({ allowedSenders: "" }))).toMatchObject({ ok: false, reason: "sender-not-allowed" });
  });
});

describe("Feishu inbound routing", () => {
  it("accepts a mentioned group message from an allowed sender", () => {
    expect(filterInbound(at(), config())).toEqual({ ok: true, mode: "group" });
  });

  it("rejects an unmentioned group message in mentions mode", () => {
    expect(filterInbound(at({ mentions: [] }), config())).toMatchObject({ ok: false, reason: "not-mentioned" });
  });

  it("accepts a direct message and rejects it when disabled", () => {
    const direct = at({ chat_type: "p2p", chat_id: "oc_dm", message_id: "om_dm", mentions: [] });
    expect(filterInbound(direct, config())).toEqual({ ok: true, mode: "direct" });
    expect(filterInbound(direct, config({ directMessages: false }))).toMatchObject({ ok: false, reason: "direct-disabled" });
  });

  it("rejects bot senders and the bot's own echo", () => {
    expect(filterInbound(at({ sender_type: "bot" }), config())).toMatchObject({ ok: false, reason: "bot-sender" });
    expect(filterInbound(at({ sender_id: BOT }), config({ allowedSenders: BOT }))).toMatchObject({ ok: false, reason: "echo" });
  });
});

describe("Feishu platform event", () => {
  it("maps a group message with a stable message_id event id", () => {
    expect(toInbound(at(), { accountId: ACCOUNT, botOpenId: BOT })).toMatchObject({
      eventId: "feishu-om_9001",
      platform: "feishu",
      accountId: ACCOUNT,
      conversation: { id: "oc_chat1", kind: "group" },
      sender: { id: "ou_user" },
      text: "你好",
    });
  });

  it("maps p2p to direct and keeps a parent reply id", () => {
    const event = toInbound(at({ chat_type: "p2p", chat_id: "oc_dm", message_id: "om_dm", reply_to: "om_parent", mentions: [] }), { accountId: ACCOUNT, botOpenId: BOT });
    expect(event?.conversation).toEqual({ id: "oc_dm", kind: "direct" });
    expect(event?.replyTo).toBe("feishu-om_parent");
  });

  it("rejects non-text, empty, malformed, and self messages", () => {
    expect(toInbound(at({ message_type: "image" }), { accountId: ACCOUNT, botOpenId: BOT })).toBeNull();
    expect(toInbound(at({ content: "   " }), { accountId: ACCOUNT, botOpenId: BOT })).toBeNull();
    expect(toInbound(at({ chat_type: "channel" }), { accountId: ACCOUNT, botOpenId: BOT })).toBeNull();
    expect(toInbound(at({ sender_type: "bot" }), { accountId: ACCOUNT, botOpenId: BOT })).toBeNull();
    expect(toInbound(at({ sender_id: BOT }), { accountId: ACCOUNT, botOpenId: BOT })).toBeNull();
    expect(toInbound(at({ message_id: "" }), { accountId: ACCOUNT, botOpenId: BOT })).toBeNull();
  });
});

describe("Feishu outbox plan", () => {
  it("replies to the source message with a deterministic idempotency key", () => {
    const plan = toReplyPlan({ id: "msg_1", conversationId: "oc_chat1", conversationKind: "group", text: "回复", replyToEventId: "feishu-om_9001" });
    expect(plan.reply).toBe(true);
    expect(plan.args).toContain("+messages-reply");
    expect(plan.args).toContain("--reply-in-thread");
    expect(plan.args).toContain("om_9001");
    expect(plan.args).toContain("msg_1");
    expect(plan.text).toBe("回复");
  });

  it("uses a chat send when there is no reply target", () => {
    const plan = toReplyPlan({ id: "msg_2", conversationId: "oc_chat1", conversationKind: "direct", text: "主动", replyToEventId: null });
    expect(plan.reply).toBe(false);
    expect(plan.args).toContain("--chat-id");
    expect(plan.args).toContain("oc_chat1");
  });

  it("refuses unsupported conversations and empty text", () => {
    expect(toReplyPlan({ conversationKind: "group", conversationId: "oc_x", text: "" }).unsupported).toMatch(/empty/);
    expect(toReplyPlan({ conversationKind: "channel", conversationId: "oc_x", text: "x" }).unsupported).toMatch(/channel/);
    expect(toReplyPlan({ conversationKind: "group", conversationId: "not-a-chat", text: "x" }).unsupported).toMatch(/chat id/);
  });
});
