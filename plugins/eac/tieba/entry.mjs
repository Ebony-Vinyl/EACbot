// eac.tieba — the Tieba bridge and desk for EACbot.
//
// Tieba has no open read API, so everything goes through the signed-in pages in a Chrome the person already
// signed in: the reply inbox, a forum's threads, a thread's floors, and posting. The bridge is shared with the
// other platforms (queueing, retry rules, daily limits, audit); what lives here is Tieba's own business.
//
// A verification page or a risk-control prompt stops the line and is reported as itself. Nothing here retries
// around a check, solves a captcha or changes a fingerprint.
//
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult,
// board/operate/audit/status -> data, shutdown -> exit.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { BridgeError, bridgeBoard, createBridge, readJson, writeJson } from "../shared/bridge.mjs";
import { createPageTransport } from "../shared/web/line.mjs";
import { createCdpBrowser } from "../shared/web/cdp.mjs";
import { TIEBA_WEB_PROFILE } from "./web/parse.mjs";

const DRAFTS = join(process.cwd(), "tieba-drafts.json");

const HIGH_IMPACT = { reply: "发表回帖" };

const DEFAULT_RULES = {
  enabled: false,
  maxRepliesPerDay: 20,
  /** Posting is a person's decision until the rule says otherwise. */
  actions: { reply: "manual" },
};

const COPY = {
  pendingTitle: "待审批动作",
  pendingReason: "该动作的规则是「由你决定」，需要你确认后才会执行。",
  pendingEmpty: "没有待审批的动作。",
  approve: "确认执行",
  dismiss: "忽略",
  auditTitle: "动作审计",
  auditEmpty: "还没有动作记录。",
};

function loadDesk() {
  const state = readJson(DRAFTS, null);
  if (!state || !Array.isArray(state.drafts)) return { schemaVersion: 1, drafts: [], rules: structuredClone(DEFAULT_RULES) };
  const rules = state.rules && typeof state.rules === "object" ? state.rules : {};
  return {
    schemaVersion: 1,
    drafts: state.drafts,
    rules: {
      ...structuredClone(DEFAULT_RULES),
      ...rules,
      actions: { ...DEFAULT_RULES.actions, ...(rules.actions && typeof rules.actions === "object" ? rules.actions : {}) },
    },
  };
}

const saveDesk = (state) => writeJson(DRAFTS, state);

function readConfig() {
  const file = join(process.cwd(), "config.json");
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new BridgeError("config-invalid", "config.json is not valid JSON", false);
  }
  if (!parsed || typeof parsed !== "object") throw new BridgeError("config-invalid", "config.json must be an object", false);
  return {
    transport: "web",
    accountId: typeof parsed.accountId === "string" ? parsed.accountId.trim() : "",
    cdpUrl: typeof parsed.cdpUrl === "string" ? parsed.cdpUrl.trim() : "",
    serverUrl: (typeof parsed.serverUrl === "string" && parsed.serverUrl.trim() ? parsed.serverUrl : "http://127.0.0.1:8799").replace(/\/+$/, ""),
    serverToken: typeof parsed.serverToken === "string" ? parsed.serverToken : "",
    pollMs: Math.min(Math.max(Number(parsed.pollMs) || 20_000, 5_000), 300_000),
    selfName: typeof parsed.selfName === "string" ? parsed.selfName.trim() : "",
  };
}

const configChanged = (previous, next) => previous.accountId !== next.accountId
  || previous.cdpUrl !== next.cdpUrl || previous.serverUrl !== next.serverUrl || previous.serverToken !== next.serverToken;

