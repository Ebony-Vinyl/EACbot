// eac.xianyu — Xianyu helper for EACbot. The knowledge base and auto-reply rules are local and stable; item search
// rides the mobile web mtop endpoint with the account cookie (experimental: the endpoint has no official contract,
// so a refusal is reported as-is). Publishing, price edits and orders are NOT implemented.
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult, shutdown -> exit.
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KB = join(process.cwd(), "xianyu-kb.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const APP_KEY = "12574478";

class ToolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function loadJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && Array.isArray(parsed.items) ? parsed : fallback;
  } catch {
    throw new ToolError("store-corrupt", `${file.split(/[\\/]/).pop()} is not valid JSON`, false);
  }
}

function saveJson(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// The idle-fish mobile web gateway signs each call as md5(token&ts&appKey&data); the token rides the _m_h5_tk cookie.
function mtopSign(token, ts, data) {
  return createHash("md5").update(`${token}&${ts}&${APP_KEY}&${data}`).digest("hex");
}

function cookieValue(cookie, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie);
  return match ? match[1] : null;
}

async function itemSearch(cookie, keyword, page) {
  const tokenPart = cookieValue(cookie, "_m_h5_tk")?.split("_")[0] ?? "";
  const ts = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({ keyword, fromFilter: "", sortType: "", pageNumber: page, itemId: "", customTag: "" });
  const sign = mtopSign(tokenPart, ts, payload);
  const url = `https://h5api.m.goofish.com/h5/mtop.taobao.idle.pc.search.item/1.0/${ts}/${APP_KEY}/${sign}/`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": UA,
        origin: "https://www.goofish.com",
        referer: "https://www.goofish.com/",
        cookie,
      },
      body: new URLSearchParams({ data: payload }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.name;
    throw new ToolError("unreachable", `Goofish is unreachable (${String(cause).slice(0, 60)})`, true);
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolError("bad-response", "Goofish returned a non-JSON answer", true);
  }
  const code = parsed?.ret?.[0] ?? "";
  if (code && !code.startsWith("SUCCESS")) {
    const session = code.includes("SESSION") || code.includes("TOKEN") || code.includes("Login");
    throw new ToolError(session ? "session-expired" : "api-error", `Goofish ${code}: ${session ? "the cookie expired or the token spun up; paste a fresh logged-in cookie" : "refused the search"}`, !session && code.includes("429"));
  }
  const rows = parsed?.data?.resultValue?.resultList ?? parsed?.data?.resultList ?? [];
  return rows.map((row) => {
    const item = row?.data?.item ?? row?.item ?? row;
    return {
      itemId: item?.itemId ?? item?.id ?? null,
      title: item?.title ? String(item.title).replace(/<[^>]+>/g, "") : null,
      price: item?.priceInfo?.price ?? item?.soldPrice ?? null,
      area: item?.area ?? null,
      wantCount: item?.wantNum ?? null,
      sellerNick: item?.userNickName ?? null,
    };
  }).filter((row) => row.itemId || row.title);
}

