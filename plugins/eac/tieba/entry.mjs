// eac.tieba — Tieba reading (HTML pages: there is no open read API) and reply drafts for EACbot.
// Posting needs the account cookie and the thread's tbs; any verification or risk-control page stops the tool and is
// reported as-is — nothing here retries around a check.
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult, shutdown -> exit.
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DRAFTS = join(process.cwd(), "tieba-drafts.json");
const DEFAULT_BASE = "https://tieba.baidu.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

class ToolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function apiBase() {
  const file = join(process.cwd(), "config.json");
  if (!existsSync(file)) return DEFAULT_BASE;
  try {
    return String(JSON.parse(readFileSync(file, "utf8")).apiBase ?? DEFAULT_BASE).replace(/\/+$/, "");
  } catch {
    return DEFAULT_BASE;
  }
}

async function fetchPage(url) {
  let response;
  try {
    response = await fetch(`${apiBase()}${url}`, {
      headers: { "user-agent": UA, referer: "https://tieba.baidu.com/" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.name;
    throw new ToolError("unreachable", `Tieba is unreachable (${String(cause).slice(0, 60)})`, true);
  }
  if (response.status !== 200) throw new ToolError("bad-response", `Tieba returned HTTP ${response.status}`, response.status >= 500);
  return response.text();
}

// The forum page's thread list is rendered server-side; the J_thread_list items carry title, author and reply count.
function parseThreads(html) {
  const threads = [];
  const itemPattern = /<li[^>]*class="j_thread_list[^"]*"[\s\S]*?<\/li>/g;
  for (const item of html.match(itemPattern) ?? []) {
    const title = /class="j_th_tit[^"]*"[^>]*>(?:[\s\S]*?<span[^>]*>)?([\s\S]*?)<\/(?:span|a)>/.exec(item)?.[1]
      ?? /title="([^"]+)"/.exec(item)?.[1];
    const href = /href="\/p\/(\d+)[^"]*"/.exec(item)?.[1];
    const author = /class="frs-author-name[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(item)?.[1]
      ?? /username="([^"]*)"/.exec(item)?.[1];
    const replies = /class="thread_rep_num[^"]*"[^>]*>(\d+)</.exec(item)?.[1];
    if (!title || !href) continue;
    threads.push({
      threadId: href,
      title: stripTags(title).slice(0, 200),
      author: author ? stripTags(author).slice(0, 60) : null,
      replies: replies ? Number(replies) : null,
      url: `https://tieba.baidu.com/p/${href}`,
    });
    if (threads.length >= 30) break;
  }
  return threads;
}

