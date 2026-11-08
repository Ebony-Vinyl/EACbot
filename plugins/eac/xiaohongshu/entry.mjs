// eac.xiaohongshu — the local content desk for Xiaohongshu: ideas, materials, note drafts and a publish plan.
// It prepares content; it does not publish. Platform publishing needs an authorized channel that does not exist yet,
// and the plan tool says so in its answer.
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult, shutdown -> exit.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STORE = join(process.cwd(), "xhs-desk.json");
const CAPS = { ideas: 300, materials: 500, notes: 200, plans: 200 };

class ToolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function loadDesk() {
  if (!existsSync(STORE)) return { schemaVersion: 1, ideas: [], materials: [], notes: [], plans: [] };
  const parsed = JSON.parse(readFileSync(STORE, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1) throw new ToolError("store-corrupt", "xhs-desk.json does not match schema version 1", false);
  return { ideas: [], materials: [], notes: [], plans: [], ...parsed };
}

function saveDesk(state) {
  mkdirSync(dirname(STORE), { recursive: true, mode: 0o700 });
  const tmp = `${STORE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STORE);
}

const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const tagsOf = (args) => (Array.isArray(args.tags) ? args.tags.map((tag) => String(tag).replace(/^#/, "").slice(0, 30)).filter(Boolean).slice(0, 15) : []);

function simpleListTool(name, cap) {
  return async (args) => {
    const action = String(args.action ?? "list").trim();
    const state = loadDesk();
    const rows = state[name];
    if (!Array.isArray(rows)) throw new ToolError("invalid-args", `unknown collection ${name}`, false);
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
    if (action !== "add" && action !== "save" && action !== "update" && action !== "done") throw new ToolError("invalid-action", `action must be add|list|delete${name === "notes" ? "|update" : ""}${name === "plans" ? "|done" : ""}`, false);
    if (rows.length >= cap) throw new ToolError("store-full", `${name} holds at most ${cap}`, false);
    const now = new Date().toISOString();
    if (action === "add" || action === "save") {
      const row = { id: randomUUID(), createdAt: now };
      if (name === "ideas") {
        const title = text(args.title, 200);
        if (!title) throw new ToolError("invalid-args", "title is required", false);
        Object.assign(row, { title, angle: text(args.angle, 500), status: "open" });
      } else if (name === "materials") {
        const title = text(args.title, 200);
        const body = text(args.body, 5000);
        if (!title || !body) throw new ToolError("invalid-args", "title and body are required", false);
        Object.assign(row, { title, body, tags: tagsOf(args) });
      } else if (name === "notes") {
        const title = text(args.title, 200);
        const body = text(args.body, 20_000);
        if (!title || !body) throw new ToolError("invalid-args", "title and body are required", false);
        Object.assign(row, { title, body, tags: tagsOf(args), status: "draft" });
      } else {
        const noteId = String(args.noteId ?? "").trim();
        const plannedFor = text(args.plannedFor, 40);
        if (!noteId || !plannedFor) throw new ToolError("invalid-args", "noteId and plannedFor are required", false);
        if (!state.notes.some((note) => note.id === noteId)) throw new ToolError("not-found", `no note ${noteId.slice(0, 60)}`, false);
        Object.assign(row, { noteId, plannedFor, note: text(args.note, 500), status: "planned" });
      }
      rows.push(row);
      saveDesk(state);
      return { added: row.id, item: row };
    }
    const id = String(args.id ?? "").trim();
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new ToolError("not-found", `no ${name.replace(/s$/, "")} ${id.slice(0, 60)}`, false);
    if (action === "done") row.status = "done";
    else if (name === "notes") {
      if (text(args.title, 200)) row.title = text(args.title, 200);
      if (text(args.body, 20_000)) row.body = text(args.body, 20_000);
      if (tagsOf(args).length) row.tags = tagsOf(args);
      const status = text(args.status, 20);
      if (status && ["draft", "ready", "published", "dropped"].includes(status)) row.status = status;
    }
    row.updatedAt = now;
    saveDesk(state);
    return { updated: id, item: row };
  };
}

const TOOLS = {
  "xhs-idea": simpleListTool("ideas", CAPS.ideas),
  "xhs-material": simpleListTool("materials", CAPS.materials),
  "xhs-note": simpleListTool("notes", CAPS.notes),
  "xhs-plan": simpleListTool("plans", CAPS.plans),
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
  if (frame.method === "initialize") { answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.xiaohongshu" }); return; }
  if (frame.method === "shutdown") { answer(frame.id, { ok: true }); process.exit(0); }
  if (frame.method !== "tools/call") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } })}\n`); return; }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) { answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false }); return; }
  Promise.resolve(tool(params.arguments ?? {})).then(result, failure).then((value) => answer(frame.id, value));
});