const DESK = {
  readConfig,
  configChanged,
  copy: COPY,
  actionLabel: (action) => HIGH_IMPACT[action] ?? action,
  rules: () => loadDesk().rules,
  replyCap: () => loadDesk().rules.maxRepliesPerDay,
  account: ({ rules, status, bridge }) => bridge.config?.accountId
    ? {
      id: bridge.config.accountId,
      displayName: bridge.config.selfName || "贴吧账户",
      status: status.connected ? "connected" : "unavailable",
      autoMode: rules.enabled ? "auto" : "off",
      ...(status.lastInboundAt ? { lastSyncAt: status.lastInboundAt } : {}),
    }
    : null,
  headline: ({ status, queue }) => [
    { key: "inbound", label: "入站消息", value: String(status.inboundDelivered) },
    { key: "outbound", label: "已回复", value: String(status.outboundSent) },
    { key: "pending", label: "待发送", value: String(status.outboundPending), tone: status.outboundPending > 0 ? "warning" : "normal" },
    { key: "queue", label: "待审批", value: String(queue.items.length), tone: queue.items.length > 0 ? "warning" : "normal" },
  ],
  sections: ({ status }) => [{
    id: "transport",
    kind: "notice",
    title: "网页线路",
    notices: [{
      tone: status.connected ? "info" : "warning",
      text: status.connected ? "已连接贴吧网页。" : `网页线路未连接：${status.lastError ?? "尚无连接记录"}。`,
    }],
  }],
  actions: ({ bridge }) => [
    { id: "self-check", label: "运行网页自检", effect: "read", mode: "manual", available: Boolean(bridge.config?.cdpUrl), reason: bridge.config?.cdpUrl ? undefined : "尚未配置 cdpUrl，无法驱动网页。" },
    { id: "read-items", label: "同步吧内帖子", effect: "read", mode: "manual", available: Boolean(bridge.config?.cdpUrl) },
    { id: "enable-rules", label: "开启自动回复", effect: "write", mode: "manual", available: !loadDesk().rules.enabled, confirm: true },
    { id: "disable-rules", label: "关闭自动回复", effect: "write", mode: "manual", available: loadDesk().rules.enabled },
  ],
  limits: ({ rules }) => [{ key: "replies", label: "自动回复", used: BRIDGE.state.sent?.count ?? 0, cap: Math.max(1, rules.maxRepliesPerDay), window: "今日" }],
  capability: ({ status }) => [
    { id: "inbound", label: "接收回复通知", state: status.connected ? "production" : "experimental", reason: status.connected ? undefined : "网页线路尚未连接。" },
    { id: "read", label: "读取吧内帖子与楼层", state: "experimental", reason: "依赖网页结构，改版后需要重新自检。" },
    { id: "post", label: "发表回帖", state: "experimental", reason: "按规则执行；建议先保持「由你决定」。" },
    { id: "captcha", label: "验证码与风控", state: "unavailable", reason: "遇到安全验证会暂停并交给你本人，不做绕过。" },
  ],
};

const BRIDGE = createBridge({
  platform: "tieba",
  workDir: process.cwd(),
  buildTransport: (config) => createPageTransport({
    profile: TIEBA_WEB_PROFILE,
    browser: createCdpBrowser({ cdpUrl: config.cdpUrl }),
    accountId: config.accountId,
    pollMs: config.pollMs,
  }),
  desk: DESK,
});

// ---------------------------------------------------------------- high-impact actions

