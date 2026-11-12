// eac.qq — the OneBot v11 side of a QQ platform account: OneBot events become EACbot inbound events, and the bot's
// replies in the outbox go back as OneBot sends. The host owns dedupe, echo detection, routing and the turn itself;
// this bridge only carries bytes between one OneBot connection and one platform account.
//
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult, shutdown -> exit.
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import WebSocket from "ws";

import { allowedConversation, refusedByOneBot, toAction, toInbound } from "./map.mjs";

const CONFIG = join(process.cwd(), "config.json");
const STATE = join(process.cwd(), "qq-bridge-state.json");
const POLL_MS = 1_000;
const MAX_QUEUE = 200;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

class ToolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function readConfig() {
  if (!existsSync(CONFIG)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    throw new ToolError("config-invalid", "config.json is not valid JSON", false);
  }
  const onebotUrl = String(parsed.onebotUrl ?? "").trim();
  const accountId = String(parsed.accountId ?? "").trim();
  const serverUrl = String(parsed.serverUrl ?? "http://127.0.0.1:8799").trim().replace(/\/+$/, "");
  if (!onebotUrl) throw new ToolError("config-missing", "config.json needs onebotUrl (ws://host:port of the OneBot v11 connection)", false);
  if (!/^wss?:\/\//.test(onebotUrl)) throw new ToolError("config-invalid", "onebotUrl must start with ws:// or wss://", false);
  if (!/^[0-9a-f-]{36}$/.test(accountId)) throw new ToolError("config-missing", "config.json needs accountId: the id of this QQ platform account in EACbot", false);
  return {
    onebotUrl,
    onebotToken: String(parsed.onebotToken ?? "").trim(),
    accountId,
    serverUrl,
    serverToken: String(parsed.serverToken ?? "").trim(),
    pollMs: Math.min(Math.max(Number(parsed.pollMs) || POLL_MS, 250), 30_000),
    // Empty carries nothing: an account in real groups must not copy them until a person names one.
    allow: Array.isArray(parsed.allow) ? parsed.allow : [],
  };
}

/** What the bridge has done, for qq-bridge-status and for the person reading it after a failure. */
const status = {
  startedAt: null,
  connected: false,
  lastConnectAt: null,
  lastDisconnectAt: null,
  lastError: null,
  inboundQueued: 0,
  inboundDelivered: 0,
  inboundRefused: 0,
  inboundSkipped: 0,
  outboundSent: 0,
  outboundPending: 0,
  lastInboundAt: null,
  lastOutboundAt: null,
};

function loadState() {
  if (!existsSync(STATE)) return { schemaVersion: 1, inbound: [], lastAckedId: null };
  try {
    const parsed = JSON.parse(readFileSync(STATE, "utf8"));
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.inbound)) throw new Error("shape");
    return parsed;
  } catch {
    throw new ToolError("state-corrupt", "qq-bridge-state.json does not match schema version 1; move it aside to start clean", false);
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE), { recursive: true, mode: 0o700 });
  const temporary = `${STATE}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, STATE);
}

/** Survives a restart: an event taken from OneBot but not yet delivered is delivered instead of lost. */
const state = loadState();

let socket = null;
let closed = false;
let backoff = 0;
let reconnectTimer = null;
let pollTimer = null;
let actionSeq = 1;
const callingActions = new Map();
let config = null;
let connecting = false;
let tickMs = POLL_MS;
/** One flush at a time, each way: a second pass would deliver or send the same entry twice. */
let flushingInbound = false;
let flushingOutbox = false;

function headers() {
  const sent = { "content-type": "application/json" };
  if (config?.serverToken) sent.authorization = `Bearer ${config.serverToken}`;
  return sent;
}

function note(error) {
  status.lastError = String(error instanceof Error ? error.message : error).slice(0, 400);
}

async function deliver(entry) {
  let response;
  try {
    response = await fetch(`${config.serverUrl}/api/platforms/inbound`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(entry.event),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    // The host was unreachable: keep it queued, the same event id is safe to send again.
    note(error);
    return false;
  }
  if (response.status === 202 || response.status === 200) {
    status.inboundDelivered += 1;
    status.lastInboundAt = new Date().toISOString();
    return true;
  }
  const body = await response.json().catch(() => null);
  if (response.status === 409) {
    // Busy or out of threads: the host did not consume the event, so it stays queued for a later attempt.
    note(`inbound refused: ${body?.error ?? response.status}`);
    return false;
  }
  // 400/404/422 cannot be fixed by sending it again: record it and drop it rather than retry forever.
  status.inboundRefused += 1;
  note(`inbound rejected (${response.status}): ${body?.error ?? "no detail"}`);
  state.inbound = state.inbound.filter((row) => row.event.eventId !== entry.event.eventId);
  return true;
}

async function flushInbound() {
  if (!config || flushingInbound) return;
  flushingInbound = true;
  try {
    await flushInboundOnce();
  } finally {
    flushingInbound = false;
  }
}

async function flushInboundOnce() {
  for (const entry of state.inbound) {
    const done = await deliver(entry);
    if (done) {
      state.inbound = state.inbound.filter((row) => row !== entry);
      saveState(state);
    } else break;
  }
  status.inboundQueued = state.inbound.length;
}

/** The bridge connects as soon as a config.json exists: activating before writing one is the normal order. */
function tick() {
  if (closed) return;
  let loaded;
  try {
    loaded = readConfig();
  } catch (error) {
    note(error);
    return;
  }
  if (!loaded) {
    status.lastError = status.lastError ?? "config.json is missing: add onebotUrl and accountId";
    return;
  }
  const changed = !config || config.onebotUrl !== loaded.onebotUrl || config.accountId !== loaded.accountId
    || config.serverUrl !== loaded.serverUrl || config.onebotToken !== loaded.onebotToken || config.serverToken !== loaded.serverToken;
  config = loaded;
  if (loaded.pollMs !== tickMs) {
    tickMs = loaded.pollMs;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(tick, tickMs);
    pollTimer.unref?.();
  }
  if (changed && socket) {
    // A new address: the open connection no longer points at the configured OneBot.
    try { socket.close(); } catch { /* already closed */ }
    socket = null;
    status.connected = false;
  }
  if (!socket && !connecting) {
    connecting = true;
    try { connect(); } finally { connecting = false; }
  }
  flushInbound().then(() => flushOutbox(), note).catch(note);
}

function sendAction(action, params) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new ToolError("disconnected", "the OneBot connection is not open", true);
  const echo = `eac-${actionSeq++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!callingActions.delete(echo)) return;
      // No answer is not a failure the bridge may paper over: the caller is told the result is unknown.
      reject(new ToolError("no-receipt", `${action} got no answer from OneBot in 30s; its result is unknown`, false));
    }, 30_000);
    timer.unref?.();
    callingActions.set(echo, { resolve, reject, timer });
    socket.send(JSON.stringify({ action, params, echo }));
  });
}

