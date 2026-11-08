// eac.douyin — the local content desk for Douyin: ideas, materials, drafts and a publish plan.
// It prepares content; it does not publish. Platform publishing needs an authorized channel that does not exist yet,
// and the plan tool says so in its answer.
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult, shutdown -> exit.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  if (frame.method === "initialize") { answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.douyin" }); return; }
  if (frame.method === "shutdown") { answer(frame.id, { ok: true }); process.exit(0); }
  if (frame.method !== "tools/call") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } })}\n`); return; }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) { answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false }); return; }
  Promise.resolve(tool(params.arguments ?? {})).then(result, failure).then((value) => answer(frame.id, value));
});
