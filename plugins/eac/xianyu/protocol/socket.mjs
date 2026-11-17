// The message gateway's socket and verbs.
//
// The gateway speaks LWP over a WebSocket: a JSON frame names a path under `/r/` and carries its arguments,
// and the answer comes back with the same `mid`. A heartbeat every 15 seconds keeps the connection; a token
// error closes it, which is the cue to mint a new token rather than to retry the same call.
//
// Nothing here retries a send. A send that was written to a socket and never answered leaves the reply in the
// outbox, so the worst case is a reply a person sends again — never the same reply sent twice.
import { TransportError } from "../transport.mjs";
import { createTokenSource } from "./token.mjs";
import { messagesFromPush } from "./push.mjs";

/** The gateway the desktop web client connects to. */
export const IM_SOCKET = "wss://wss-goofish.dingtalk.com/";
const HEARTBEAT_MS = 15_000;
const SEND_TIMEOUT_MS = 30_000;
const RECONNECT_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export const LWP = {
  register: "/reg",
  heartbeat: "/!",
  conversations: "/r/Conversation/listNewestPagination",
  history: "/r/MessageManager/listUserMessages",
  send: "/r/MessageSend/sendByReceiverScope",
};

/** The gateway's request id: a counter and a timestamp, as its own client builds it. */
export function nextMid(sequence, now = Date.now()) {
  return `${sequence}${now} 0`;
}

