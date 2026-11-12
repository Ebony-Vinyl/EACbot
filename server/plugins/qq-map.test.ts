// The OneBot v11 <-> EACbot platform wire, tested without a QQ account: every shape a bridge can receive, and every
// way a reply can fail to reach a conversation.
import { describe, expect, it } from "vitest";

// The plugin is plain .mjs that its own process runs; the boundary is typed here, once, for this test.
interface InboundWire {
  eventId: string; platform: string; accountId: string;
  conversation: { id: string; kind: string };
  sender: { id: string; name?: string };
  receivedAt: string; text: string;
}
type Action = { action: string; params: Record<string, unknown>; unsupported?: never } | { unsupported: string; action?: never };
const map = (await import(new URL("../../plugins/eac/qq/map.mjs", import.meta.url).href)) as {
  textOf(event: unknown): string;
  toInbound(event: unknown, options: { accountId: string }): InboundWire | null;
  toAction(message: unknown): Action;
  refusedByOneBot(response: unknown): string | null;
  allowedConversation(allow: unknown, conversation: unknown): boolean;
};
const { toInbound, toAction, textOf, refusedByOneBot, allowedConversation } = map;

const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const at = (patch: Record<string, unknown> = {}) => ({
  post_type: "message",
  message_type: "group",
  message_id: 9001,
  group_id: 555,
  user_id: 777,
  time: 1_700_000_000,
  sender: { card: "小明", nickname: "ming" },
  message: [{ type: "text", data: { text: "你好" } }],
  ...patch,
});

