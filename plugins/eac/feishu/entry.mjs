// eac.feishu: a process bridge between a Feishu bot and one EAC platform account.
// It carries text events only; the EAC host owns identity, routing, turns and the outbox.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { checkStrictBot, consumeEvents, larkData, larkError, runLark } from "./cli.mjs";
import { filterInbound, toInbound, toReplyPlan } from "./map.mjs";
import { dueInbound, enqueue, loadState, removeInbound, saveState } from "./state.mjs";

const CONFIG = join(process.cwd(), "config.json");
const STATE_FILE = join(process.cwd(), "feishu-bridge-state.json");
const DEFAULT_POLL_MS = 1_000;
const MAX_QUEUE = 500;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000];

function textOf(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 2_000);
}

function readConfig() {
  if (!existsSync(CONFIG)) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(CONFIG, "utf8")); }
  catch { throw new Error("config.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json must be an object");
  const cli = String(raw.cli ?? "").trim();
  const larkConfigDir = String(raw.larkConfigDir ?? "").trim();
  const accountId = String(raw.accountId ?? "").trim();
  const botOpenId = String(raw.botOpenId ?? "").trim();
  if (!cli) throw new Error("config.json needs cli (lark-cli.exe or a .cmd wrapper)");
  if (!larkConfigDir) throw new Error("config.json needs larkConfigDir");
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new Error("config.json needs the EAC platform account UUID in accountId");
  if (!/^ou_[A-Za-z0-9_-]+$/.test(botOpenId)) throw new Error("config.json needs botOpenId (the Feishu bot open_id)");
  const pollMs = Math.min(Math.max(Number(raw.pollMs) || DEFAULT_POLL_MS, 250), 30_000);
  return {
    cli, larkConfigDir, accountId, botOpenId,
    botAppId: String(raw.botAppId ?? "").trim(),
    serverUrl: String(raw.serverUrl ?? "http://127.0.0.1:8799").trim().replace(/\/+$/, ""),
    serverToken: String(raw.serverToken ?? "").trim(),
    chats: String(raw.chats ?? "").trim(),
    allowedSenders: String(raw.allowedSenders ?? "").trim(),
    directMessages: raw.directMessages !== false,
    otherChats: raw.otherChats === "mentions" ? "mentions" : "none",
    pollMs,
  };
}

const status = {
  startedAt: null,
  consumerState: "stopped",
  ready: false,
  lastError: "",
  inboundQueued: 0,
  inboundDelivered: 0,
  inboundRefused: 0,
  inboundSkipped: 0,
  outboundSent: 0,
  outboundPending: 0,
  lastInboundAt: "",
  lastOutboundAt: "",
};

let config = null;
let state = null;
let closed = false;
let consumer = null;
let consumerRetry = 0;
let restartTimer = null;
let tickTimer = null;
let flushingInbound = false;
let flushingOutbox = false;

function note(error) {
  status.lastError = textOf(error);
}

function persist() {
  if (!state) return;
  status.inboundQueued = state.inbound.length;
  try { saveState(STATE_FILE, state); } catch (error) { note(error); }
}

function headers() {
  const result = { "content-type": "application/json" };
  if (config?.serverToken) result.authorization = "Bearer " + config.serverToken;
  return result;
}

