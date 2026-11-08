// eac.health — local health records for EACbot. All data stays in this plugin's work directory.
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult, shutdown -> exit.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const WORKDIR = process.cwd();
const STORE = join(WORKDIR, "health-records.json");
const MAX_RECORDS = 20_000;

class ToolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const METRIC_PATTERN = /^[a-z0-9_]{2,40}$/;
const KNOWN_UNITS = { steps: "count", weight_kg: "kg", sleep_hours: "h", heart_rate: "bpm", water_ml: "ml", mood: "level" };

function loadRecords() {
  if (!existsSync(STORE)) return [];
  const parsed = JSON.parse(readFileSync(STORE, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) {
    throw new ToolError("store-corrupt", "health-records.json does not match schema version 1", false);
  }
  return parsed.records;
}

function saveRecords(records) {
  mkdirSync(dirname(STORE), { recursive: true, mode: 0o700 });
  const tmp = `${STORE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, records }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STORE);
}

function dayStart(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) throw new ToolError("invalid-at", `not a valid time: ${String(at).slice(0, 60)}`, false);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function parseAt(at) {
  if (at === undefined) return new Date().toISOString();
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) throw new ToolError("invalid-at", `not a valid time: ${String(at).slice(0, 60)}`, false);
  return time.toISOString();
}

function select(records, { metric, since, until }) {
  const from = since ? dayStart(since) : -Infinity;
  const to = until ? dayStart(until) + 86_400_000 : Infinity;
  return records
    .filter((record) => (!metric || record.metric === metric) && Date.parse(record.at) >= from && Date.parse(record.at) < to)
    .sort((a, b) => a.at.localeCompare(b.at));
}

function summarize(records, metric) {
  const values = records.map((record) => record.value).filter((value) => typeof value === "number");
  if (!values.length) return null;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    metric,
    count: values.length,
    avg: Math.round(avg * 100) / 100,
    latest: records[records.length - 1] ?? null,
  };
}

const TOOLS = {
  "health-record-add": async (args) => {
    const metric = String(args.metric ?? "").trim();
    if (!METRIC_PATTERN.test(metric)) throw new ToolError("invalid-metric", "metric must be 2-40 chars of a-z0-9_ (e.g. steps, weight_kg, sleep_hours)", false);
    const value = Number(args.value);
    if (!Number.isFinite(value)) throw new ToolError("invalid-value", "value must be a finite number", false);
    const records = loadRecords();
    if (records.length >= MAX_RECORDS) throw new ToolError("store-full", "the health store is full; delete old records first", false);
    const record = {
      id: randomUUID(),
      metric,
      value,
      unit: typeof args.unit === "string" && args.unit.trim() ? args.unit.trim().slice(0, 20) : KNOWN_UNITS[metric] ?? "unit",
      at: parseAt(args.at),
      ...(typeof args.note === "string" && args.note.trim() ? { note: args.note.trim().slice(0, 500) } : {}),
    };
    records.push(record);
    saveRecords(records);
    return { added: record.id, metric: record.metric, value: record.value, at: record.at };
  },

  "health-records": async (args) => {
    const records = select(loadRecords(), {
      metric: typeof args.metric === "string" && args.metric.trim() ? args.metric.trim() : undefined,
      since: args.since, until: args.until,
    });
    const limit = Math.min(Number(args.limit) > 0 ? Number(args.limit) : 100, 500);
    const chosen = records.slice(-limit);
    return { count: records.length, returned: chosen.length, records: chosen };
  },

  "health-summary": async (args) => {
    const days = Math.min(Math.max(Number(args.days) > 0 ? Number(args.days) : 7, 1), 365);
    const from = dayStart(new Date(Date.now() - (days - 1) * 86_400_000).toISOString());
    const records = loadRecords().filter((record) => Date.parse(record.at) >= from);
    const byMetric = new Map();
    for (const record of records) {
      if (!byMetric.has(record.metric)) byMetric.set(record.metric, []);
      byMetric.get(record.metric).push(record);
    }
    const summary = [...byMetric.entries()].map(([metric, rows]) => summarize(rows, metric)).filter(Boolean);
    return { days, metrics: summary };
  },

  "health-trend": async (args) => {
    const metric = String(args.metric ?? "").trim();
    if (!METRIC_PATTERN.test(metric)) throw new ToolError("invalid-metric", "metric must be 2-40 chars of a-z0-9_", false);
    const days = Math.min(Math.max(Number(args.days) > 0 ? Number(args.days) : 14, 2), 365);
    const from = dayStart(new Date(Date.now() - (days - 1) * 86_400_000).toISOString());
    const rows = select(loadRecords(), { metric, since: new Date(from).toISOString() });
    if (rows.length < 2) {
      return { metric, days, direction: "unknown", reason: rows.length === 0 ? "no records" : "only one record", count: rows.length };
    }
    const values = rows.map((row) => row.value);
    const half = Math.floor(values.length / 2);
    const avg = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
    const earlier = avg(values.slice(0, half));
    const recent = avg(values.slice(half));
    const change = recent - earlier;
    const direction = Math.abs(change) < Math.max(0.01, Math.abs(earlier) * 0.02) ? "flat" : change > 0 ? "up" : "down";
    return {
      metric, days, direction,
      change: Math.round(change * 100) / 100,
      min: Math.min(...values), max: Math.max(...values),
      latest: rows[rows.length - 1] ?? null,
      count: rows.length,
    };
  },

  "health-record-delete": async (args) => {
    const id = String(args.id ?? "").trim();
    if (!id) throw new ToolError("invalid-id", "id is required", false);
    const records = loadRecords();
    const kept = records.filter((record) => record.id !== id);
    if (kept.length === records.length) throw new ToolError("not-found", `no health record ${id.slice(0, 60)}`, false);
    saveRecords(kept);
    return { removed: id };
  },
};

function result(value) {
  return { status: "succeeded", value };
}

function failure(error) {
  if (error instanceof ToolError) return { status: "failed", code: error.code, message: error.message.slice(0, 2000), retryable: error.retryable };
  return { status: "failed", code: "internal", message: String(error instanceof Error ? error.message : error).slice(0, 2000), retryable: false };
}

function answer(id, result_) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: result_ })}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (text) => {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  if (!frame || typeof frame !== "object" || frame.id === undefined || frame.id === null) return;
  if (frame.method === "initialize") { answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.health" }); return; }
  if (frame.method === "shutdown") { answer(frame.id, { ok: true }); process.exit(0); }
  if (frame.method !== "tools/call") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } })}\n`); return; }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) { answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false }); return; }
  Promise.resolve(tool(params.arguments ?? {})).then(result, failure).then((value) => answer(frame.id, value));
});
