// eac.bilibili — Bilibili reading (and optional, grant-gated writes) for EACbot.
// Reads use Bilibili's public web endpoints. Writes need the account cookie in config.json; the upstream endpoints
// are undocumented and may refuse without notice: a refusal is reported, never faked.
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult, shutdown -> exit.
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_API = "https://api.bilibili.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

class ToolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function loadConfig() {
  const file = join(process.cwd(), "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    throw new ToolError("bad-config", "config.json is not valid JSON", false);
  }
}

function cookieHeader() {
  const cookie = String(loadConfig().cookie ?? "").trim();
  if (!cookie) {
    throw new ToolError("no-login", "this tool needs the account cookie: put SESSDATA and bili_jct into config.json's cookie field, then restart the plugin", false);
  }
  return cookie;
}

function csrfToken(cookie) {
  const match = /(?:^|;\s*)bili_jct=([^;]+)/.exec(cookie);
  if (!match) throw new ToolError("no-login", "the cookie is missing bili_jct (the csrf token); copy the full cookie from a signed-in browser", false);
  return match[1];
}

function apiBase() {
  return String(loadConfig().apiBase ?? DEFAULT_API).replace(/\/+$/, "");
}

async function biliApi(path, { method = "GET", body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { "user-agent": UA, referer: "https://www.bilibili.com/", ...headers },
      ...(body === undefined ? {} : { body: new URLSearchParams(body).toString() }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.name;
    if (cause === "TimeoutError") throw new ToolError("timeout", "Bilibili did not answer within 15 s", true);
    throw new ToolError("unreachable", `Bilibili is unreachable (${String(cause).slice(0, 60)})`, true);
  }
  if (response.status === 412) throw new ToolError("risk-control", "Bilibili refused this request (412): the endpoint is rate-limiting or asking for verification. Wait, or read fewer items", true);
  if (response.status >= 500) throw new ToolError("server", `Bilibili server error (${response.status})`, true);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ToolError("bad-response", "Bilibili returned a non-JSON answer", true);
  }
  if (payload && typeof payload.code === "number" && payload.code !== 0) {
    const retryable = payload.code === -509 || payload.code === -412 || payload.code === 429;
    throw new ToolError("api-error", `Bilibili API ${payload.code}: ${String(payload.message ?? "").slice(0, 200)}`, retryable);
  }
  return payload.data ?? payload;
}

function videoCard(card) {
  if (!card) return null;
  return {
    bvid: card.bvid ?? null,
    title: typeof card.title === "string" ? card.title.replace(/<[^>]+>/g, "") : card.title,
    author: card.author ?? card.owner?.name ?? null,
    play: card.play ?? card.stat?.view ?? null,
    danmaku: card.video_review ?? card.stat?.danmaku ?? null,
    favorites: card.favorites ?? card.stat?.favorite ?? null,
    duration: card.duration ?? null,
    pubdate: card.pubdate ?? null,
    description: typeof card.description === "string" ? card.description.slice(0, 300) : undefined,
    url: card.bvid ? `https://www.bilibili.com/video/${card.bvid}` : null,
  };
}

const TOOLS = {
  "bili-search-videos": async (args) => {
    const keyword = String(args.keyword ?? "").trim();
    if (!keyword) throw new ToolError("invalid-keyword", "keyword is required", false);
    const page = Math.max(Number(args.page) > 0 ? Number(args.page) : 1, 1);
    const data = await biliApi(`/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${page}&page_size=20`);
    const results = (data?.result ?? []).map(videoCard).filter(Boolean);
    return { keyword, page, count: results.length, numResults: data?.numResults ?? results.length, videos: results };
  },

  "bili-video-info": async (args) => {
    const bvid = String(args.bvid ?? "").trim();
    if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) throw new ToolError("invalid-bvid", "bvid must look like BV1xx411c7mD", false);
    const data = await biliApi(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    return {
      bvid: data.bvid, title: data.title, desc: data.desc, owner: data.owner?.name ?? null,
      duration_seconds: data.duration, pages: (data.pages ?? []).map((page) => ({ page: page.page, part: page.part, duration_seconds: page.duration })),
      stat: data.stat ? { view: data.stat.view, danmaku: data.stat.danmaku, reply: data.stat.reply, favorite: data.stat.favorite, coin: data.stat.coin, like: data.stat.like } : null,
      url: `https://www.bilibili.com/video/${data.bvid}`,
    };
  },

  "bili-popular": async (args) => {
    const page = Math.max(Number(args.page) > 0 ? Number(args.page) : 1, 1);
    const data = await biliApi(`/x/web-interface/popular?ps=20&pn=${page}`);
    return { page, count: (data?.list ?? []).length, videos: (data?.list ?? []).map(videoCard).filter(Boolean) };
  },

  "bili-like": async (args) => {
    const bvid = String(args.bvid ?? "").trim();
    if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) throw new ToolError("invalid-bvid", "bvid must look like BV1xx411c7mD", false);
    const cookie = cookieHeader();
    const data = await biliApi("/x/web-interface/archive/like", {
      method: "POST",
      headers: { cookie },
      body: { bvid, like: args.cancel === true ? "2" : "1", csrf: csrfToken(cookie) },
    });
    // The endpoint answers {toast} without a verdict field: report what it said, not an assumed success.
    return { bvid, like: args.cancel === true ? "cancelled" : "liked", toast: data?.toast ?? null };
  },

  "bili-post-comment": async (args) => {
    const bvid = String(args.bvid ?? "").trim();
    const text = String(args.text ?? "").trim();
    if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) throw new ToolError("invalid-bvid", "bvid must look like BV1xx411c7mD", false);
    if (!text) throw new ToolError("invalid-text", "text is required", false);
    if (text.length > 1000) throw new ToolError("invalid-text", "comment text is limited to 1000 characters", false);
    const cookie = cookieHeader();
    const view = await biliApi(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    const data = await biliApi("/x/v2/reply/add", {
      method: "POST",
      headers: { cookie },
      body: { oid: view.aid, type: "1", message: text, csrf: csrfToken(cookie), plat: "1", web_location: "1315875" },
    });
    return { bvid, posted: true, rpid: data?.rpid ?? null };
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
  if (frame.method === "initialize") { answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.bilibili" }); return; }
  if (frame.method === "shutdown") { answer(frame.id, { ok: true }); process.exit(0); }
  if (frame.method !== "tools/call") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } })}\n`); return; }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) { answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false }); return; }
  Promise.resolve(tool(params.arguments ?? {})).then(result, failure).then((value) => answer(frame.id, value));
});
