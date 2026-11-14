// The health tools a bot may call, and their schemas. Schemas stay flat (no oneOf/anyOf/const) and every
// refusal names a literal example, so a model that guesses wrong can correct itself from the message.
import type { HealthStore } from "./store.ts";
import type { HealthBucket } from "../../shared/health.ts";
import { HEALTH_BUCKETS, HEALTH_METRICS, isCanonicalHealthMetric } from "../../shared/health.ts";

export interface HealthTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TEXT = (max: number, description: string) => ({ type: "string", maxLength: max, description });
const DATE = (description: string) => ({ type: "string", description: `${description} (ISO 8601, e.g. 2026-11-01T00:00:00Z)` });

const METRIC_HINT = `one of: ${HEALTH_METRICS.slice(0, 12).join(", ")}, ... or your own a-z0-9_ name`;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): HealthTool {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

export const HEALTH_TOOLS: readonly HealthTool[] = [
  tool("HEALTH_LOG", `Record one health reading. metric is ${METRIC_HINT}. Use the unit the person used; it is normalised.`,
    {
      metric: TEXT(40, `The measurement's name. ${METRIC_HINT}`),
      value: { type: "number", description: "The number, e.g. 7.5 for seven and a half hours of sleep." },
      at: DATE("When it was measured. Omit for now."),
      endedAt: DATE("For a span (a night's sleep, a workout), when it ended."),
      unit: TEXT(20, "Unit, e.g. kg, h, bpm. Omit to use the metric's own."),
      note: TEXT(500, "A short note in the person's own words."),
    }, ["metric", "value"]),
  tool("HEALTH_QUERY", "List raw health readings in a time range, newest last. Use this to answer 'what did I log yesterday'.",
    {
      metric: TEXT(40, `Only this measurement. ${METRIC_HINT}`),
      from: DATE("Start of the range."),
      to: DATE("End of the range."),
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Rows to return. Default 100." },
    }),
  tool("HEALTH_SUMMARY", "Per-measurement totals, averages, minimum, maximum and latest reading over the last N days.",
    {
      days: { type: "integer", minimum: 1, maximum: 365, description: "How far back. Default 7." },
      metric: TEXT(40, "Only this measurement. Omit for every measurement that has data."),
    }),
  tool("HEALTH_TREND", "Whether a measurement is rising, falling or flat, comparing the recent half of a window with the half before it.",
    {
      metric: TEXT(40, `The measurement. ${METRIC_HINT}`),
      days: { type: "integer", minimum: 2, maximum: 365, description: "Window length. Default 14." },
    }, ["metric"]),
  tool("HEALTH_SERIES", "A chartable series for one measurement: buckets of time with a value each. Feed it to a chart widget.",
    {
      metric: TEXT(40, `The measurement. ${METRIC_HINT}`),
      bucket: { type: "string", enum: [...HEALTH_BUCKETS], description: "Bucket size. Default day." },
      days: { type: "integer", minimum: 1, maximum: 730, description: "How far back. Default 30." },
    }, ["metric"]),
  tool("HEALTH_SOURCES", "Which sources health data comes from, when each last synced, and how many readings each holds.", {}),
  tool("HEALTH_DELETE", "Delete health readings: by id, or every reading from one source. Say what will go before calling this.",
    {
      sampleIds: { type: "array", items: { type: "string" }, maxItems: 200, description: "Reading ids from HEALTH_QUERY." },
      sourceId: TEXT(120, "Delete every reading from this source instead."),
    }),
];

export type HealthToolName = (typeof HEALTH_TOOLS)[number]["name"];

const byName = new Map(HEALTH_TOOLS.map((entry) => [entry.name, entry]));

export function isHealthToolName(name: unknown): name is HealthToolName {
  return typeof name === "string" && byName.has(name);
}

export function healthTool(name: HealthToolName): HealthTool {
  return byName.get(name)!;
}

export interface HealthToolContext {
  store: HealthStore;
  now?: () => string;
  /** Called with the sample ids a call is about to remove, so the host can refuse or confirm. */
  confirmDelete?(sampleIds: readonly string[]): Promise<boolean>;
}

export interface HealthToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const ok = (value: unknown): HealthToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (code: string, message: string): HealthToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
  isError: true,
});

function metricProblem(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(value)) {
    return `metric must be lowercase letters, digits and _, 2-40 characters: e.g. "sleep_hours"`;
  }
  return null;
}

