// eac.xianyu — the Xianyu account bridge and desk for EACbot.
//
// Two transport lines reach the platform, and everything above them is written once:
//   protocol  the message gateway's socket, minted from the account cookie (fast, no browser)
//   web       the signed-in pages in a Chrome the person already signed in (no cookie stored here)
// `transport: "auto"` runs the protocol line and falls back to the web line while it is down.
//
// Inbound messages go to the host's `/api/platforms/inbound` and replies come back from the account's outbox,
// so a Bot's turn, its approvals and its memory work exactly as they do for QQ. The knowledge base and the
// reply rules live here. High-impact actions (publish, price, ship, refund) queue for a person unless that
// action's rule says otherwise, and every run lands in an audit trail either way.
//
// Protocol note: endpoint shapes, the signing rule and the push packing were read from public traffic and from
// the reference projects this feature was requested from. Those are AGPL-3.0 with a non-commercial clause
// (xianyu-auto-reply) or carry no licence (xyxyxy), so no code is copied from them. No captcha is solved, no
// fingerprint is changed and no rate limit is worked around: a security check stops the line and says so.
//
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult,
// board/operate/audit/status -> data, shutdown -> exit.
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { TransportError, createFailoverTransport, inboundEvent } from "./transport.mjs";
import { createProtocolTransport } from "./protocol/socket.mjs";
import { createPageTransport } from "../shared/web/line.mjs";
import { createCdpBrowser } from "../shared/web/cdp.mjs";
import { XIANYU_WEB_PROFILE } from "./web/parse.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const APP_KEY = "12574478";

const KB = join(process.cwd(), "xianyu-kb.json");
const AUDIT = join(process.cwd(), "xianyu-audit.json");
const QUEUE = join(process.cwd(), "xianyu-actions.json");
const BRIDGE_STATE = join(process.cwd(), "xianyu-bridge-state.json");

const HIGH_IMPACT = { publish: "发布商品", "set-price": "修改价格", ship: "发货", refund: "同意退款" };

const DEFAULT_RULES = {
  enabled: false,
  onlyTrusted: true,
  maxRepliesPerDay: 20,
  /** Every high-impact action starts as a person's decision; `auto` is a deliberate change made in the board. */
  actions: { publish: "manual", "set-price": "manual", ship: "manual", refund: "manual" },
};

class ToolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function readJsonFile(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ToolError("store-corrupt", `${file.split(/[\\/]/).pop()} is not valid JSON; move it aside to start clean`, false);
  }
}

function writeJsonFile(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function loadKb() {
  const state = readJsonFile(KB, null);
  if (!state || !Array.isArray(state.items)) return { schemaVersion: 1, items: [], rules: structuredClone(DEFAULT_RULES) };
  const rules = state.rules && typeof state.rules === "object" ? state.rules : {};
  return {
    schemaVersion: 1,
    items: state.items,
    rules: {
      ...structuredClone(DEFAULT_RULES),
      ...rules,
      actions: { ...DEFAULT_RULES.actions, ...(rules.actions && typeof rules.actions === "object" ? rules.actions : {}) },
    },
  };
}

function readConfig() {
  const file = join(process.cwd(), "config.json");
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ToolError("config-invalid", "config.json is not valid JSON", false);
  }
  if (!parsed || typeof parsed !== "object") throw new ToolError("config-invalid", "config.json must be an object", false);
  return {
    transport: ["protocol", "web", "auto"].includes(parsed.transport) ? parsed.transport : "auto",
    cookie: typeof parsed.cookie === "string" ? parsed.cookie.trim() : "",
    accountId: typeof parsed.accountId === "string" ? parsed.accountId.trim() : "",
    cdpUrl: typeof parsed.cdpUrl === "string" ? parsed.cdpUrl.trim() : "",
    serverUrl: (typeof parsed.serverUrl === "string" && parsed.serverUrl.trim() ? parsed.serverUrl : "http://127.0.0.1:8799").replace(/\/+$/, ""),
    serverToken: typeof parsed.serverToken === "string" ? parsed.serverToken : "",
    pollMs: Math.min(Math.max(Number(parsed.pollMs) || 20_000, 5_000), 300_000),
    selfName: typeof parsed.selfName === "string" ? parsed.selfName.trim() : "",
  };
}

/** The cookie lives in memory for this run; a fresh `_m_h5_tk` from any answer replaces it. */
let liveCookie = null;