export function createProtocolTransport({ getCookie, setCookie, fetchImpl = fetch, socketFactory, now = () => Date.now(), accountId, socketUrl = IM_SOCKET }) {
  const tokens = createTokenSource({ getCookie, setCookie, fetchImpl, now });
  let socket = null;
  let closed = false;
  let sequence = 1;
  let heartbeat = null;
  let reconnect = null;
  let backoff = 0;
  let onEvent = null;
  let connecting = false;
  const waiting = new Map();
  const state = { connected: false, lastConnectAt: null, lastError: null, fatal: false, received: 0, sent: 0 };

  const open = () => socket && socket.readyState === 1;

  const fail = (error) => {
    state.lastError = String(error instanceof Error ? error.message : error).slice(0, 400);
    return error;
  };

  function frame(path, body, mid) {
    return JSON.stringify({ lwp: path, headers: { mid: mid ?? nextMid(sequence++, now()) }, body });
  }

  function request(path, body, timeoutMs = SEND_TIMEOUT_MS) {
    if (!open()) throw new TransportError("disconnected", "The message gateway is not connected.", true);
    const mid = nextMid(sequence++, now());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!waiting.delete(mid)) return;
        reject(new TransportError("no-receipt", `${path} got no answer in ${Math.round(timeoutMs / 1000)}s; its result is unknown.`, false));
      }, timeoutMs);
      timer.unref?.();
      waiting.set(mid, { resolve, reject, timer });
      try {
        socket.send(frame(path, body, mid));
      } catch (error) {
        waiting.delete(mid);
        clearTimeout(timer);
        reject(fail(new TransportError("disconnected", `The socket refused the frame: ${error.message}`, true)));
      }
    });
  }

  function settle(mid, payload) {
    const pending = waiting.get(mid);
    if (!pending) return;
    waiting.delete(mid);
    clearTimeout(pending.timer);
    pending.resolve(payload);
  }

  function onMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    const mid = parsed?.headers?.mid;
    if (mid && waiting.has(mid)) {
      settle(mid, parsed);
      return;
    }
    for (const message of messagesFromPush(parsed)) {
      if (message.isSelf) continue;
      state.received += 1;
      try {
        onEvent?.(message);
      } catch (error) {
        fail(error);
      }
    }
  }

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  function teardown(reason) {
    stopHeartbeat();
    for (const [, pending] of waiting) {
      clearTimeout(pending.timer);
      pending.reject(new TransportError("disconnected", `The socket closed before it answered: ${reason}`, true));
    }
    waiting.clear();
    state.connected = false;
    if (socket) {
      try { socket.close(); } catch { /* already closed */ }
    }
    socket = null;
  }

  function scheduleReconnect() {
    if (closed || reconnect) return;
    const wait = RECONNECT_MS[Math.min(backoff, RECONNECT_MS.length - 1)];
    backoff += 1;
    reconnect = setTimeout(() => {
      reconnect = null;
      void connect();
    }, wait);
    reconnect.unref?.();
  }

  async function connect() {
    if (closed || connecting) return;
    connecting = true;
    try {
      let token;
      try {
        token = await tokens.token();
      } catch (error) {
        fail(error);
        state.fatal = error.code === "session-expired" || error.code === "no-login";
        scheduleReconnect();
        return;
      }
      // The socket carries no auth of its own: the token goes in the `/reg` frame below, which is what the
      // gateway reads. Node's WebSocket takes protocols as its second argument, so nothing else is passed here.
      const factory = socketFactory ?? ((url) => new WebSocket(url));
      let opened;
      try {
        opened = factory(socketUrl);
      } catch (error) {
        fail(error);
        scheduleReconnect();
        return;
      }
      socket = opened;
      const onOpen = async () => {
        state.connected = true;
        state.lastConnectAt = new Date(now()).toISOString();
        state.fatal = false;
        backoff = 0;
        try {
          await request(LWP.register, { token, headers: { token } }, 20_000);
        } catch (error) {
          fail(error);
        }
        stopHeartbeat();
        heartbeat = setInterval(() => {
          if (!open()) return;
          try { socket.send(frame(LWP.heartbeat, {})); } catch { /* the close handler reconnects */ }
        }, HEARTBEAT_MS);
        heartbeat.unref?.();
      };
      if (typeof opened.on === "function") opened.on("open", onOpen);
      else opened.addEventListener("open", onOpen);
      const onClose = (event) => {
        const reason = event?.reason || "closed";
        const tokenError = /token/i.test(String(reason));
        if (tokenError) tokens.invalidate();
        teardown(String(reason));
        if (tokenError) void connect();
        else scheduleReconnect();
      };
      if (typeof opened.on === "function") {
        opened.on("message", onMessage);
        opened.on("close", onClose);
        opened.on("error", (error) => fail(error));
      } else {
        opened.addEventListener("message", (event) => onMessage(event.data));
        opened.addEventListener("close", onClose);
        opened.addEventListener("error", (error) => fail(error));
      }
    } finally {
      connecting = false;
    }
  }

  return {
    name: "protocol",
    async start(handler) {
      onEvent = handler;
      closed = false;
      await connect();
    },
    async stop() {
      closed = true;
      if (reconnect) clearTimeout(reconnect);
      reconnect = null;
      teardown("stopped");
    },
    /** Sends one reply; resolves only when the gateway answered without a refusal. */
    async send(message) {
      if (!open()) throw new TransportError("disconnected", "The message gateway is not connected.", true);
      const body = {
        msg: {
          "@type": "com.alibaba.idle.im.message.Message",
          conversationId: message.conversationId,
          contentType: 1,
          text: { content: message.text },
        },
        receiverScope: message.conversationKind === "group" ? 2 : 1,
      };
      const answer = await request(LWP.send, body);
      const refusal = refusalOf(answer);
      if (refusal) throw new TransportError("not-sent", `The gateway refused the message: ${refusal}`, false);
      state.sent += 1;
      return { ok: true };
    },
    /** The conversations the account has, newest first; used by the board's inbox count. */
    async conversations({ page = 1, pageSize = 20 } = {}) {
      const answer = await request(LWP.conversations, { pageNumber: page, pageSize }, 20_000);
      const rows = answer?.body?.data ?? answer?.body?.result ?? [];
      return Array.isArray(rows) ? rows : [];
    },
    state() {
      return {
        mode: "protocol",
        connected: state.connected,
        fatal: state.fatal,
        lastConnectAt: state.lastConnectAt,
        lastError: state.lastError,
        received: state.received,
        sent: state.sent,
        token: tokens.peek(),
        accountId,
      };
    },
  };
}

/** A gateway answer that carries a non-zero code refused the request; its text is what a person reads. */
export function refusalOf(answer) {
  const body = answer?.body;
  if (!body) return null;
  const code = body.code ?? body.retCode ?? body.status;
  if (code === undefined || code === null || code === 0 || code === "0" || code === "SUCCESS") return null;
  const said = body.message ?? body.msg ?? body.desc ?? JSON.stringify(body).slice(0, 200);
  return `${code}: ${said}`;
}