async function request(path, options = {}) {
  const response = await fetch(config.serverUrl + path, {
    ...options,
    headers: { ...headers(), ...options.headers },
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

function retryDelay(attempts) {
  return BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)];
}

async function flushInbound() {
  if (flushingInbound || !config || !state) return;
  flushingInbound = true;
  try {
    const due = dueInbound(state, Date.now()).slice(0, 20);
    for (const entry of due) {
      let answer;
      try {
        answer = await request("/api/platforms/inbound", { method: "POST", body: JSON.stringify(entry.event) });
      } catch (error) {
        entry.attempts = (entry.attempts ?? 0) + 1;
        entry.nextAt = new Date(Date.now() + retryDelay(entry.attempts)).toISOString();
        note(error);
        persist();
        break;
      }
      if (answer.status === 200 || answer.status === 202) {
        removeInbound(state, entry.eventId);
        status.inboundDelivered += 1;
        status.lastInboundAt = new Date().toISOString();
        persist();
        continue;
      }
      if (answer.status === 409 || answer.status >= 500) {
        entry.attempts = (entry.attempts ?? 0) + 1;
        entry.nextAt = new Date(Date.now() + retryDelay(entry.attempts)).toISOString();
        note(answer.body?.error ?? ("host returned " + answer.status));
        persist();
        break;
      }
      if (answer.status === 401 || answer.status === 403) {
        note(answer.body?.error ?? ("host refused the bridge token (" + answer.status + ")"));
        break;
      }
      if (answer.status >= 400 && answer.status < 500) {
        removeInbound(state, entry.eventId);
        status.inboundRefused += 1;
        note(answer.body?.error ?? ("host refused the event (" + answer.status + ")"));
        persist();
        continue;
      }
      entry.attempts = (entry.attempts ?? 0) + 1;
      entry.nextAt = new Date(Date.now() + retryDelay(entry.attempts)).toISOString();
      note("unexpected host response " + answer.status);
      persist();
      break;
    }
  } finally {
    flushingInbound = false;
  }
}

function errorCode(result) {
  const body = result?.json;
  const raw = body?.error?.code ?? body?.code;
  const number = Number(raw);
  if (Number.isFinite(number)) return number;
  const match = /^(\d+):/.exec(String(larkError(result) ?? ""));
  return match ? Number(match[1]) : null;
}

async function ack(ids) {
  if (!ids.length) return true;
  try {
    const answer = await request("/api/platforms/accounts/" + config.accountId + "/outbox/ack", {
      method: "POST", body: JSON.stringify({ ids }),
    });
    if (answer.ok) {
      for (const id of ids) delete state.outbound[id];
      persist();
      return true;
    }
    note(answer.body?.error ?? ("outbox ack failed (" + answer.status + ")"));
  } catch (error) {
    note(error);
  }
  return false;
}

function markUnknown(id, error) {
  state.outbound[id] = {
    state: "unknown",
    at: new Date().toISOString(),
    until: new Date(Date.now() + 60_000).toISOString(),
    error: textOf(error),
  };
  persist();
}

async function sendOutbox(message) {
  const plan = toReplyPlan(message);
  if (plan.unsupported) {
    note(plan.unsupported);
    return false;
  }
  let result = await runLark(config.cli, plan.args, {
    configDir: config.larkConfigDir, timeoutMs: 90_000, input: plan.text,
  });
  let error = larkError(result);
  let code = errorCode(result);
  if (error && plan.reply && (code === 230071 || code === 230072)) {
    const fallback = plan.args.filter((arg) => arg !== "--reply-in-thread");
    result = await runLark(config.cli, fallback, {
      configDir: config.larkConfigDir, timeoutMs: 90_000, input: plan.text,
    });
    error = larkError(result);
    code = errorCode(result);
  }
  if (!error) {
    status.outboundSent += 1;
    status.lastOutboundAt = new Date().toISOString();
    const data = larkData(result);
    state.outbound[message.id] = {
      state: "sent",
      at: new Date().toISOString(),
      messageId: String(data?.message_id ?? ""),
    };
    persist();
    return true;
  }
  note(error);
  if (code === 230011 || /withdrawn|not found/i.test(error)) {
    state.outbound[message.id] = { state: "gone", at: new Date().toISOString(), error };
    persist();
    return true;
  }
  if (code === 429 || code >= 500 || /timed out|timeout|no answer/i.test(error)) {
    markUnknown(message.id, error);
    return false;
  }
  state.outbound[message.id] = {
    state: "failed", at: new Date().toISOString(), error,
    until: new Date(Date.now() + 300_000).toISOString(),
  };
  persist();
  return false;
}

async function flushOutbox() {
  if (flushingOutbox || !config || !state) return;
  flushingOutbox = true;
  try {
    let answer;
    try {
      answer = await request("/api/platforms/accounts/" + config.accountId + "/outbox");
    } catch (error) {
      note(error);
      return;
    }
    if (!answer.ok) {
      note(answer.body?.error ?? ("outbox read failed (" + answer.status + ")"));
      return;
    }
    const messages = Array.isArray(answer.body?.messages) ? answer.body.messages : [];
    status.outboundPending = messages.length;
    for (const message of messages) {
      if (closed) return;
      const local = state.outbound?.[message.id];
      if (local?.state === "sent" || local?.state === "gone") {
        await ack([message.id]);
        continue;
      }
      if (local?.state === "unknown" || local?.state === "failed") {
        if (local.until && Date.parse(local.until) > Date.now()) continue;
      }
      const sent = await sendOutbox(message);
      if (sent) {
        await ack([message.id]);
        status.outboundPending = Math.max(0, status.outboundPending - 1);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    flushingOutbox = false;
  }
}

function eventReceived(event) {
  if (!config || !state || closed) return;
  let inbound;
  try {
    const decision = filterInbound(event, config);
    if (!decision.ok) {
      status.inboundSkipped += 1;
      return;
    }
    inbound = toInbound(event, { accountId: config.accountId, botOpenId: config.botOpenId });
  } catch (error) {
    note(error);
    return;
  }
  if (!inbound) {
    status.inboundSkipped += 1;
    return;
  }
  const item = {
    eventId: inbound.eventId,
    messageId: String(event?.message_id ?? event?.id ?? ""),
    chatId: inbound.conversation.id,
    receivedAt: inbound.receivedAt,
    event: inbound,
    attempts: 0,
    nextAt: null,
  };
  if (!enqueue(state, item, MAX_QUEUE)) return;
  persist();
  void flushInbound();
}

function scheduleConsumer(delay) {
  if (closed) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(startConsumer, delay);
  restartTimer.unref?.();
}

function startConsumer() {
  if (closed || !config) return;
  status.consumerState = "starting";
  let readyThisRun = false;
  try {
    consumer = consumeEvents(config.cli, config.larkConfigDir, {
      onReady: () => {
        readyThisRun = true;
        status.ready = true;
        status.consumerState = "ready";
        status.lastError = "";
        consumerRetry = 0;
        state.consumer = { state: "ready", lastError: "", readyAt: new Date().toISOString() };
        persist();
      },
      onEvent: eventReceived,
      onStderr: (line) => {
        status.lastError = line;
        if (!readyThisRun) status.consumerState = "error";
      },
      onError: (error) => {
        note(error);
        status.consumerState = "error";
      },
      onClose: ({ code, signal }) => {
        consumer = null;
        status.ready = false;
        status.consumerState = "stopped";
        if (closed) return;
        status.lastError = "Feishu event consumer exited (" + String(code ?? signal ?? "unknown") + ")";
        scheduleConsumer(retryDelay(++consumerRetry));
      },
    });
  } catch (error) {
    note(error);
    status.consumerState = "error";
    scheduleConsumer(retryDelay(++consumerRetry));
  }
}

async function startBridge() {
  if (status.startedAt) return;
  status.startedAt = new Date().toISOString();
  try {
    config = readConfig();
    if (!config) {
      status.consumerState = "paused";
      status.lastError = "config.json is missing; add the Feishu account and lark-cli settings";
      return;
    }
    state = loadState(STATE_FILE);
    status.inboundQueued = state.inbound.length;
    const strict = await checkStrictBot(config.cli, config.larkConfigDir);
    if (!strict.ok) {
      status.consumerState = "error";
      status.lastError = strict.error;
      return;
    }
    startConsumer();
    tickTimer = setInterval(() => {
      void flushInbound();
      void flushOutbox();
    }, config.pollMs);
    tickTimer.unref?.();
    void flushInbound();
    void flushOutbox();
  } catch (error) {
    status.consumerState = "error";
    note(error);
  }
}

function stopBridge() {
  closed = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (tickTimer) clearInterval(tickTimer);
  restartTimer = null;
  tickTimer = null;
  try { consumer?.stop(); } catch {}
  consumer = null;
  status.ready = false;
  status.consumerState = "stopped";
}

function bridgeStatus() {
  return {
    configured: Boolean(config),
    running: Boolean(status.startedAt) && !closed,
    consumerState: status.consumerState,
    ready: status.ready,
    accountId: config?.accountId ?? "",
    cli: config?.cli ?? "",
    larkConfigDir: config?.larkConfigDir ?? "",
    inboundQueued: status.inboundQueued,
    inboundDelivered: status.inboundDelivered,
    inboundRefused: status.inboundRefused,
    inboundSkipped: status.inboundSkipped,
    outboundSent: status.outboundSent,
    outboundPending: status.outboundPending,
    lastInboundAt: status.lastInboundAt,
    lastOutboundAt: status.lastOutboundAt,
    lastError: status.lastError,
  };
}

async function chatList() {
  if (!config) throw new Error("the bridge is not configured");
  const result = await runLark(config.cli, ["im", "+chat-list", "--page-all", "--page-size", "100", "--as", "bot", "--format", "json"], {
    configDir: config.larkConfigDir, timeoutMs: 30_000,
  });
  const error = larkError(result);
  if (error) throw new Error(error);
  const data = larkData(result) ?? {};
  const chats = Array.isArray(data.chats) ? data.chats : [];
  return { chats: chats.map((chat) => ({ chatId: String(chat.chat_id ?? ""), name: String(chat.name ?? "") })).filter((chat) => chat.chatId) };
}

async function manualSend(args) {
  if (!config) throw new Error("the bridge is not configured");
  const plan = toReplyPlan({ id: "manual-" + Date.now(), conversationId: args.chatId, conversationKind: args.conversationKind === "direct" ? "direct" : "group", text: args.text, replyToEventId: null });
  if (plan.unsupported) throw new Error(plan.unsupported);
  const result = await runLark(config.cli, plan.args, { configDir: config.larkConfigDir, timeoutMs: 90_000, input: plan.text });
  const error = larkError(result);
  if (error) throw new Error(error);
  return { sent: true, data: larkData(result) };
}

const tools = {
  "feishu-bridge-status": async () => bridgeStatus(),
  "feishu-chat-list": chatList,
  "feishu-send-message": manualSend,
};

function answer(id, value) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: value }) + "\n");
}

function failure(error) {
  return { status: "failed", code: error?.code ?? "internal", message: textOf(error), retryable: Boolean(error?.retryable) };
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (text) => {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  if (!frame || typeof frame !== "object" || frame.id === undefined || frame.id === null) return;
  if (frame.method === "initialize") {
    answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.feishu" });
    void startBridge();
    return;
  }
  if (frame.method === "shutdown") {
    stopBridge();
    answer(frame.id, { ok: true });
    process.exit(0);
  }
  if (frame.method === "status") {
    answer(frame.id, bridgeStatus());
    return;
  }
  if (frame.method !== "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } }) + "\n");
    return;
  }
  const params = frame.params ?? {};
  const tool = tools[params.toolId];
  if (!tool) {
    answer(frame.id, { status: "failed", code: "unknown-tool", message: "no tool " + String(params.toolId).slice(0, 60), retryable: false });
    return;
  }
  Promise.resolve(tool(params.arguments ?? {})).then(
    (value) => answer(frame.id, { status: "succeeded", value }),
    (error) => answer(frame.id, failure(error)),
  );
});