async function performAction(action, params) {
  const rules = loadDesk().rules;
  if ((rules.actions?.[action] ?? "manual") === "manual") {
    const queue = BRIDGE.loadQueue();
    const entry = { id: randomUUID(), action, params, at: new Date().toISOString(), state: "waiting" };
    queue.items.push(entry);
    BRIDGE.saveQueue(queue);
    BRIDGE.audit(action, "queued", "the rule for this action is a person's decision");
    return { ok: true, queued: entry, message: `${HIGH_IMPACT[action]} 已进入待审批队列。` };
  }
  try {
    const result = await BRIDGE.sendNow({ conversationId: String(params?.conversationId ?? ""), conversationKind: "direct", text: String(params?.text ?? "") });
    BRIDGE.audit(action, "done", JSON.stringify(result).slice(0, 500));
    return { ok: true, result, message: `${HIGH_IMPACT[action]} 已执行。` };
  } catch (error) {
    BRIDGE.audit(action, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function decideQueued(id, decision) {
  const queue = BRIDGE.loadQueue();
  const entry = queue.items.find((item) => item.id === id);
  if (!entry) throw new BridgeError("not-found", `no queued action ${String(id).slice(0, 60)}`, false);
  if (decision === "dismiss") {
    queue.items = queue.items.filter((item) => item.id !== id);
    BRIDGE.saveQueue(queue);
    BRIDGE.audit(entry.action, "dismissed", "a person dismissed it");
    return { ok: true, dismissed: id };
  }
  // An approval that could not run leaves the item queued and says why: dropping it would lose the request.
  try {
    const result = await BRIDGE.sendNow({ conversationId: String(entry.params?.conversationId ?? ""), conversationKind: "direct", text: String(entry.params?.text ?? "") });
    queue.items = queue.items.filter((item) => item.id !== id);
    BRIDGE.saveQueue(queue);
    BRIDGE.audit(entry.action, "done", JSON.stringify(result).slice(0, 500));
    return { ok: true, result };
  } catch (error) {
    BRIDGE.audit(entry.action, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function operate(action, params) {
  if (action === "self-check") {
    if (typeof BRIDGE.transport?.selfCheck !== "function") throw new BridgeError("no-web", "the running line has no page to check", false);
    return { ok: true, report: await BRIDGE.transport.selfCheck() };
  }
  if (action === "read-items") {
    if (typeof BRIDGE.transport?.readItems !== "function") throw new BridgeError("no-web", "the running line cannot read threads", false);
    return { ok: true, threads: await BRIDGE.transport.readItems() };
  }
  if (action === "enable-rules" || action === "disable-rules") {
    const state = loadDesk();
    state.rules.enabled = action === "enable-rules";
    saveDesk(state);
    return { ok: true, rules: state.rules };
  }
  if (action === "approve" || action === "dismiss") return decideQueued(params?.itemId, action);
  if (HIGH_IMPACT[action]) return performAction(action, params);
  throw new BridgeError("invalid-action", `unknown board action ${String(action).slice(0, 60)}`, false);
}

// ---------------------------------------------------------------- tools

const TOOLS = {
  "tieba-forum-threads": async (args) => {
    const forum = String(args.forum ?? "").trim();
    if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(forum)) throw new BridgeError("invalid-forum", "forum must be 1-40 letters, digits, _ or -", false);
    if (typeof BRIDGE.transport?.readItems !== "function") throw new BridgeError("no-web", "the web line is not running, so nothing can be read", true);
    return { forum, threads: await BRIDGE.transport.readItems() };
  },

  "tieba-thread-detail": async (args) => {
    const threadId = String(args.threadId ?? "").trim();
    if (!/^\d{6,20}$/.test(threadId)) throw new BridgeError("invalid-thread", "threadId must be 6-20 digits", false);
    if (typeof BRIDGE.transport?.readOrders !== "function") throw new BridgeError("no-web", "the web line is not running, so nothing can be read", true);
    return { threadId, floors: await BRIDGE.transport.readOrders() };
  },

  "tieba-reply-draft": async (args) => {
    const action = String(args.action ?? "").trim();
    const state = loadDesk();
    if (action === "list") {
      const threadId = String(args.threadId ?? "").trim();
      const rows = threadId ? state.drafts.filter((draft) => draft.threadId === threadId) : state.drafts;
      return { count: rows.length, drafts: rows.slice(-50) };
    }
    if (action === "delete") {
      const id = String(args.id ?? "").trim();
      const kept = state.drafts.filter((draft) => draft.id !== id);
      if (kept.length === state.drafts.length) throw new BridgeError("not-found", `no draft ${id.slice(0, 60)}`, false);
      state.drafts = kept;
      saveDesk(state);
      return { removed: id };
    }
    if (action !== "save") throw new BridgeError("invalid-action", "action must be save, list or delete", false);
    const text = String(args.text ?? "").trim();
    const threadId = String(args.threadId ?? "").trim();
    if (!text) throw new BridgeError("invalid-text", "text is required", false);
    if (text.length > 500) throw new BridgeError("invalid-text", "a Tieba reply is at most 500 characters", false);
    if (!/^\d{6,20}$/.test(threadId)) throw new BridgeError("invalid-thread", "threadId must be 6-20 digits", false);
    if (state.drafts.length >= 200) throw new BridgeError("store-full", "there are 200 drafts already", false);
    const draft = { id: randomUUID(), threadId, text, createdAt: new Date().toISOString() };
    state.drafts.push(draft);
    saveDesk(state);
    return { draft };
  },

  "tieba-rules": async (args) => {
    const state = loadDesk();
    const rules = args.rules && typeof args.rules === "object" ? args.rules : null;
    if (!rules) throw new BridgeError("invalid-args", "rules object is required: { enabled, maxRepliesPerDay?, actions? }", false);
    const actions = { ...state.rules.actions };
    if (rules.actions && typeof rules.actions === "object") {
      for (const key of Object.keys(DEFAULT_RULES.actions)) {
        if (rules.actions[key] === "auto" || rules.actions[key] === "manual") actions[key] = rules.actions[key];
      }
    }
    state.rules = {
      enabled: rules.enabled === true,
      maxRepliesPerDay: Math.min(Math.max(Number(rules.maxRepliesPerDay) > 0 ? Number(rules.maxRepliesPerDay) : 20, 1), 200),
      actions,
    };
    saveDesk(state);
    return { rules: state.rules };
  },

  "tieba-reply-post": async (args) => {
    const text = String(args.text ?? "").trim();
    if (!text) throw new BridgeError("invalid-text", "text is required", false);
    return performAction("reply", { conversationId: String(args.threadId ?? ""), text });
  },

  "tieba-bridge-status": async () => ({
    ...BRIDGE.status,
    inboundQueued: BRIDGE.state.inbound.length,
    config: BRIDGE.config ? { accountId: BRIDGE.config.accountId, cdp: Boolean(BRIDGE.config.cdpUrl) } : null,
    rules: loadDesk().rules,
  }),
};

// ---------------------------------------------------------------- protocol loop

const failure = (error) => error instanceof BridgeError
  ? { status: "failed", code: error.code, message: error.message.slice(0, 2000), retryable: Boolean(error.retryable) }
  : { status: "failed", code: "internal", message: String(error instanceof Error ? error.message : error).slice(0, 2000), retryable: false };

const answer = (id, value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
const answerError = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(message).slice(0, 800) } })}\n`);

const lines = createInterface({ input: process.stdin });
lines.on("line", (text) => {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  if (!frame || typeof frame !== "object" || frame.id === undefined || frame.id === null) return;

  if (frame.method === "initialize") {
    BRIDGE.start();
    answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.tieba" });
    return;
  }
  if (frame.method === "shutdown") {
    void BRIDGE.stop().finally(() => process.exit(0));
    return;
  }
  if (frame.method === "board") {
    try {
      answer(frame.id, bridgeBoard({ platform: "tieba", bridge: BRIDGE, desk: DESK }));
    } catch (error) {
      answerError(frame.id, error instanceof Error ? error.message : error);
    }
    return;
  }
  if (frame.method === "audit") {
    const limit = Math.min(Math.max(Number(frame.params?.limit) || 50, 1), 200);
    answer(frame.id, BRIDGE.loadAudit().slice(-limit).reverse());
    return;
  }
  if (frame.method === "operate") {
    Promise.resolve()
      .then(() => operate(String(frame.params?.action ?? ""), frame.params?.params ?? {}))
      .then((value) => answer(frame.id, value), (error) => answerError(frame.id, failure(error).message));
    return;
  }
  if (frame.method === "status") {
    const rules = loadDesk().rules;
    answer(frame.id, {
      transportMode: "web",
      transportLive: BRIDGE.status.connected ? "web" : "none",
      protocolState: "n/a",
      webState: BRIDGE.status.connected ? "up" : "down",
      connected: BRIDGE.status.connected,
      inboxQueued: BRIDGE.state.inbound.length,
      inboxDelivered: BRIDGE.status.inboundDelivered,
      inboxRefused: BRIDGE.status.inboundRefused,
      outboxSent: BRIDGE.status.outboundSent,
      outboxPending: BRIDGE.status.outboundPending,
      rulesEnabled: rules.enabled,
      maxRepliesPerDay: rules.maxRepliesPerDay,
      repliesToday: BRIDGE.state.sent?.count ?? 0,
      lastError: BRIDGE.status.lastError ?? "",
    });
    return;
  }
  if (frame.method !== "tools/call") { answerError(frame.id, "unknown method"); return; }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) { answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false }); return; }
  Promise.resolve(tool(params.arguments ?? {})).then(
    (value) => answer(frame.id, { status: "succeeded", value }),
    (error) => answer(frame.id, failure(error)),
  );
});