function currentCookie() {
  if (liveCookie) return liveCookie;
  try {
    liveCookie = readConfig()?.cookie ?? "";
  } catch {
    liveCookie = "";
  }
  return liveCookie;
}

function setCookieFromAnswer(lines) {
  if (!lines?.length) return;
  const jar = new Map();
  for (const part of String(liveCookie ?? "").split(";")) {
    const trimmed = part.trim();
    const at = trimmed.indexOf("=");
    if (at > 0) jar.set(trimmed.slice(0, at), trimmed.slice(at + 1));
  }
  for (const line of lines) {
    const [pair] = String(line).split(";");
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  liveCookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

// ---------------------------------------------------------------- item search over the h5 gateway

function mtopSign(token, ts, data) {
  return createHash("md5").update(`${token}&${ts}&${APP_KEY}&${data}`).digest("hex");
}

function cookieValue(cookie, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie ?? "");
  return match ? match[1] : null;
}

async function itemSearch(cookie, keyword, page) {
  const tokenPart = cookieValue(cookie, "_m_h5_tk")?.split("_")[0] ?? "";
  if (!tokenPart) throw new ToolError("no-login", "the cookie is missing _m_h5_tk, so the search cannot be signed", false);
  const ts = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({ keyword, fromFilter: "", sortType: "", pageNumber: page, itemId: "", customTag: "" });
  const signature = mtopSign(tokenPart, ts, payload);
  const url = `https://h5api.m.goofish.com/h5/mtop.taobao.idle.pc.search.item/1.0/${ts}/${APP_KEY}/${signature}/`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, origin: "https://www.goofish.com", referer: "https://www.goofish.com/", cookie },
      body: new URLSearchParams({ data: payload }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.name;
    throw new ToolError("unreachable", `Goofish is unreachable (${String(cause).slice(0, 60)})`, true);
  }
  let parsed;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    throw new ToolError("bad-response", "Goofish returned a non-JSON answer", true);
  }
  const code = String(parsed?.ret?.[0] ?? "");
  if (code.includes("TOKEN")) throw new ToolError("session-expired", "the cookie's token lapsed; copy a fresh cookie from a signed-in browser", false);
  if (code.includes("RGV587") || code.includes("USER_VALIDATE")) throw new ToolError("risk-control", "Goofish asked for a security check; open the site yourself, then try again", false);
  if (code && !code.startsWith("SUCCESS")) throw new ToolError("api-error", `Goofish answered ${code}: ${String(parsed?.ret?.[1] ?? "").slice(0, 200)}`, true);
  const rows = parsed?.data?.resultList ?? parsed?.data?.items ?? [];
  return rows.map((row) => ({
    itemId: row?.data?.itemId ?? row?.itemId ?? null,
    title: row?.data?.title ?? row?.title ?? null,
    price: row?.data?.price ?? row?.price ?? null,
    area: row?.data?.area ?? null,
    wantCount: row?.data?.wantCnt ?? null,
    sellerNick: row?.data?.userNick ?? null,
  })).filter((row) => row.itemId);
}

// ---------------------------------------------------------------- bridge

const status = {
  startedAt: null,
  mode: null,
  live: null,
  connected: false,
  lastConnectAt: null,
  lastError: null,
  inboundDelivered: 0,
  inboundRefused: 0,
  outboundSent: 0,
  outboundPending: 0,
  repliesToday: 0,
  lastInboundAt: null,
  lastOutboundAt: null,
  lastSwitch: null,
  selfCheck: null,
  items: null,
  orders: null,
};

let transport = null;
let config = null;
let closed = false;
let pollTimer = null;
let flushingInbound = false;
let flushingOutbox = false;
let tickMs = 20_000;
let dayKey = new Date().toISOString().slice(0, 10);

function loadBridgeState() {
  const state = readJsonFile(BRIDGE_STATE, null);
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.inbound)) {
    return { schemaVersion: 1, inbound: [], lastAckedId: null, replies: { day: dayKey, count: 0 } };
  }
  return state;
}

const bridgeState = loadBridgeState();
if (bridgeState.replies?.day !== dayKey) bridgeState.replies = { day: dayKey, count: 0 };
status.repliesToday = bridgeState.replies?.count ?? 0;

function saveBridgeState() {
  writeJsonFile(BRIDGE_STATE, bridgeState);
}

