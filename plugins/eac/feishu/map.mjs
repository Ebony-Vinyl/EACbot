// Feishu event <-> EAC platform wire. Pure functions only: no process, no files, no network.

export const MAX_TEXT = 20_000;
export const EVENT_PREFIX = "feishu-";

export function parseChatModes(value) {
  const modes = new Map();
  for (const raw of String(value ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const separator = entry.lastIndexOf(":");
    if (separator <= 0) continue;
    const chatId = entry.slice(0, separator).trim();
    const mode = entry.slice(separator + 1).trim().toLowerCase();
    if (!/^oc_[A-Za-z0-9_-]+$/.test(chatId)) continue;
    if (mode !== "mentions" && mode !== "all") continue;
    modes.set(chatId, mode);
  }
  return modes;
}

export function parseAllowedSenders(value) {
  const ids = new Set();
  for (const raw of String(value ?? "").split(",")) {
    const id = raw.trim();
    if (/^ou_[A-Za-z0-9_-]+$/.test(id)) ids.add(id);
  }
  return ids;
}

export function isMentioned(event, botOpenId, botAppId) {
  const mentions = Array.isArray(event?.mentions) ? event.mentions : [];
  return mentions.some((mention) => {
    const id = String(mention?.id ?? "");
    return Boolean(id) && (id === botOpenId || (Boolean(botAppId) && id === botAppId));
  });
}

/** Decide whether this event is one this bridge may carry. */
export function filterInbound(event, config) {
  const senderId = String(event?.sender_id ?? "").trim();
  const senderType = String(event?.sender_type ?? "").toLowerCase();
  const chatId = String(event?.chat_id ?? "").trim();
  const chatType = String(event?.chat_type ?? "").toLowerCase();
  if (!senderId || !chatId) return { ok: false, reason: "missing-id" };
  if (senderType === "bot") return { ok: false, reason: "bot-sender" };
  if (senderId === config.botOpenId) return { ok: false, reason: "echo" };
  const allowed = parseAllowedSenders(config.allowedSenders);
  if (!allowed.has(senderId)) return { ok: false, reason: "sender-not-allowed" };
  if (chatType === "p2p") {
    return config.directMessages ? { ok: true, mode: "direct" } : { ok: false, reason: "direct-disabled" };
  }
  if (chatType !== "group") return { ok: false, reason: "unsupported-chat-type" };
  const configured = parseChatModes(config.chats);
  const mode = configured.get(chatId) ?? (config.otherChats === "mentions" ? "mentions" : null);
  if (!mode) return { ok: false, reason: "chat-not-allowed" };
  if (mode === "mentions" && !isMentioned(event, config.botOpenId, config.botAppId)) {
    return { ok: false, reason: "not-mentioned" };
  }
  return { ok: true, mode: "group" };
}

function receivedAt(value) {
  const numeric = Number(value);
  const millis = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(String(value ?? ""));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : new Date().toISOString();
}

export function toInbound(event, options) {
  const messageId = String(event?.message_id ?? event?.id ?? "").trim();
  const chatId = String(event?.chat_id ?? "").trim();
  const senderId = String(event?.sender_id ?? "").trim();
  const chatType = String(event?.chat_type ?? "").toLowerCase();
  const messageType = String(event?.message_type ?? "").toLowerCase();
  if (!messageId || !chatId || !senderId) return null;
  if (chatType !== "p2p" && chatType !== "group") return null;
  if (messageType !== "text") return null;
  if (String(event?.sender_type ?? "").toLowerCase() === "bot") return null;
  if (senderId === options.botOpenId) return null;
  const text = String(event?.content ?? "").trim().slice(0, MAX_TEXT);
  if (!text) return null;
  const parent = String(event?.reply_to ?? "").trim();
  return {
    eventId: EVENT_PREFIX + messageId,
    platform: "feishu",
    accountId: options.accountId,
    conversation: { id: chatId.slice(0, 200), kind: chatType === "p2p" ? "direct" : "group" },
    sender: { id: senderId.slice(0, 200) },
    receivedAt: receivedAt(event?.create_time),
    text,
    ...(parent ? { replyTo: EVENT_PREFIX + parent.slice(0, 190) } : {}),
  };
}

export function toReplyPlan(message) {
  if (!message || typeof message !== "object") return { unsupported: "not a message" };
  const text = String(message.text ?? "").trim();
  if (!text) return { unsupported: "empty text" };
  if (text.length > MAX_TEXT) return { unsupported: "text exceeds 20000 characters" };
  const conversationId = String(message.conversationId ?? "").trim();
  if (!/^oc_[A-Za-z0-9_-]+$/.test(conversationId)) return { unsupported: "conversation is not a Feishu chat id" };
  if (message.conversationKind !== "direct" && message.conversationKind !== "group") {
    return { unsupported: "Feishu cannot send a " + String(message.conversationKind).slice(0, 30) + " reply" };
  }
  const replyTo = String(message.replyToEventId ?? "");
  const replyId = replyTo.startsWith(EVENT_PREFIX) ? replyTo.slice(EVENT_PREFIX.length) : "";
  const reply = /^om_[A-Za-z0-9_-]+$/.test(replyId);
  const key = String(message.id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50);
  const common = ["im", reply ? "+messages-reply" : "+messages-send", "--as", "bot", "--text", "-"];
  if (key) common.push("--idempotency-key", key);
  if (reply) common.push("--message-id", replyId, "--reply-in-thread");
  else common.push("--chat-id", conversationId);
  return { command: "lark", args: common, reply, text };
}

export function eventIdOf(messageId) {
  return EVENT_PREFIX + String(messageId ?? "");
}

export function messageIdOf(eventId) {
  const value = String(eventId ?? "");
  return value.startsWith(EVENT_PREFIX) ? value.slice(EVENT_PREFIX.length) : "";
}