async function ack(ids) {
  const response = await fetch(`${config.serverUrl}/api/platforms/accounts/${config.accountId}/outbox/ack`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ids }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ToolError("ack-failed", `the host did not ack the replies (${response.status}): ${body?.error ?? "no detail"}`, true);
  }
}

async function flushOutbox() {
  if (!config || flushingOutbox) return;
  flushingOutbox = true;
  try {
    await flushOutboxOnce();
  } finally {
    flushingOutbox = false;
  }
}

async function flushOutboxOnce() {
  const query = state.lastAckedId ? `?since=${encodeURIComponent(state.lastAckedId)}` : "";
  const response = await fetch(`${config.serverUrl}/api/platforms/accounts/${config.accountId}/outbox${query}`, {
    headers: headers(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    note(`outbox read failed (${response.status}): ${body?.error ?? "no detail"}`);
    return;
  }
  const listed = await response.json().catch(() => null);
  const messages = Array.isArray(listed?.messages) ? listed.messages : [];
  status.outboundPending = messages.length;
  if (!messages.length) return;

  const sent = [];
  for (const message of messages) {
    const plan = toAction(message);
    if (plan.unsupported) {
      // No OneBot verb can reach this conversation. Leaving it unacked keeps it visible instead of silently dropping it.
      note(`reply ${message.id} cannot be sent: ${plan.unsupported}`);
      continue;
    }
    try {
      const answer = await sendAction(plan.action, plan.params);
      const refusal = refusedByOneBot(answer);
      if (refusal) {
        note(`reply ${message.id} was refused by OneBot: ${refusal}`);
        continue;
      }
      sent.push(message.id);
      status.outboundSent += 1;
      status.lastOutboundAt = new Date().toISOString();
    } catch (error) {
      // Unknown outcome: not acked, so the reply is still in the outbox for a person or a later attempt.
      note(`reply ${message.id} is unresolved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!sent.length) return;
  await ack(sent);
  state.lastAckedId = sent[sent.length - 1];
  saveState(state);
  status.outboundPending = Math.max(0, messages.length - sent.length);
}

function scheduleReconnect() {
  if (closed) return;
  const wait = BACKOFF_MS[Math.min(backoff, BACKOFF_MS.length - 1)];
  backoff += 1;
  reconnectTimer = setTimeout(connect, wait);
  reconnectTimer.unref?.();
}

function connect() {
  if (closed || !config) return;
  const url = config.onebotToken
    ? `${config.onebotUrl}${config.onebotUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(config.onebotToken)}`
    : config.onebotUrl;
  let opened;
  try {
    opened = new WebSocket(url, config.onebotToken ? { headers: { authorization: `Bearer ${config.onebotToken}` } } : undefined);
  } catch (error) {
    note(error);
    scheduleReconnect();
    return;
  }
  socket = opened;

  opened.on("open", () => {
    status.connected = true;
    status.lastConnectAt = new Date().toISOString();
    backoff = 0;
    flushInbound().catch(note);
    flushOutbox().catch(note);
  });

  opened.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (frame && typeof frame.echo === "string" && callingActions.has(frame.echo)) {
      const waiting = callingActions.get(frame.echo);
      callingActions.delete(frame.echo);
      clearTimeout(waiting.timer);
      waiting.resolve(frame);
      return;
    }
    if (!frame || frame.post_type !== "message" && frame.post_type !== "message_sent") return;
    let inbound;
    try {
      inbound = toInbound(frame, { accountId: config.accountId });
    } catch (error) {
      note(error);
      return;
    }
    if (!inbound) return;
    if (!allowedConversation(config.allow, inbound.conversation)) {
      // Not copied, not queued, not written to disk: someone else's group stayed where it was.
      status.inboundSkipped += 1;
      return;
    }
    if (state.inbound.length >= MAX_QUEUE) {
      note("the inbound queue is full; the oldest undelivered event was dropped");
      state.inbound.shift();
    }
    state.inbound.push({ event: inbound });
    status.inboundQueued = state.inbound.length;
    saveState(state);
    flushInbound().catch(note);
  });

  opened.on("close", () => {
    status.connected = false;
    status.lastDisconnectAt = new Date().toISOString();
    socket = null;
    for (const [echo, waiting] of callingActions) {
      clearTimeout(waiting.timer);
      waiting.reject(new ToolError("disconnected", "the OneBot connection closed before the action was answered", true));
      callingActions.delete(echo);
    }
    scheduleReconnect();
  });

  opened.on("error", (error) => {
    note(error);
    try {
      opened.close();
    } catch {
      // Already closed; the close handler schedules the retry.
    }
  });
}

async function startBridge() {
  status.startedAt = new Date().toISOString();
  status.inboundQueued = state.inbound.length;
  tick();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(tick, tickMs);
  pollTimer.unref?.();
}

function stopBridge() {
  closed = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pollTimer) clearInterval(pollTimer);
  reconnectTimer = null;
  pollTimer = null;
  try {
    socket?.close();
  } catch {
    // Closing an already-closed socket is not an error worth reporting.
  }
  socket = null;
  status.connected = false;
}

const TOOLS = {
  "qq-bridge-status": async () => {
    const configured = existsSync(CONFIG);
    return {
      configured,
      running: status.startedAt !== null,
      connected: status.connected,
      accountId: config?.accountId ?? null,
      onebotUrl: config?.onebotUrl ?? null,
      serverUrl: config?.serverUrl ?? null,
      inbound: {
        queued: status.inboundQueued, delivered: status.inboundDelivered,
        refused: status.inboundRefused, skipped: status.inboundSkipped,
      },
      // What this bridge may carry: an empty list carries nothing, which is the safe state for a real account.
      allow: config?.allow ?? [],
      outbound: { sent: status.outboundSent, pending: status.outboundPending },
      lastConnectAt: status.lastConnectAt,
      lastDisconnectAt: status.lastDisconnectAt,
      lastInboundAt: status.lastInboundAt,
      lastOutboundAt: status.lastOutboundAt,
      lastError: status.lastError,
      note: configured
        ? "replies OneBot refused or cannot address stay unacked in the host outbox on purpose"
        : "install and activate this plugin, then write config.json with onebotUrl and accountId",
    };
  },

  "qq-send-message": async (args) => {
    const conversationKind = args.conversationKind === "group" ? "group" : "direct";
    const conversationId = String(args.conversationId ?? "").trim();
    if (!/^[0-9]{1,20}$/.test(conversationId)) throw new ToolError("invalid-conversation", "conversationId must be a QQ number", false);
    const text = String(args.text ?? "").trim();
    if (!text) throw new ToolError("invalid-text", "text is required", false);
    if (text.length > 20_000) throw new ToolError("invalid-text", "text is limited to 20000 characters", false);
    if (!status.connected) throw new ToolError("disconnected", "the OneBot connection is not open; nothing was sent", true);
    const plan = toAction({ conversationId, conversationKind, text });
    if (plan.unsupported) throw new ToolError("unsupported", plan.unsupported, false);
    const answer = await sendAction(plan.action, plan.params);
    const refusal = refusedByOneBot(answer);
    if (refusal) throw new ToolError("not-sent", refusal, false);
    const messageId = answer?.data?.message_id ?? null;
    return { sent: true, conversationKind, conversationId, messageId, note: "OneBot reported success; delivery to QQ itself was not verified" };
  },

  "qq-bridge-configure": async (args) => {
    const onebotUrl = String(args.onebotUrl ?? "").trim();
    const accountId = String(args.accountId ?? "").trim();
    if (!/^wss?:\/\//.test(onebotUrl)) throw new ToolError("invalid-url", "onebotUrl must start with ws:// or wss://", false);
    if (!/^[0-9a-f-]{36}$/.test(accountId)) throw new ToolError("invalid-account", "accountId must be the id of this QQ platform account in EACbot", false);
    // What this bridge may carry. Only the named conversations are copied; the rest never reaches the host.
    const allow = Array.isArray(args.allow) ? args.allow.map((entry) => {
      if (!entry || typeof entry !== "object") throw new ToolError("invalid-allow", "each allow entry needs { kind, id }", false);
      if (entry.kind !== "group" && entry.kind !== "direct") throw new ToolError("invalid-allow", "allow.kind must be group or direct", false);
      const id = String(entry.id ?? "").trim();
      if (!/^[0-9]{1,20}$/.test(id)) throw new ToolError("invalid-allow", `allow.id ${id.slice(0, 20)} is not a QQ number`, false);
      return { kind: entry.kind, id };
    }) : undefined;
    const previous = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
    const next = {
      ...previous,
      onebotUrl,
      accountId,
      ...(allow ? { allow } : {}),
      ...(typeof args.onebotToken === "string" ? { onebotToken: args.onebotToken } : {}),
      ...(typeof args.serverUrl === "string" && args.serverUrl.trim() ? { serverUrl: args.serverUrl.trim().replace(/\/+$/, "") } : {}),
      ...(typeof args.serverToken === "string" ? { serverToken: args.serverToken } : {}),
    };
    mkdirSync(dirname(CONFIG), { recursive: true, mode: 0o700 });
    const temporary = `${CONFIG}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, CONFIG);
    // A running bridge keeps its old connection: the next activation reads the file again.
    return {
      saved: true, restartRequired: status.startedAt !== null, onebotUrl, accountId,
      allow: next.allow ?? [],
      note: "deactivate and activate this plugin to connect with the new settings",
    };
  },
};

function result(value) {
  return { status: "succeeded", value };
}

function failure(error) {
  if (error instanceof ToolError) return { status: "failed", code: error.code, message: error.message.slice(0, 2000), retryable: error.retryable };
  return { status: "failed", code: "internal", message: String(error instanceof Error ? error.message : error).slice(0, 2000), retryable: false };
}

function answer(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (text) => {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  if (!frame || typeof frame !== "object" || frame.id === undefined || frame.id === null) return;
  if (frame.method === "initialize") {
    answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.qq" });
    // The bridge runs for as long as the plugin is active; a host without config.json keeps the tools usable.
    startBridge().catch((error) => note(error));
    return;
  }
  if (frame.method === "shutdown") {
    stopBridge();
    answer(frame.id, { ok: true });
    process.exit(0);
  }
  if (frame.method === "status") {
    // A host method, not a tool: reading whether the bridge is connected needs no grant, so a broken bridge stays
    // diagnosable without authorising a bot to look at it. Secrets are never part of this answer.
    answer(frame.id, {
      configured: Boolean(config),
      accountId: config?.accountId ?? "",
      onebotUrl: config?.onebotUrl ?? "",
      connected: status.connected,
      running: status.startedAt !== null,
      inboundQueued: status.inboundQueued,
      inboundDelivered: status.inboundDelivered,
      inboundSkipped: status.inboundSkipped,
      inboundRefused: status.inboundRefused,
      outboundSent: status.outboundSent,
      outboundPending: status.outboundPending,
      lastInboundAt: status.lastInboundAt ?? "",
      lastOutboundAt: status.lastOutboundAt ?? "",
      lastError: status.lastError ?? "",
    });
    return;
  }
  if (frame.method !== "tools/call") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } })}\n`);
    return;
  }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) {
    answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false });
    return;
  }
  Promise.resolve(tool(params.arguments ?? {})).then(result, failure).then((value) => answer(frame.id, value));
});
