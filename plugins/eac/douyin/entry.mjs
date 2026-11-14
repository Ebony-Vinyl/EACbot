// eac.douyin — the Douyin content desk and publishing bridge for EACbot.
//
// The desk is local: angles, materials, note drafts and a plan. Publishing is a rule-gated action: `manual`
// (the default) queues it for a person; `auto` publishes through the signed-in creator page in a Chrome the
// person already signed in. Both paths are audited, and a page that asks for a security check stops the line.
//
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult,
// board/operate/audit/status -> data, shutdown -> exit.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BridgeError, bridgeBoard, createBridge } from "../shared/bridge.mjs";
import { createPageTransport } from "../shared/web/line.mjs";
import { createCdpBrowser } from "../shared/web/cdp.mjs";
import { DY_WEB_PROFILE } from "./web/parse.mjs";

const STORE = join(process.cwd(), "douyin-desk.json");
const CAPS = { ideas: 300, materials: 500, drafts: 200, plans: 200 };

class ToolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function loadDesk() {
  if (!existsSync(STORE)) return { schemaVersion: 1, ideas: [], materials: [], drafts: [], plans: [] };
  const parsed = JSON.parse(readFileSync(STORE, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1) throw new ToolError("store-corrupt", "douyin-desk.json does not match schema version 1", false);
  return { ideas: [], materials: [], drafts: [], plans: [], ...parsed };
}

function saveDesk(state) {
  mkdirSync(dirname(STORE), { recursive: true, mode: 0o700 });
  const tmp = `${STORE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STORE);
}

const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

function collection(state, name) {
  if (!Array.isArray(state[name])) throw new ToolError("invalid-args", `unknown collection ${name}`, false);
  return state[name];
}

function simpleListTool(name, cap) {
  return async (args) => {
    const action = String(args.action ?? "list").trim();
    const state = loadDesk();
    const rows = collection(state, name);
    if (action === "list") {
      const status = text(args.status, 20);
      const found = rows.filter((row) => !status || row.status === status);
      return { count: found.length, items: found.slice(-Math.min(Number(args.limit) > 0 ? Number(args.limit) : 50, 200)) };
    }
    if (action === "delete") {
      const id = String(args.id ?? "").trim();
      const kept = rows.filter((row) => row.id !== id);
      if (kept.length === rows.length) throw new ToolError("not-found", `no ${name.replace(/s$/, "")} ${id.slice(0, 60)}`, false);
      state[name] = kept;
      saveDesk(state);
      return { deleted: id };
    }
    if (action !== "add" && action !== "save" && action !== "update" && action !== "done") throw new ToolError("invalid-action", `action must be add|list|delete${name === "drafts" ? "|update" : ""}${name === "plans" ? "|done" : ""}`, false);
    if (rows.length >= cap) throw new ToolError("store-full", `${name} holds at most ${cap}`, false);
    const now = new Date().toISOString();
    if (action === "add" || action === "save") {
      const row = { id: randomUUID(), createdAt: now };
      if (name === "ideas") {
        const title = text(args.title, 200);
        if (!title) throw new ToolError("invalid-args", "title is required", false);
        Object.assign(row, { title, hook: text(args.hook, 500), status: "open" });
      } else if (name === "materials") {
        const title = text(args.title, 200);
        const body = text(args.body, 5000);
        if (!title || !body) throw new ToolError("invalid-args", "title and body are required", false);
        Object.assign(row, { title, body, tags: Array.isArray(args.tags) ? args.tags.map((tag) => String(tag).slice(0, 30)).slice(0, 10) : [] });
      } else if (name === "drafts") {
        const title = text(args.title, 200);
        const script = text(args.script, 20_000);
        if (!title || !script) throw new ToolError("invalid-args", "title and script are required", false);
        Object.assign(row, { title, script, shotList: Array.isArray(args.shotList) ? args.shotList.map((shot) => String(shot).slice(0, 300)).slice(0, 50) : [], status: "draft" });
      } else {
        const draftId = String(args.draftId ?? "").trim();
        const plannedFor = text(args.plannedFor, 40);
        if (!draftId || !plannedFor) throw new ToolError("invalid-args", "draftId and plannedFor are required", false);
        if (!state.drafts.some((draft) => draft.id === draftId)) throw new ToolError("not-found", `no draft ${draftId.slice(0, 60)}`, false);
        Object.assign(row, { draftId, plannedFor, note: text(args.note, 500), status: "planned" });
      }
      rows.push(row);
      saveDesk(state);
      return { added: row.id, item: row };
    }
    const id = String(args.id ?? "").trim();
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new ToolError("not-found", `no ${name.replace(/s$/, "")} ${id.slice(0, 60)}`, false);
    if (action === "done") row.status = "done";
    else if (name === "drafts") {
      if (text(args.title, 200)) row.title = text(args.title, 200);
      if (text(args.script, 20_000)) row.script = text(args.script, 20_000);
      if (text(args.status, 20) && ["draft", "ready", "published", "dropped"].includes(text(args.status, 20))) row.status = text(args.status, 20);
    }
    row.updatedAt = now;
    saveDesk(state);
    return { updated: id, item: row };
  };
}

const TOOLS = {
  "dy-idea": simpleListTool("ideas", CAPS.ideas),
  "dy-material": simpleListTool("materials", CAPS.materials),
  "dy-draft": simpleListTool("drafts", CAPS.drafts),
  "dy-plan": simpleListTool("plans", CAPS.plans),
  "dy-publish": async (args) => performPublish(args),
  "dy-rules": async (args) => ({ rules: setPublishMode(String(args.mode ?? "")) }),
  "dy-bridge-status": async () => ({
    ...BRIDGE.status,
    config: BRIDGE.config ? { accountId: BRIDGE.config.accountId, cdp: Boolean(BRIDGE.config.cdpUrl) } : null,
    publishMode: publishMode(),
  }),
};

// ---------------------------------------------------------------- publishing

function loadRules() {
  const state = loadDesk();
  const rules = state.rules && typeof state.rules === "object" ? state.rules : {};
  return { actions: { publish: "manual", ...(rules.actions && typeof rules.actions === "object" ? rules.actions : {}) } };
}

function publishMode() {
  return loadRules().actions.publish ?? "manual";
}

function setPublishMode(mode) {
  if (!["auto", "manual"].includes(mode)) throw new ToolError("invalid-args", "mode must be auto or manual", false);
  const state = loadDesk();
  const current = loadRules();
  state.rules = { ...current, actions: { ...current.actions, publish: mode } };
  saveDesk(state);
  return state.rules;
}

const audit = (action, outcome, detail) => BRIDGE.audit(action, outcome, detail);

const loadQueue = () => BRIDGE.loadQueue();
const saveQueue = (queue) => BRIDGE.saveQueue(queue);

function readConfig() {
  const file = join(process.cwd(), "config.json");
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new BridgeError("config-invalid", "config.json is not valid JSON", false);
  }
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

const COPY = {
  pendingTitle: "待审批动作",
  pendingReason: "发布在规则中设为「由你决定」，需要你确认后才会执行。",
  pendingEmpty: "没有待审批的动作。",
  approve: "确认执行",
  dismiss: "忽略",
  auditTitle: "动作审计",
  auditEmpty: "还没有动作记录。",
};

const DESK = {
  readConfig,
  configChanged,
  copy: COPY,
  actionLabel: (action) => (action === "publish" ? "发布视频" : action),
  rules: () => loadRules(),
  replyCap: () => 0,
  account: ({ status, bridge }) => bridge.config?.accountId
    ? {
      id: bridge.config.accountId,
      displayName: bridge.config.selfName || "抖音账户",
      status: status.connected ? "connected" : "unavailable",
      autoMode: publishMode() === "auto" ? "auto" : "off",
    }
    : null,
  headline: ({ queue }) => {
    const state = loadDesk();
    return [
      { key: "ideas", label: "选题", value: String(state.ideas.length) },
      { key: "materials", label: "素材", value: String(state.materials.length) },
      { key: "drafts", label: "视频脚本", value: String(state.drafts.length) },
      { key: "plans", label: "发布计划", value: String(state.plans.length) },
      { key: "queue", label: "待审批", value: String(queue.items.length), tone: queue.items.length > 0 ? "warning" : "normal" },
    ];
  },
  sections: ({ status }) => {
    const state = loadDesk();
    return [
      {
        id: "collected",
        kind: "table",
        title: "已收集",
        columns: [{ key: "kind", label: "类型" }, { key: "count", label: "数量", align: "end" }],
        rows: [["选题", state.ideas.length], ["素材", state.materials.length], ["视频脚本", state.drafts.length], ["发布计划", state.plans.length]]
          .map(([kind, count], index) => ({
            id: `row-${index}`,
            cells: { kind: { kind: "text", value: String(kind) }, count: { kind: "count", value: String(count) } },
          })),
        empty: "还没有收集任何内容。",
      },
      {
        id: "drafts",
        kind: "list",
        title: "视频脚本",
        items: state.drafts.slice(-20).reverse().map((draft) => ({
          id: draft.id,
          title: draft.title ?? "(未命名)",
          subtitle: `${draft.shotList?.length ?? 0} 个分镜 · ${draft.status === "ready" ? "可发布" : draft.status === "published" ? "已发布" : "草稿"}`,
          meta: draft.createdAt?.slice(0, 10),
        })),
        empty: "还没有视频脚本。",
      },
      {
        id: "transport",
        kind: "notice",
        title: "网页线路",
        notices: [{
          tone: status.connected ? "info" : "warning",
          text: status.connected ? "已连接抖音创作服务平台。" : `网页线路未连接：${status.lastError ?? "尚无连接记录"}。`,
        }],
      },
    ];
  },
  actions: ({ bridge }) => [
    { id: "self-check", label: "运行网页自检", effect: "read", mode: "manual", available: Boolean(bridge.config?.cdpUrl), reason: bridge.config?.cdpUrl ? undefined : "尚未配置 cdpUrl，无法驱动网页。" },
    { id: "publish-mode-auto", label: "发布改为自动", effect: "write", mode: "manual", available: publishMode() !== "auto", confirm: true, reason: "自动发布会直接在你账号上发布视频。" },
    { id: "publish-mode-manual", label: "发布改为由你决定", effect: "write", mode: "manual", available: publishMode() === "auto" },
  ],
  limits: () => [],
  capability: ({ status }) => [
    { id: "desk", label: "选题 / 素材 / 脚本 / 计划", state: "production" },
    { id: "publish", label: "发布视频", state: "experimental", reason: status.connected ? "依赖网页结构；建议先保持「由你决定」。" : "需要网页线路连接。" },
    { id: "metrics", label: "数据指标", state: "unavailable", reason: "抖音未向个人创作者开放数据接口，不做推断。" },
    { id: "captcha", label: "验证码与风控", state: "unavailable", reason: "遇到安全验证会暂停并交给你本人，不做绕过。" },
  ],
};

const BRIDGE = createBridge({
  platform: "douyin",
  workDir: process.cwd(),
  buildTransport: (config) => createPageTransport({
    profile: DY_WEB_PROFILE,
    browser: createCdpBrowser({ cdpUrl: config.cdpUrl }),
    accountId: config.accountId,
    pollMs: config.pollMs,
  }),
  desk: DESK,
});

async function performPublish(params) {
  if (publishMode() === "manual") {
    const queue = loadQueue();
    const entry = { id: `${Date.now()}-${queue.items.length}`, action: "publish", params, at: new Date().toISOString(), state: "waiting" };
    queue.items.push(entry);
    saveQueue(queue);
    audit("publish", "queued", "the rule for publishing is a person's decision");
    return { ok: true, queued: entry, message: "发布已进入待审批队列。" };
  }
  try {
    const result = await BRIDGE.sendNow({ conversationId: "", conversationKind: "direct", text: String(params?.script ?? params?.title ?? "") });
    audit("publish", "done", JSON.stringify(result).slice(0, 500));
    return { ok: true, result, message: "发布已执行。" };
  } catch (error) {
    audit("publish", "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function decideQueued(id, decision) {
  const queue = loadQueue();
  const entry = queue.items.find((item) => item.id === id);
  if (!entry) throw new ToolError("not-found", `no queued publish ${String(id).slice(0, 60)}`, false);
  if (decision === "dismiss") {
    queue.items = queue.items.filter((item) => item.id !== id);
    saveQueue(queue);
    audit("publish", "dismissed", "a person dismissed it");
    return { ok: true, dismissed: id };
  }
  // An approval that could not run leaves the item queued and says why: dropping it would lose the request.
  try {
    const result = await BRIDGE.sendNow({ conversationId: "", conversationKind: "direct", text: String(entry.params?.script ?? entry.params?.title ?? "") });
    queue.items = queue.items.filter((item) => item.id !== id);
    saveQueue(queue);
    audit("publish", "done", JSON.stringify(result).slice(0, 500));
    return { ok: true, result };
  } catch (error) {
    audit("publish", "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function operate(action, params) {
  if (action === "self-check") {
    if (typeof BRIDGE.transport?.selfCheck !== "function") throw new ToolError("no-web", "the running line has no page to check", false);
    return { ok: true, report: await BRIDGE.transport.selfCheck() };
  }
  if (action === "publish-mode-auto" || action === "publish-mode-manual") {
    return { ok: true, rules: setPublishMode(action === "publish-mode-auto" ? "auto" : "manual") };
  }
  if (action === "publish") return performPublish(params);
  if (action === "approve" || action === "dismiss") return decideQueued(params?.itemId, action);
  throw new ToolError("invalid-action", `unknown board action ${String(action).slice(0, 60)}`, false);
}

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
  try { frame = JSON.parse(text); } catch { return; }
  if (!frame || typeof frame !== "object" || frame.id === undefined || frame.id === null) return;
  if (frame.method === "initialize") { BRIDGE.start(); answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.douyin" }); return; }
  if (frame.method === "shutdown") { void BRIDGE.stop().finally(() => process.exit(0)); return; }
  if (frame.method === "board") {
    try {
      answer(frame.id, bridgeBoard({ platform: "douyin", bridge: BRIDGE, desk: DESK }));
    } catch (error) {
      answer(frame.id, { error: { code: -32000, message: String(error instanceof Error ? error.message : error) } });
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
      .then((value) => answer(frame.id, value), (error) => answer(frame.id, { error: { code: -32000, message: String(error instanceof Error ? error.message : error).slice(0, 800) } }));
    return;
  }
  if (frame.method === "status") {
    const state = loadDesk();
    answer(frame.id, {
      transportMode: "web",
      transportLive: BRIDGE.status.connected ? "web" : "none",
      protocolState: "n/a",
      webState: BRIDGE.status.connected ? "up" : "down",
      connected: BRIDGE.status.connected,
      ideas: state.ideas.length,
      materials: state.materials.length,
      notes: state.drafts.length,
      plans: state.plans.length,
      publishMode: publishMode(),
      lastError: BRIDGE.status.lastError ?? "",
    });
    return;
  }
  if (frame.method !== "tools/call") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } })}\n`); return; }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) { answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false }); return; }
  Promise.resolve(tool(params.arguments ?? {})).then(result, failure).then((value) => answer(frame.id, value));
});
