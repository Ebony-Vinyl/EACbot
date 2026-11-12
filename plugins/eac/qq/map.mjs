// OneBot v11 <-> EACbot platform wire. Pure functions only: no sockets, no files, so the mapping can be tested
// without a QQ account. The server owns dedupe and echo detection, so this layer forwards self messages too.

/** OneBot reports `message` as an array of segments, or as a CQ-coded string on older bridges. */
export function textOf(event) {
  const message = event?.message;
  if (Array.isArray(message)) {
    return message
      .filter((segment) => segment && segment.type === "text")
      .map((segment) => String(segment.data?.text ?? ""))
      .join("")
      .trim()
      .slice(0, 20_000);
  }
  if (typeof message === "string") return cqToText(message);
  if (typeof event?.raw_message === "string") return cqToText(event.raw_message);
  return "";
}

function cqToText(raw) {
  return raw
    .replace(/\[CQ:[^\]]*\]/g, "")
    .replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&#44;/g, ",").replace(/&amp;/g, "&")
    .trim()
    .slice(0, 20_000);
}

const CONVERSATION_KIND = { group: "group", private: "direct", discuss: "group" };

/**
 * One OneBot message event as the host's inbound wire. `null` when the event is not a message the bridge can carry:
 * an empty body, a sub-type with no conversation (guild/channel, which OneBot v11 leaves to another protocol), or a
 * missing id. Nothing is guessed to make an event fit.
 */
export function toInbound(event, options) {
  const { accountId } = options;
  if (!event || typeof event !== "object") return null;
  if (event.post_type !== "message" && event.post_type !== "message_sent") return null;

  const kind = CONVERSATION_KIND[event.message_type];
  if (!kind) return null;

  const conversationId = String(kind === "group" ? event.group_id ?? "" : event.user_id ?? "");
  if (!conversationId) return null;

  const messageId = event.message_id;
  if (messageId === undefined || messageId === null || messageId === "") return null;

  const senderId = String(event.user_id ?? event.sender?.user_id ?? "");
  if (!senderId) return null;

  const text = textOf(event);
  if (!text) return null;

  const seconds = Number(event.time);
  const receivedAt = Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();

  const name = String(event.sender?.card || event.sender?.nickname || "").trim().slice(0, 200);

  return {
    eventId: `qq-${String(messageId).slice(0, 120)}`,
    platform: "qq",
    accountId,
    conversation: { id: conversationId.slice(0, 200), kind },
    sender: name ? { id: senderId.slice(0, 200), name } : { id: senderId.slice(0, 200) },
    receivedAt,
    text,
  };
}

/**
 * One outbox reply as a OneBot action. `unsupported` instead of a best guess: OneBot v11 has no channel or comment
 * send, and posting a group reply as a private message would reach the wrong conversation.
 */
export function toAction(message) {
  if (!message || typeof message !== "object") return { unsupported: "not a message" };
  const text = String(message.text ?? "").trim();
  if (!text) return { unsupported: "empty text" };
  const conversationId = String(message.conversationId ?? "");
  if (!/^[0-9]{1,20}$/.test(conversationId)) return { unsupported: `conversation ${conversationId.slice(0, 40)} is not a QQ number` };
  if (message.conversationKind === "group") {
    return { action: "send_group_msg", params: { group_id: Number(conversationId), message: text } };
  }
  if (message.conversationKind === "direct") {
    return { action: "send_private_msg", params: { user_id: Number(conversationId), message: text } };
  }
  return { unsupported: `OneBot v11 cannot send a ${String(message.conversationKind).slice(0, 20)} reply` };
}

/** A OneBot `retcode` of 0 is the only success; anything else is refused as it came. */
export function refusedByOneBot(response) {
  if (!response || typeof response !== "object") return "the bridge answered with no reply";
  const code = response.retcode;
  if (code === 0) return null;
  const detail = response.wording ?? response.message ?? response.data?.message ?? "";
  return `OneBot retcode ${String(code)}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`;
}

/**
 * Whether a conversation is one this bridge may carry. A bridge whose account sits in real groups would otherwise
 * copy other people's messages into the host; only the conversations a person named are copied, and everything else
 * is dropped before it is ever written down. An empty list carries nothing, so a missing setting fails closed.
 */
export function allowedConversation(allow, conversation) {
  if (!Array.isArray(allow) || !allow.length) return false;
  const kind = conversation?.kind;
  const id = String(conversation?.id ?? "");
  if (!id) return false;
  return allow.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (entry.kind !== kind) return false;
    return String(entry.id ?? "") === id;
  });
}