describe("OneBot event to inbound wire", () => {
  it("carries a group message with its card name and its OneBot time", () => {
    expect(toInbound(at(), { accountId: ACCOUNT })).toEqual({
      eventId: "qq-9001",
      platform: "qq",
      accountId: ACCOUNT,
      conversation: { id: "555", kind: "group" },
      sender: { id: "777", name: "小明" },
      receivedAt: "2023-11-14T22:13:20.000Z",
      text: "你好",
    });
  });

  it("maps a private message to a direct conversation keyed by the sender", () => {
    const event = toInbound(at({ message_type: "private", group_id: undefined, message_id: 9002 }), { accountId: ACCOUNT });
    expect(event?.conversation).toEqual({ id: "777", kind: "direct" });
  });

  it("keeps a group message from its own account, so the host decides what is an echo", () => {
    const event = toInbound(at({ user_id: 555 }), { accountId: ACCOUNT });
    expect(event?.sender.id).toBe("555");
  });

  it("reads a CQ-coded string body and drops the segments that are not text", () => {
    expect(textOf({ message: "看图[CQ:image,file=a.png]谢谢" })).toBe("看图谢谢");
    expect(textOf({ message: [{ type: "at", data: { qq: 1 } }, { type: "text", data: { text: " @他" } }] })).toBe("@他");
    expect(textOf({ message: "纯图片[CQ:image,file=a.png]" })).toBe("纯图片");
  });

  it("refuses an event it cannot address instead of guessing a conversation", () => {
    expect(toInbound(at({ message_type: "guild" }), { accountId: ACCOUNT })).toBeNull();
    expect(toInbound(at({ message_type: undefined }), { accountId: ACCOUNT })).toBeNull();
    expect(toInbound(at({ message_id: undefined }), { accountId: ACCOUNT })).toBeNull();
    expect(toInbound(at({ user_id: undefined }), { accountId: ACCOUNT })).toBeNull();
    expect(toInbound(at({ post_type: "notice" }), { accountId: ACCOUNT })).toBeNull();
    expect(toInbound(null, { accountId: ACCOUNT })).toBeNull();
  });

  it("drops a message with no text, because the host has no turn for an attachment-only event", () => {
    expect(toInbound(at({ message: [{ type: "image", data: { file: "a.png" } }] }), { accountId: ACCOUNT })).toBeNull();
    expect(toInbound(at({ message: [{ type: "text", data: { text: "   " } }] }), { accountId: ACCOUNT })).toBeNull();
  });

  it("falls back to the present time when OneBot sends none, and trims an over-long name", () => {
    const event = toInbound(at({ time: undefined, sender: { nickname: "n".repeat(300) } }), { accountId: ACCOUNT });
    expect(event?.sender.name).toHaveLength(200);
    expect(Date.parse(event!.receivedAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("greets a sender with no name at all with an id-only sender", () => {
    expect(toInbound(at({ sender: {} }), { accountId: ACCOUNT })?.sender).toEqual({ id: "777" });
  });

  it("keeps one event id per QQ message, so a redelivered event is the same event", () => {
    const first = toInbound(at(), { accountId: ACCOUNT });
    const again = toInbound(at({ time: 1_700_000_999 }), { accountId: ACCOUNT });
    expect(again?.eventId).toBe(first?.eventId);
  });
});

describe("outbox reply to OneBot action", () => {
  it("sends a group reply to the group", () => {
    expect(toAction({ conversationKind: "group", conversationId: "555", text: "回复" }))
      .toEqual({ action: "send_group_msg", params: { group_id: 555, message: "回复" } });
  });

  it("sends a direct reply to the person", () => {
    expect(toAction({ conversationKind: "direct", conversationId: "777", text: "回复" }))
      .toEqual({ action: "send_private_msg", params: { user_id: 777, message: "回复" } });
  });

  it("refuses a conversation OneBot v11 has no verb for, rather than sending it somewhere else", () => {
    expect(toAction({ conversationKind: "channel", conversationId: "777", text: "x" }).unsupported).toMatch(/channel/);
    expect(toAction({ conversationKind: "comment", conversationId: "777", text: "x" }).unsupported).toMatch(/comment/);
  });

  it("refuses a conversation id that is not a QQ number", () => {
    expect(toAction({ conversationKind: "group", conversationId: "group@abc", text: "x" }).unsupported).toMatch(/not a QQ number/);
    expect(toAction({ conversationKind: "group", conversationId: "", text: "x" }).unsupported).toMatch(/not a QQ number/);
  });

  it("refuses an empty reply", () => {
    expect(toAction({ conversationKind: "group", conversationId: "555", text: "  " }).unsupported).toBe("empty text");
    expect(toAction(null).unsupported).toBe("not a message");
  });
});

describe("OneBot receipts", () => {
  it("accepts only retcode 0", () => {
    expect(refusedByOneBot({ retcode: 0 })).toBeNull();
  });

  it("reports the refusal verbatim, with the bridge's own words when it has them", () => {
    expect(refusedByOneBot({ retcode: 100, wording: "bad request" })).toBe("OneBot retcode 100: bad request");
    expect(refusedByOneBot({ retcode: 1404, data: { message: "群不存在" } })).toBe("OneBot retcode 1404: 群不存在");
    expect(refusedByOneBot({ retcode: 1200 })).toBe("OneBot retcode 1200");
  });

  it("treats a missing answer as unresolved, not as success", () => {
    expect(refusedByOneBot(undefined)).toBe("the bridge answered with no reply");
    expect(refusedByOneBot(null)).toBe("the bridge answered with no reply");
    expect(refusedByOneBot({})).toBe("OneBot retcode undefined");
  });
});

describe("which conversations a bridge may carry", () => {
  const group = (id: string) => ({ id, kind: "group" });
  const direct = (id: string) => ({ id, kind: "direct" });

  it("carries exactly the named conversation", () => {
    const allow = [{ kind: "group", id: "1076986686" }];
    expect(allowedConversation(allow, group("1076986686"))).toBe(true);
    expect(allowedConversation(allow, group("999"))).toBe(false);
    // The same number as a direct chat is a different conversation.
    expect(allowedConversation(allow, direct("1076986686"))).toBe(false);
  });

  it("carries nothing when no conversation is named", () => {
    // The safe default for a real account: an unset list must never mean "everything".
    expect(allowedConversation([], group("1076986686"))).toBe(false);
    expect(allowedConversation(undefined, group("1076986686"))).toBe(false);
    expect(allowedConversation(null, group("1076986686"))).toBe(false);
    expect(allowedConversation("group:1076986686", group("1076986686"))).toBe(false);
  });

  it("carries a direct chat only when it is the one named", () => {
    const allow = [{ kind: "direct", id: "1708242743" }];
    expect(allowedConversation(allow, direct("1708242743"))).toBe(true);
    expect(allowedConversation(allow, direct("1981762182"))).toBe(false);
  });

  it("ignores a malformed entry instead of widening the list", () => {
    const allow = [null, "group:1", { kind: "group" }, { id: "1" }, { kind: "group", id: "1076986686" }];
    expect(allowedConversation(allow, group("1076986686"))).toBe(true);
    expect(allowedConversation(allow, group(""))).toBe(false);
  });
});