function rangeFrom(args: Record<string, unknown>, defaultDays: number): { from: string; to: string } {
  const now = Date.now();
  const to = typeof args.to === "string" ? new Date(args.to) : new Date(now);
  const from = typeof args.from === "string"
    ? new Date(args.from)
    : new Date((Number.isFinite(to.getTime()) ? to.getTime() : now) - defaultDays * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Runs one health tool. Every argument is checked here, before anything reaches the store. */
export async function runHealthTool(context: HealthToolContext, name: string, args: Record<string, unknown>): Promise<HealthToolResult> {
  const now = context.now ?? (() => new Date().toISOString());
  if (!isHealthToolName(name)) return fail("unknown_tool", `no health tool named "${String(name).slice(0, 60)}"`);
  const problem = metricProblem(args.metric);
  if (problem) return fail("invalid_metric", problem);

  try {
    switch (name) {
      case "HEALTH_LOG": {
        if (typeof args.metric !== "string") return fail("invalid_metric", `metric is required: e.g. "weight_kg"`);
        if (typeof args.value !== "number" || !Number.isFinite(args.value)) return fail("invalid_value", "value must be a number: e.g. 72.4");
        const at = typeof args.at === "string" ? new Date(args.at) : new Date(now());
        if (Number.isNaN(at.getTime())) return fail("invalid_time", `at is not a time: e.g. "2026-11-14T08:00:00Z"`);
        const endedAt = typeof args.endedAt === "string" ? new Date(args.endedAt) : null;
        if (endedAt && Number.isNaN(endedAt.getTime())) return fail("invalid_time", `endedAt is not a time: e.g. "2026-11-14T08:00:00Z"`);
        const { added, samples } = context.store.write([{
          metric: args.metric,
          value: args.value,
          unit: typeof args.unit === "string" && args.unit.trim() ? args.unit.trim().slice(0, 20) : "",
          at: at.toISOString(),
          ...(endedAt ? { endedAt: endedAt.toISOString() } : {}),
          sourceId: "manual",
          quality: "measured",
          ...(typeof args.note === "string" && args.note.trim() ? { note: args.note.trim().slice(0, 500) } : {}),
        }]);
        return ok({ added, sample: samples[0] });
      }
      case "HEALTH_QUERY": {
        const range = rangeFrom(args, 30);
        const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 500) : 100;
        const rows = context.store.query({
          ...(typeof args.metric === "string" ? { metrics: [args.metric] } : {}),
          from: range.from,
          to: range.to,
          limit,
        });
        return ok({ count: rows.length, range, records: rows });
      }
      case "HEALTH_SUMMARY": {
        const days = typeof args.days === "number" ? Math.min(Math.max(Math.trunc(args.days), 1), 365) : 7;
        const range = rangeFrom(args, days);
        const summaries = context.store.summaries({
          ...(typeof args.metric === "string" ? { metrics: [args.metric] } : {}),
          from: range.from,
          to: range.to,
        });
        return ok({ days, range, metrics: summaries });
      }
      case "HEALTH_TREND": {
        if (typeof args.metric !== "string") return fail("invalid_metric", `metric is required: e.g. "resting_heart_rate"`);
        const days = typeof args.days === "number" ? Math.min(Math.max(Math.trunc(args.days), 2), 365) : 14;
        const range = rangeFrom(args, days);
        return ok(context.store.trend(args.metric, { from: range.from, to: range.to }));
      }
      case "HEALTH_SERIES": {
        if (typeof args.metric !== "string") return fail("invalid_metric", `metric is required: e.g. "steps"`);
        const bucket = HEALTH_BUCKETS.includes(args.bucket as HealthBucket) ? (args.bucket as HealthBucket) : "day";
        const days = typeof args.days === "number" ? Math.min(Math.max(Math.trunc(args.days), 1), 730) : 30;
        const range = rangeFrom(args, days);
        return ok(context.store.series(args.metric, { from: range.from, to: range.to }, bucket));
      }
      case "HEALTH_SOURCES":
        return ok({ sources: context.store.sources() });
      case "HEALTH_DELETE": {
        const sampleIds = Array.isArray(args.sampleIds) ? args.sampleIds.filter((id): id is string => typeof id === "string").slice(0, 200) : [];
        const sourceId = typeof args.sourceId === "string" && args.sourceId.trim() ? args.sourceId.trim() : undefined;
        if (!sampleIds.length && !sourceId) return fail("not_found", `give sampleIds (from HEALTH_QUERY) or a sourceId (from HEALTH_SOURCES)`);
        if (context.confirmDelete) {
          const ids = sampleIds.length ? sampleIds : context.store.query({ sources: [sourceId!], limit: 200 }).map((row) => row.sampleId);
          if (!(await context.confirmDelete(ids))) return fail("not_found", "the person did not confirm this deletion");
        }
        const removed = context.store.remove(sampleIds.length ? { sampleIds } : { sourceId: sourceId! });
        return ok({ removed });
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code ?? "store_failure";
    return fail(code, error instanceof Error ? error.message : String(error));
  }
  return fail("unknown_tool", `no health tool named "${String(name).slice(0, 60)}"`);
}

/** What the bot is told about the domain, once per turn, before any tool call. */
export const HEALTH_INSTRUCTIONS = [
  "Health readings are the person's own private data. Use them to answer what they asked and nothing more.",
  "Record what they tell you; never invent a reading, and never present a trend as a diagnosis.",
  "When you report a change, say the window it covers and how many readings it is based on.",
  "If a measurement has too few readings to compare, say so instead of calling it a trend.",
].join(" ");

export { isCanonicalHealthMetric };
