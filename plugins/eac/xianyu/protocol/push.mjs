// The message gateway's push frames.
//
// A push frame carries `syncPushPackage.data[]`, and each entry's `data` is base64 over MessagePack. A decoded
// message names its conversation in field "2" and its timestamp in field "5"; both appear as strings in the
// decoded map, and both are stripped of the `@` suffix the gateway appends to service-scoped ids.
//
// The decoding is a plain base64 + MessagePack read, not a decryption: the frame is not encrypted, only packed.
// A frame that does not decode is reported and skipped; it is never guessed at.

const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

/** A small MessagePack reader: enough for the gateway's maps, arrays, strings and integers. */
export function readMsgpack(bytes, offset = 0) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const read = (at) => {
    const byte = view[at];
    if (byte === undefined) throw new Error("msgpack ended early");
    if (byte <= 0x7f) return { value: byte, next: at + 1 };
    if (byte >= 0xe0) return { value: byte - 0x100, next: at + 1 };
    if ((byte & 0xf0) === 0x80) {
      const count = byte & 0x0f;
      const map = {};
      let cursor = at + 1;
      for (let index = 0; index < count; index += 1) {
        const key = read(cursor);
        const value = read(key.next);
        map[String(key.value)] = value.value;
        cursor = value.next;
      }
      return { value: map, next: cursor };
    }
    if ((byte & 0xf0) === 0x90) {
      const count = byte & 0x0f;
      const list = [];
      let cursor = at + 1;
      for (let index = 0; index < count; index += 1) {
        const item = read(cursor);
        list.push(item.value);
        cursor = item.next;
      }
      return { value: list, next: cursor };
    }
    if ((byte & 0xe0) === 0xa0) {
      const length = byte & 0x1f;
      return { value: new TextDecoder().decode(view.subarray(at + 1, at + 1 + length)), next: at + 1 + length };
    }
    switch (byte) {
      case 0xc0: return { value: null, next: at + 1 };
      case 0xc2: return { value: false, next: at + 1 };
      case 0xc3: return { value: true, next: at + 1 };
      case 0xcc: return { value: view[at + 1], next: at + 2 };
      case 0xcd: return { value: (view[at + 1] << 8) | view[at + 2], next: at + 3 };
      case 0xce: return { value: ((view[at + 1] << 24) | (view[at + 2] << 16) | (view[at + 3] << 8) | view[at + 4]) >>> 0, next: at + 5 };
      case 0xd0: return { value: (view[at + 1] << 24) >> 24, next: at + 2 };
      case 0xd1: return { value: ((view[at + 1] << 8) | view[at + 2]) << 16 >> 16, next: at + 3 };
      case 0xd9: { const length = view[at + 1]; return { value: new TextDecoder().decode(view.subarray(at + 2, at + 2 + length)), next: at + 2 + length }; }
      case 0xda: { const length = (view[at + 1] << 8) | view[at + 2]; return { value: new TextDecoder().decode(view.subarray(at + 3, at + 3 + length)), next: at + 3 + length }; }
      case 0xdb: {
        const length = (view[at + 1] << 24) | (view[at + 2] << 16) | (view[at + 3] << 8) | view[at + 4];
        return { value: new TextDecoder().decode(view.subarray(at + 5, at + 5 + length)), next: at + 5 + length };
      }
      case 0xdc: { const count = (view[at + 1] << 8) | view[at + 2]; const list = []; let cursor = at + 3; for (let index = 0; index < count; index += 1) { const item = read(cursor); list.push(item.value); cursor = item.next; } return { value: list, next: cursor }; }
      case 0xde: {
        const count = (view[at + 1] << 8) | view[at + 2];
        const map = {};
        let cursor = at + 3;
        for (let index = 0; index < count; index += 1) {
          const key = read(cursor);
          const value = read(key.next);
          map[String(key.value)] = value.value;
          cursor = value.next;
        }
        return { value: map, next: cursor };
      }
      default:
        throw new Error(`msgpack byte 0x${byte.toString(16)} is not handled`);
    }
  };
  return read(offset).value;
}

/** Base64 → MessagePack → a map, or a plain JSON string when the frame was not packed at all. */
export function decodePushPayload(data) {
  if (data === null || data === undefined) return null;
  if (typeof data === "object") return data;
  const text = String(data).replace(/[^\x20-\x7e]/g, "");
  if (!text) return null;
  const attempt = (value) => {
    const bytes = Buffer.from(value, "base64");
    if (!bytes.length) return null;
    try {
      return readMsgpack(bytes);
    } catch {
      return null;
    }
  };
  let decoded = attempt(text);
  if (decoded === null && !text.endsWith("=")) decoded = attempt(`${text}${"=".repeat((4 - (text.length % 4)) % 4)}`);
  if (decoded !== null) return decoded;
  if (BASE64.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripServiceSuffix(value) {
  return typeof value === "string" ? value.replace(/@[^@]*$/, "") : value;
}

function firstText(...values) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

/**
 * One decoded push body into the message the line forwards, or null when the frame is not a chat message
 * (a read receipt, a typing notice, a system event).
 */
export function normalizeMessage(body) {
  if (!body || typeof body !== "object") return null;
  const message = body.message ?? body.msg ?? body;
  const conversationId = stripServiceSuffix(firstText(message["2"], body.cid, message.cid));
  if (!conversationId) return null;
  const messageId = firstText(message.messageId, message["6"], body.messageId, message.msgId);
  if (!messageId) return null;
  const text = firstText(message.text, message.content, message["7"] && typeof message["7"] === "string" ? message["7"] : undefined);
  const rawTime = message.time ?? message["5"] ?? body.time;
  const seconds = Number(rawTime);
  const receivedAt = Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds > 1e12 ? seconds : seconds * 1_000).toISOString()
    : new Date().toISOString();
  const isSelf = message.isSelf === true || message.self === true;
  return {
    conversationId,
    messageId,
    text: text ? String(text).slice(0, 20_000) : "",
    senderId: stripServiceSuffix(firstText(message.senderUserId, message.senderId, body.senderId)) ?? conversationId,
    senderName: firstText(message.senderName, message.senderNick),
    receivedAt,
    isSelf,
  };
}

/** Every chat message in a push frame, in the order the gateway listed them. */
export function messagesFromPush(frame) {
  const packages = frame?.body?.syncPushPackage ?? frame?.syncPushPackage;
  const rows = Array.isArray(packages?.data) ? packages.data : [];
  const found = [];
  for (const row of rows) {
    let decoded;
    try {
      decoded = decodePushPayload(row?.data);
    } catch {
      continue;
    }
    const message = normalizeMessage(decoded);
    if (message) found.push(message);
  }
  return found;
}