function parsePosts(html) {
  const posts = [];
  const pattern = /<div[^>]*class="d_post_content j_d_post_content[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  const authors = [...html.matchAll(/<ul[^>]*class="p_author"[^>]*>[\s\S]*?(?:username="([^"]*)"|class="p_author_name[^"]*"[^>]*>([\s\S]*?)<\/a>)/g)].map((match) => match[1] ?? match[2] ?? null);
  let index = 0;
  for (const match of html.matchAll(pattern)) {
    posts.push({ floor: ++index, author: authors[index - 1] ? stripTags(authors[index - 1]).slice(0, 60) : null, text: stripTags(match[1]).slice(0, 600) });
    if (posts.length >= 20) break;
  }
  return posts;
}

function loadDrafts() {
  if (!existsSync(DRAFTS)) return { schemaVersion: 1, drafts: [] };
  const parsed = JSON.parse(readFileSync(DRAFTS, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.drafts)) throw new ToolError("store-corrupt", "tieba-drafts.json does not match schema version 1", false);
  return parsed;
}

function saveDrafts(state) {
  mkdirSync(dirname(DRAFTS), { recursive: true, mode: 0o700 });
  const tmp = `${DRAFTS}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, DRAFTS);
}

function loginConfig() {
  const file = join(process.cwd(), "config.json");
  if (!existsSync(file)) throw new ToolError("no-login", "config.json is missing: add { \"cookie\": \"<logged-in tieba cookie>\", \"tbs\": \"<tbs from the web page>\" } to this plugin's work directory", false);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const cookie = String(parsed.cookie ?? "").trim();
  if (!cookie) throw new ToolError("no-login", "config.json needs the logged-in tieba cookie", false);
  const tbs = String(parsed.tbs ?? "").trim();
  if (!tbs) throw new ToolError("no-login", "config.json needs tbs (shown in the web page's source when signed in)", false);
  return { cookie, tbs };
}

const TOOLS = {
  "tieba-forum-threads": async (args) => {
    const forum = String(args.forum ?? "").trim();
    if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(forum)) throw new ToolError("invalid-forum", "forum name (吧名) is required", false);
    const tab = args.tab === "good" ? "good" : "";
    const html = await fetchPage(`/f?kw=${encodeURIComponent(forum)}${tab ? `&tab=${tab}` : ""}`);
    const threads = parseThreads(html);
    if (!threads.length) {
      throw new ToolError("parse-failed", "the forum page did not show any threads; Tieba's markup may have changed or the page asked for verification — nothing was guessed", true);
    }
    return { forum, tab: tab || "default", count: threads.length, threads, note: "parsed from the HTML page; this is not an official API and may stop working" };
  },

  "tieba-thread-detail": async (args) => {
    const threadId = String(args.threadId ?? "").trim();
    if (!/^\d{6,20}$/.test(threadId)) throw new ToolError("invalid-thread", "threadId must be the numeric id of a /p/ link", false);
    const html = await fetchPage(`/p/${threadId}`);
    const posts = parsePosts(html);
    if (!posts.length) throw new ToolError("parse-failed", "no posts were parsed from the thread page; the markup may have changed or verification appeared", true);
    const title = /<title>([\s\S]*?)_贴吧/.exec(html)?.[1]?.trim() ?? null;
    return { threadId, title: title ? decodeEntities(title) : null, posts, note: "first 20 floors only; later floors were not read" };
  },

  "tieba-reply-draft": async (args) => {
    const action = String(args.action ?? "save").trim();
    const threadId = String(args.threadId ?? "").trim();
    if (!/^\d{6,20}$/.test(threadId)) throw new ToolError("invalid-thread", "threadId must be the numeric id of a /p/ link", false);
    const state = loadDrafts();
    if (action === "list") {
      return { threadId, drafts: state.drafts.filter((draft) => draft.threadId === threadId) };
    }
    if (action === "delete") {
      const kept = state.drafts.filter((draft) => !(draft.threadId === threadId && draft.id === String(args.id ?? "").trim()));
      if (kept.length === state.drafts.length) throw new ToolError("not-found", "no such draft for this thread", false);
      state.drafts = kept;
      saveDrafts(state);
      return { deleted: String(args.id) };
    }
    const text = String(args.text ?? "").trim();
    if (!text) throw new ToolError("invalid-text", "text is required to save a draft", false);
    if (text.length > 500) throw new ToolError("invalid-text", "a draft is limited to 500 characters", false);
    if (state.drafts.length >= 200) throw new ToolError("store-full", "at most 200 drafts are kept; delete one first", false);
    const draft = { id: `d_${Date.now().toString(36)}`, threadId, text, savedAt: new Date().toISOString() };
    state.drafts.push(draft);
    saveDrafts(state);
    return { saved: draft.id, threadId };
  },

  "tieba-reply-post": async (args) => {
    const { cookie, tbs } = loginConfig();
    const threadId = String(args.threadId ?? "").trim();
    const text = String(args.text ?? "").trim();
    if (!/^\d{6,20}$/.test(threadId)) throw new ToolError("invalid-thread", "threadId must be the numeric id of a /p/ link", false);
    if (!text || text.length > 500) throw new ToolError("invalid-text", "text is required and limited to 500 characters", false);
    let response;
    try {
      response = await fetch(`${apiBase()}/mo/q/m/reply`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, cookie, referer: `https://tieba.baidu.com/p/${threadId}` },
        body: new URLSearchParams({ content: text, tbs, kw: String(args.forum ?? ""), fid: String(args.forumId ?? ""), tid: threadId, is_ad: "0" }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const cause = error?.cause?.code ?? error?.name;
      throw new ToolError("unreachable", `Tieba is unreachable (${String(cause).slice(0, 60)})`, true);
    }
    const payload = await response.json().catch(() => null);
    const code = payload?.no ?? payload?.error_code ?? null;
    if (code === null || Number(code) !== 0) {
      // Any verification, risk-control or login prompt stops here and is reported verbatim.
      throw new ToolError("not-posted", `Tieba did not accept the reply (${JSON.stringify(payload ?? response.status).slice(0, 300)}); check for a verification prompt — do not retry blindly`, false);
    }
    return { posted: true, threadId };
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
  if (frame.method === "initialize") { answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.tieba" }); return; }
  if (frame.method === "shutdown") { answer(frame.id, { ok: true }); process.exit(0); }
  if (frame.method !== "tools/call") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } })}\n`); return; }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) { answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false }); return; }
  Promise.resolve(tool(params.arguments ?? {})).then(result, failure).then((value) => answer(frame.id, value));
});