const TOOLS = {
  "xy-kb-add": async (args) => {
    const question = String(args.question ?? "").trim();
    const answer = String(args.answer ?? "").trim();
    if (!question || !answer) throw new ToolError("invalid-args", "question and answer are required", false);
    if (question.length > 200 || answer.length > 2000) throw new ToolError("invalid-args", "question up to 200 chars, answer up to 2000", false);
    const state = loadJson(KB, { schemaVersion: 1, items: [], rules: { enabled: false, onlyTrusted: true, maxRepliesPerDay: 20 } });
    if (state.items.length >= 500) throw new ToolError("store-full", "the knowledge base holds at most 500 entries", false);
    if (state.items.some((item) => item.question === question)) throw new ToolError("duplicate", `an entry for "${question.slice(0, 60)}" already exists`, false);
    const item = {
      id: randomUUID(),
      question,
      answer,
      tags: Array.isArray(args.tags) ? args.tags.filter((tag) => typeof tag === "string").slice(0, 10) : [],
      createdAt: new Date().toISOString(),
    };
    state.items.push(item);
    saveJson(KB, state);
    return { added: item.id, question };
  },

  "xy-kb-list": async (args) => {
    const state = loadJson(KB, { schemaVersion: 1, items: [], rules: { enabled: false } });
    const search = typeof args.search === "string" && args.search.trim() ? args.search.trim().toLowerCase() : null;
    const rows = state.items.filter((item) => !search || `${item.question} ${item.answer} ${item.tags.join(" ")}`.toLowerCase().includes(search));
    return { count: rows.length, items: rows.slice(-Math.min(Number(args.limit) > 0 ? Number(args.limit) : 50, 200)), rules: state.rules };
  },

  "xy-kb-delete": async (args) => {
    const id = String(args.id ?? "").trim();
    const state = loadJson(KB, { schemaVersion: 1, items: [], rules: {} });
    const kept = state.items.filter((item) => item.id !== id);
    if (kept.length === state.items.length) throw new ToolError("not-found", `no entry ${id.slice(0, 60)}`, false);
    state.items = kept;
    saveJson(KB, state);
    return { removed: id };
  },

  "xy-rules": async (args) => {
    const state = loadJson(KB, { schemaVersion: 1, items: [], rules: { enabled: false, onlyTrusted: true, maxRepliesPerDay: 20 } });
    const rules = args.rules && typeof args.rules === "object" && !Array.isArray(args.rules) ? args.rules : null;
    if (!rules) throw new ToolError("invalid-args", "rules object is required: { enabled: boolean, onlyTrusted?: boolean, maxRepliesPerDay?: 1-200 }", false);
    const next = {
      enabled: rules.enabled === true,
      onlyTrusted: rules.onlyTrusted !== false,
      maxRepliesPerDay: Math.min(Math.max(Number(rules.maxRepliesPerDay) > 0 ? Number(rules.maxRepliesPerDay) : 20, 1), 200),
    };
    state.rules = next;
    saveJson(KB, state);
    // Honest boundary: the rules live here; a connected bridge decides whether it can act on them.
    return { rules: next, note: "saved locally; a connected xianyu bridge reads and applies these. Publishing, price edits and orders are not implemented." };
  },

  "xy-item-search": async (args) => {
    const keyword = String(args.keyword ?? "").trim();
    if (!keyword) throw new ToolError("invalid-keyword", "keyword is required", false);
    const file = join(process.cwd(), "config.json");
    if (!existsSync(file)) throw new ToolError("no-login", "config.json is missing: add { \"cookie\": \"<logged-in goofish cookie with _m_h5_tk and unb>\" } to this plugin's work directory", false);
    const cookie = String(JSON.parse(readFileSync(file, "utf8")).cookie ?? "").trim();
    if (!cookie || !cookie.includes("_m_h5_tk")) throw new ToolError("no-login", "config.json's cookie must be a logged-in goofish cookie containing _m_h5_tk", false);
    const page = Math.max(Number(args.page) > 0 ? Number(args.page) : 1, 1);
    const items = await itemSearch(cookie, keyword, page);
    return { keyword, page, count: items.length, items, note: "experimental endpoint without an official contract; results may be incomplete" };
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
  try { frame = JSON.parse(text); } catch { return; }
  if (!frame || typeof frame !== "object" || frame.id === undefined || frame.id === null) return;
  if (frame.method === "initialize") { answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.xianyu" }); return; }
  if (frame.method === "shutdown") { answer(frame.id, { ok: true }); process.exit(0); }
  if (frame.method !== "tools/call") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } })}\n`); return; }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) { answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false }); return; }
  Promise.resolve(tool(params.arguments ?? {})).then(result, failure).then((value) => answer(frame.id, value));
});