function note(error) {
  status.lastError = String(error instanceof Error ? error.message : error).slice(0, 400);
}

function hostHeaders() {
  const sent = { "content-type": "application/json" };
  if (config?.serverToken) sent.authorization = `Bearer ${config.serverToken}`;
  return sent;
}

async function deliverInbound(entry) {
  let response;
  try {
    response = await fetch(`${config.serverUrl}/api/platforms/inbound`, {
      method: "POST",
      headers: hostHeaders(),
      body: JSON.stringify(entry.event),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
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
    // The host did not consume the event, so it stays queued for a later attempt with the same id.
    note(`inbound refused: ${body?.error ?? response.status}`);
    return false;
  }
  status.inboundRefused += 1;
  note(`inbound rejected (${response.status}): ${body?.error ?? "no detail"}`);
  bridgeState.inbound = bridgeState.inbound.filter((row) => row.event.eventId !== entry.event.eventId);
  saveBridgeState();
  return true;
}

async function flushInbound() {
  if (!config || flushingInbound) return;
  flushingInbound = true;
  try {
    // A snapshot, because delivering one removes it from the queue the loop is walking.
    const queued = bridgeState.inbound.slice();
    for (const entry of queued) {
      if (!await deliverInbound(entry)) break;
      bridgeState.inbound = bridgeState.inbound.filter((row) => row !== entry);
      saveBridgeState();
    }
  } finally {
    flushingInbound = false;
  }
}

async function acceptMessage(message) {
  if (!config || !message.text?.trim()) return;
  bridgeState.inbound.push({
    at: new Date().toISOString(),
    event: inboundEvent({
      platform: "xianyu",
      accountId: config.accountId,
      conversationId: message.conversationId,
      conversationKind: "direct",
      senderId: message.senderId,
      senderName: message.senderName,
      text: message.text,
      messageId: message.messageId,
      receivedAt: message.receivedAt,
    }),
  });
  if (bridgeState.inbound.length > 200) bridgeState.inbound = bridgeState.inbound.slice(-200);
  saveBridgeState();
  await flushInbound();
}

async function ackOutbox(ids) {
  const response = await fetch(`${config.serverUrl}/api/platforms/accounts/${config.accountId}/outbox/ack`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({ ids }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ToolError("ack-failed", `the host did not ack the replies (${response.status}): ${body?.error ?? "no detail"}`, true);
  }
}

async function flushOutbox() {
  if (!config || flushingOutbox || !transport) return;
  flushingOutbox = true;
  try {
    const query = bridgeState.lastAckedId ? `?since=${encodeURIComponent(bridgeState.lastAckedId)}` : "";
    const response = await fetch(`${config.serverUrl}/api/platforms/accounts/${config.accountId}/outbox${query}`, {
      headers: hostHeaders(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      note(`outbox read failed (${response.status})`);
      return;
    }
    const listed = await response.json().catch(() => null);
    const messages = Array.isArray(listed?.messages) ? listed.messages : [];
    status.outboundPending = messages.length;
    if (!messages.length) return;
    const sent = [];
    for (const message of messages) {
      try {
        await transport.send({ conversationId: message.conversationId, conversationKind: message.conversationKind, text: message.text });
        sent.push(message.id);
        status.outboundSent += 1;
        status.lastOutboundAt = new Date().toISOString();
      } catch (error) {
        // Unknown or refused: not acked, so the reply stays in the outbox for a person or a later attempt.
        note(`reply ${message.id} is unresolved: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!sent.length) return;
    await ackOutbox(sent);
    bridgeState.lastAckedId = sent[sent.length - 1];
    saveBridgeState();
    status.outboundPending = Math.max(0, messages.length - sent.length);
  } finally {
    flushingOutbox = false;
  }
}

function buildTransport(loaded) {
  const protocol = loaded.transport === "web" ? null : createProtocolTransport({
    getCookie: async () => currentCookie(),
    setCookie: async (lines) => setCookieFromAnswer(lines),
    accountId: loaded.accountId,
  });
  const web = loaded.transport === "protocol" ? null : createPageTransport({
    profile: XIANYU_WEB_PROFILE,
    browser: createCdpBrowser({ cdpUrl: loaded.cdpUrl }),
    accountId: loaded.accountId,
    pollMs: loaded.pollMs,
  });
  if (loaded.transport === "protocol") return protocol;
  if (loaded.transport === "web") return web;
  return createFailoverTransport({
    primary: protocol,
    fallback: web,
    onSwitch: (info) => {
      status.lastSwitch = info;
      note(`switched to the ${info.to} line`);
    },
  });
}

function refreshStatus() {
  const line = transport?.state?.() ?? {};
  status.connected = Boolean(line.connected);
  status.live = line.live ?? line.mode ?? config?.transport ?? null;
  if (line.selfCheck) status.selfCheck = line.selfCheck;
  if (line.lastError) status.lastError = line.lastError;
  if (status.connected && !status.lastConnectAt) status.lastConnectAt = new Date().toISOString();
}

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
    status.lastError = status.lastError ?? "config.json is missing: add transport, accountId and either a cookie or a cdpUrl";
    return;
  }
  const changed = !config || config.transport !== loaded.transport || config.accountId !== loaded.accountId
    || config.serverUrl !== loaded.serverUrl || config.serverToken !== loaded.serverToken
    || config.cdpUrl !== loaded.cdpUrl || (loaded.transport !== "web" && config.cookie !== loaded.cookie);
  if (loaded.cookie && !liveCookie) liveCookie = loaded.cookie;
  config = loaded;
  status.mode = loaded.transport;
  if (loaded.pollMs !== tickMs) {
    tickMs = loaded.pollMs;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(tick, tickMs);
    pollTimer.unref?.();
  }
  if (changed && transport) {
    const previous = transport;
    transport = null;
    void previous.stop().catch(note);
  }
  if (!transport) {
    const started = buildTransport(loaded);
    transport = started;
    void started.start(acceptMessage).then(() => {
      if (transport !== started) return;
      refreshStatus();
    }).catch(note);
  } else {
    refreshStatus();
  }
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    bridgeState.replies = { day: today, count: 0 };
    status.repliesToday = 0;
    saveBridgeState();
  }
  void flushInbound().then(() => flushOutbox()).catch(note);
}

function startBridge() {
  if (closed) return;
  status.startedAt = new Date().toISOString();
  tick();
  if (!pollTimer) {
    pollTimer = setInterval(tick, tickMs);
    pollTimer.unref?.();
  }
}

async function stopBridge() {
  closed = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  const running = transport;
  transport = null;
  if (running) await running.stop().catch(note);
}

// ---------------------------------------------------------------- high-impact actions

function loadQueue() {
  const state = readJsonFile(QUEUE, null);
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.items)) return { schemaVersion: 1, items: [] };
  return state;
}

function loadAudit() {
  const state = readJsonFile(AUDIT, null);
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.entries)) return { schemaVersion: 1, entries: [] };
  return state;
}

function audit(action, outcome, detail) {
  const state = loadAudit();
  state.entries.push({ id: randomUUID(), at: new Date().toISOString(), action, outcome, detail: String(detail ?? "").slice(0, 1_000) });
  if (state.entries.length > 1_000) state.entries = state.entries.slice(-1_000);
  writeJsonFile(AUDIT, state);
}

async function performAction(action, params) {
  if (!HIGH_IMPACT[action]) throw new ToolError("invalid-action", `unknown action ${String(action).slice(0, 60)}`, false);
  const rules = loadKb().rules;
  if ((rules.actions?.[action] ?? "manual") === "manual") {
    const queue = loadQueue();
    const entry = { id: randomUUID(), action, params, at: new Date().toISOString(), state: "waiting" };
    queue.items.push(entry);
    writeJsonFile(QUEUE, queue);
    audit(action, "queued", "the rule for this action is a person's decision");
    return { ok: true, queued: entry, message: `${HIGH_IMPACT[action]} 已进入待审批队列。` };
  }
  // Every outcome is audited, including the ones where nothing was attempted: the trail must show the gap.
  try {
    if (!transport) throw new ToolError("no-transport", "no transport line is running, so nothing can be sent", true);
    const result = await transport.send({
      conversationId: String(params?.conversationId ?? ""),
      conversationKind: "direct",
      text: String(params?.text ?? params?.note ?? ""),
    });
    audit(action, "done", JSON.stringify(result).slice(0, 500));
    return { ok: true, result, message: `${HIGH_IMPACT[action]} 已执行。` };
  } catch (error) {
    audit(action, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function decideQueued(id, decision) {
  const queue = loadQueue();
  const entry = queue.items.find((item) => item.id === id);
  if (!entry) throw new ToolError("not-found", `no queued action ${String(id).slice(0, 60)}`, false);
  if (decision === "dismiss") {
    queue.items = queue.items.filter((item) => item.id !== id);
    writeJsonFile(QUEUE, queue);
    audit(entry.action, "dismissed", "a person dismissed it");
    return { ok: true, dismissed: id };
  }
  // An approval that could not run leaves the item queued and says why: dropping it would lose the request.
  try {
    if (!transport) throw new ToolError("no-transport", "no transport line is running, so nothing can be sent", true);
    const result = await transport.send({
      conversationId: String(entry.params?.conversationId ?? ""),
      conversationKind: "direct",
      text: String(entry.params?.text ?? entry.params?.note ?? ""),
    });
    queue.items = queue.items.filter((item) => item.id !== id);
    writeJsonFile(QUEUE, queue);
    audit(entry.action, "done", JSON.stringify(result).slice(0, 500));
    return { ok: true, result };
  } catch (error) {
    audit(entry.action, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

// ---------------------------------------------------------------- the board

function boardSections(rules) {
  const queue = loadQueue();
  const auditLog = loadAudit();
  const sections = [];

  sections.push({
    id: "transport",
    kind: "notice",
    title: "传输线路",
    notices: [{
      tone: status.connected ? "info" : "warning",
      text: status.connected
        ? `当前走 ${status.live ?? status.mode} 线路。`
        : `${status.mode ?? "auto"} 线路未连接：${status.lastError ?? "尚无连接记录"}。`,
    }],
  });

  if (status.selfCheck?.length) {
    sections.push({
      id: "self-check",
      kind: "table",
      title: "网页自检",
      columns: [{ key: "probe", label: "检查项" }, { key: "state", label: "结果" }, { key: "reason", label: "说明" }],
      rows: status.selfCheck.map((probe, index) => ({
        id: `probe-${index}`,
        cells: {
          probe: { kind: "text", value: probe.probe },
          state: { kind: "status", value: probe.ok ? "通过" : "未通过", tone: probe.ok ? "accent" : "danger" },
          reason: { kind: "text", value: probe.reason, tone: probe.ok ? "muted" : "danger" },
        },
      })),
      empty: "尚未运行自检。",
    });
  }

  if (queue.items.length) {
    sections.push({
      id: "pending-actions",
      kind: "queue",
      title: "待审批动作",
      items: queue.items.slice(-50).map((item) => ({
        id: item.id,
        title: `${HIGH_IMPACT[item.action] ?? item.action} · ${JSON.stringify(item.params ?? {}).slice(0, 120)}`,
        reason: "该动作的规则是「由你决定」，需要你确认后才会执行。",
        since: item.at,
        tone: "warning",
        actions: [{ id: "approve", label: "确认执行" }, { id: "dismiss", label: "忽略" }],
      })),
      empty: "没有待审批的动作。",
    });
  }

  if (auditLog.entries.length) {
    sections.push({
      id: "audit",
      kind: "timeline",
      title: "动作审计",
      entries: auditLog.entries.slice(-40).reverse().map((entry) => ({
        id: entry.id,
        at: entry.at,
        title: `${HIGH_IMPACT[entry.action] ?? entry.action} · ${entry.outcome}`,
        detail: entry.detail,
        tone: entry.outcome === "failed" ? "danger" : entry.outcome === "queued" ? "warning" : "normal",
      })),
      empty: "还没有动作记录。",
    });
  }

  sections.push({
    id: "capability",
    kind: "table",
    title: "能力矩阵",
    columns: [{ key: "name", label: "能力" }, { key: "state", label: "状态" }, { key: "why", label: "说明" }],
    rows: [
      ["接收消息并交给 Bot", status.connected ? "可用" : "待连接", status.connected ? "当前线路已连接。" : "配置传输线路后可用。"],
      ["知识库自动回复", rules.enabled ? "可用" : "已关闭", rules.enabled ? `今日已回复 ${status.repliesToday}/${rules.maxRepliesPerDay}。` : "在规则里开启后生效。"],
      ["商品搜索", currentCookie().includes("_m_h5_tk") ? "可用" : "需 Cookie", currentCookie().includes("_m_h5_tk") ? "使用已登录 Cookie。" : "需要配置已登录 Cookie。"],
      ["发布 / 改价 / 发货 / 退款", "按规则", "在规则里逐项设为自动或由你决定。"],
      ["验证码与风控", "不处理", "遇到安全验证一律暂停并交给你本人处理，不做任何绕过。"],
    ].map(([name, state, why], index) => ({
      id: `cap-${index}`,
      cells: {
        name: { kind: "text", value: name },
        state: { kind: "status", value: state, tone: state === "可用" ? "accent" : state === "不处理" ? "warning" : "muted" },
        why: { kind: "text", value: why, tone: "muted" },
      },
    })),
  });

  return sections;
}

function buildBoard(loaded, rules) {
  const queue = loadQueue();
  return {
    schemaVersion: 1,
    platform: "xianyu",
    generatedAt: new Date().toISOString(),
    account: loaded?.accountId
      ? {
        id: loaded.accountId,
        displayName: loaded.selfName || "闲鱼账户",
        status: status.connected ? "connected" : "unavailable",
        autoMode: rules.enabled ? "auto" : "off",
        ...(status.lastInboundAt ? { lastSyncAt: status.lastInboundAt } : {}),
      }
      : null,
    headline: [
      { key: "inbound", label: "入站消息", value: String(status.inboundDelivered) },
      { key: "outbound", label: "已回复", value: String(status.outboundSent) },
      { key: "pending", label: "待发送", value: String(status.outboundPending), tone: status.outboundPending > 0 ? "warning" : "normal" },
      { key: "queue", label: "待审批", value: String(queue.items.length), tone: queue.items.length > 0 ? "warning" : "normal" },
      { key: "replies", label: "今日自动回复", value: `${status.repliesToday}/${rules.maxRepliesPerDay}` },
    ],
    sections: boardSections(rules),
    actions: [
      { id: "self-check", label: "运行网页自检", effect: "read", mode: "manual", available: loaded?.transport !== "protocol" && Boolean(loaded?.cdpUrl), reason: loaded?.transport === "protocol" ? "当前为纯协议线路，网页自检不适用。" : loaded?.cdpUrl ? undefined : "尚未配置 cdpUrl，无法驱动网页。" },
      { id: "read-items", label: "同步商品", effect: "read", mode: "manual", available: loaded?.transport !== "protocol" && Boolean(loaded?.cdpUrl) },
      { id: "read-orders", label: "同步订单", effect: "read", mode: "manual", available: loaded?.transport !== "protocol" && Boolean(loaded?.cdpUrl) },
      { id: "enable-rules", label: "开启自动回复", effect: "write", mode: "manual", available: !rules.enabled, confirm: true },
      { id: "disable-rules", label: "关闭自动回复", effect: "write", mode: "manual", available: rules.enabled },
    ],
    limits: [{ key: "replies", label: "自动回复", used: status.repliesToday, cap: Math.max(1, rules.maxRepliesPerDay), window: "今日" }],
    capability: [
      { id: "inbound", label: "接收消息", state: status.connected ? "production" : "experimental", reason: status.connected ? undefined : "传输线路尚未连接。" },
      { id: "auto-reply", label: "知识库自动回复", state: rules.enabled ? "production" : "experimental", reason: rules.enabled ? undefined : "在规则中开启后生效。" },
      { id: "items", label: "商品与订单同步", state: "experimental", reason: "依赖网页结构，改版后需要重新自检。" },
      { id: "publish", label: "发布 / 改价 / 发货 / 退款", state: "experimental", reason: "按规则执行；建议先保持「由你决定」。" },
      { id: "captcha", label: "验证码与风控", state: "unavailable", reason: "遇到安全验证会暂停并交给你本人，不做绕过。" },
    ],
  };
}

// ---------------------------------------------------------------- tools

const TOOLS = {
  "xy-kb-add": async (args) => {
    const question = String(args.question ?? "").trim();
    const answer = String(args.answer ?? "").trim();
    if (!question) throw new ToolError("invalid-args", "question is required", false);
    if (!answer) throw new ToolError("invalid-args", "answer is required", false);
    const state = loadKb();
    if (state.items.length >= 500) throw new ToolError("store-full", "the knowledge base holds 500 entries already", false);
    if (state.items.some((item) => item.question === question)) throw new ToolError("duplicate", `the knowledge base already answers "${question.slice(0, 60)}"`, false);
    const entry = {
      id: randomUUID(),
      question: question.slice(0, 200),
      answer: answer.slice(0, 2_000),
      tags: Array.isArray(args.tags) ? args.tags.filter((tag) => typeof tag === "string").slice(0, 10) : [],
      createdAt: new Date().toISOString(),
    };
    state.items.push(entry);
    writeJsonFile(KB, state);
    return { entry };
  },

  "xy-kb-list": async (args) => {
    const state = loadKb();
    const search = typeof args.search === "string" && args.search.trim() ? args.search.trim().toLowerCase() : null;
    const rows = state.items.filter((item) => !search || `${item.question} ${item.answer} ${(item.tags ?? []).join(" ")}`.toLowerCase().includes(search));
    const limit = Math.min(Number(args.limit) > 0 ? Number(args.limit) : 50, 200);
    return { count: rows.length, items: rows.slice(-limit), rules: state.rules };
  },

  "xy-kb-delete": async (args) => {
    const id = String(args.id ?? "").trim();
    const state = loadKb();
    const kept = state.items.filter((item) => item.id !== id);
    if (kept.length === state.items.length) throw new ToolError("not-found", `no entry ${id.slice(0, 60)}`, false);
    state.items = kept;
    writeJsonFile(KB, state);
    return { removed: id };
  },

  "xy-rules": async (args) => {
    const state = loadKb();
    const rules = args.rules && typeof args.rules === "object" && !Array.isArray(args.rules) ? args.rules : null;
    if (!rules) throw new ToolError("invalid-args", "rules object is required: { enabled, onlyTrusted?, maxRepliesPerDay?, actions? }", false);
    const actions = { ...state.rules.actions };
    if (rules.actions && typeof rules.actions === "object") {
      for (const key of Object.keys(DEFAULT_RULES.actions)) {
        if (rules.actions[key] === "auto" || rules.actions[key] === "manual") actions[key] = rules.actions[key];
      }
    }
    const next = {
      enabled: rules.enabled === true,
      onlyTrusted: rules.onlyTrusted !== false,
      maxRepliesPerDay: Math.min(Math.max(Number(rules.maxRepliesPerDay) > 0 ? Number(rules.maxRepliesPerDay) : 20, 1), 200),
      actions,
    };
    state.rules = next;
    writeJsonFile(KB, state);
    return { rules: next };
  },

  "xy-item-search": async (args) => {
    const keyword = String(args.keyword ?? "").trim();
    if (!keyword) throw new ToolError("invalid-keyword", "keyword is required", false);
    const cookie = currentCookie();
    if (!cookie || !cookie.includes("_m_h5_tk")) throw new ToolError("no-login", "config.json's cookie must be a logged-in goofish cookie containing _m_h5_tk", false);
    const page = Math.max(Number(args.page) > 0 ? Number(args.page) : 1, 1);
    const items = await itemSearch(cookie, keyword, page);
    return { keyword, page, count: items.length, items, note: "experimental endpoint without an official contract; results may be incomplete" };
  },

  "xy-bridge-status": async () => ({
    ...status,
    inboundQueued: bridgeState.inbound.length,
    config: config ? { transport: config.transport, accountId: config.accountId, serverUrl: config.serverUrl, cdp: Boolean(config.cdpUrl) } : null,
    rules: loadKb().rules,
  }),

  "xy-transport-configure": async (args) => {
    const mode = String(args.transport ?? "").trim();
    if (!["protocol", "web", "auto"].includes(mode)) throw new ToolError("invalid-args", "transport must be protocol, web or auto", false);
    const file = join(process.cwd(), "config.json");
    const previous = existsSync(file) ? readJsonFile(file, {}) : {};
    const next = { ...previous, transport: mode };
    for (const key of ["cookie", "accountId", "cdpUrl", "serverUrl", "selfName"]) {
      if (typeof args[key] === "string" && args[key].trim()) next[key] = args[key].trim();
    }
    if (typeof args.serverToken === "string") next.serverToken = args.serverToken;
    writeJsonFile(file, next);
    return { transport: mode, restartRequired: true };
  },

  "xy-action": async (args) => {
    const action = String(args.action ?? "").trim();
    return performAction(action, args.params ?? {});
  },
};

// ---------------------------------------------------------------- protocol loop

function result(value) {
  return { status: "succeeded", value };
}

function failure(error) {
  if (error instanceof ToolError || error instanceof TransportError) {
    return { status: "failed", code: error.code, message: error.message.slice(0, 2000), retryable: Boolean(error.retryable) };
  }
  return { status: "failed", code: "internal", message: String(error instanceof Error ? error.message : error).slice(0, 2000), retryable: false };
}

function answer(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

function answerError(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(message).slice(0, 800) } })}\n`);
}

async function operate(action, params) {
  if (action === "self-check") {
    if (typeof transport?.selfCheck !== "function") throw new ToolError("no-web", "the running line has no page to check", false);
    const report = await transport.selfCheck();
    status.selfCheck = report;
    return { ok: true, report };
  }
  if (action === "read-items") {
    if (typeof transport?.readItems !== "function") throw new ToolError("no-web", "the running line cannot read the listings", false);
    const items = await transport.readItems();
    status.items = items;
    return { ok: true, items };
  }
  if (action === "read-orders") {
    if (typeof transport?.readOrders !== "function") throw new ToolError("no-web", "the running line cannot read the orders", false);
    const orders = await transport.readOrders();
    status.orders = orders;
    return { ok: true, orders };
  }
  if (action === "enable-rules" || action === "disable-rules") {
    const state = loadKb();
    state.rules.enabled = action === "enable-rules";
    writeJsonFile(KB, state);
    return { ok: true, rules: state.rules };
  }
  if (action === "set-transport") {
    const mode = String(params?.transport ?? "");
    if (!["protocol", "web", "auto"].includes(mode)) throw new ToolError("invalid-args", "transport must be protocol, web or auto", false);
    const file = join(process.cwd(), "config.json");
    const previous = existsSync(file) ? readJsonFile(file, {}) : {};
    writeJsonFile(file, { ...previous, transport: mode });
    // The tick rebuilds the line on the next pass; saying so beats a silent wait.
    return { ok: true, transport: mode, restartRequired: false, message: `已切换到 ${mode} 线路，下一轮轮询生效。` };
  }
  if (action === "approve" || action === "dismiss") return decideQueued(params?.itemId, action);
  if (HIGH_IMPACT[action]) return performAction(action, params);
  throw new ToolError("invalid-action", `unknown board action ${String(action).slice(0, 60)}`, false);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (text) => {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  if (!frame || typeof frame !== "object" || frame.id === undefined || frame.id === null) return;

  if (frame.method === "initialize") {
    startBridge();
    answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.xianyu" });
    return;
  }
  if (frame.method === "shutdown") {
    void stopBridge().finally(() => process.exit(0));
    return;
  }

  // Host methods: a board or a status read needs no bot grant, so a broken bridge stays diagnosable.
  if (frame.method === "board") {
    try {
      answer(frame.id, buildBoard(config, loadKb().rules));
    } catch (error) {
      answerError(frame.id, error instanceof Error ? error.message : error);
    }
    return;
  }
  if (frame.method === "audit") {
    const limit = Math.min(Math.max(Number(frame.params?.limit) || 50, 1), 200);
    answer(frame.id, loadAudit().entries.slice(-limit).reverse());
    return;
  }
  if (frame.method === "operate") {
    const action = String(frame.params?.action ?? "");
    Promise.resolve()
      .then(() => operate(action, frame.params?.params ?? {}))
      .then((value) => answer(frame.id, value), (error) => answerError(frame.id, failure(error).message));
    return;
  }
  if (frame.method === "status") {
    const rules = loadKb().rules;
    const line = transport?.state?.() ?? {};
    answer(frame.id, {
      transportMode: status.mode ?? "auto",
      transportLive: status.live ?? "none",
      protocolState: line.protocol ?? (status.connected ? "up" : "down"),
      webState: line.web ?? "unknown",
      connected: status.connected,
      inboxQueued: bridgeState.inbound.length,
      inboxDelivered: status.inboundDelivered,
      inboxRefused: status.inboundRefused,
      outboxSent: status.outboundSent,
      outboxPending: status.outboundPending,
      rulesEnabled: rules.enabled,
      maxRepliesPerDay: rules.maxRepliesPerDay,
      repliesToday: status.repliesToday,
      lastError: status.lastError ?? "",
    });
    return;
  }

  if (frame.method !== "tools/call") { answerError(frame.id, "unknown method"); return; }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) { answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false }); return; }
  Promise.resolve(tool(params.arguments ?? {})).then(result, failure).then((value) => answer(frame.id, value));
});
