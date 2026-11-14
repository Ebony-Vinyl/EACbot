// The health HTTP surface. Every path is owner-only: health is one person's data, so there is no member-safe read.
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { HealthStoreError, type HealthStore } from "../health/store.ts";
import { detectFormat, importerFor, HEALTH_IMPORTERS } from "../health/importers/index.ts";
import { HEALTH_BUCKETS, HEALTH_IMPORT_FORMATS, HEALTH_METRIC_PATTERN, type HealthBucket, type HealthImportFormat } from "../../shared/health.ts";

export interface HealthRouteDeps {
  store: HealthStore;
  mayManage(auth: RequestAuth): boolean;
  now?: () => string;
}

/** An Apple Health export is routinely hundreds of megabytes; a hand-kept CSV is kilobytes. */
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

const STATUS: Readonly<Record<HealthStoreError["code"], number>> = {
  invalid_metric: 400,
  invalid_value: 400,
  invalid_time: 400,
  unknown_source: 404,
  too_many_rows: 413,
  store_failure: 500,
};

const isFormat = (value: unknown): value is HealthImportFormat =>
  typeof value === "string" && (HEALTH_IMPORT_FORMATS as readonly string[]).includes(value);

const isBucket = (value: unknown): value is HealthBucket =>
  typeof value === "string" && (HEALTH_BUCKETS as readonly string[]).includes(value);

/** `days` and an explicit `from`/`to` are the two ways a caller names a window; the explicit pair wins. */
function windowFrom(url: URL): { from: string; to: string } {
  const to = url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : new Date();
  const fromParam = url.searchParams.get("from");
  const days = Number(url.searchParams.get("days"));
  const from = fromParam
    ? new Date(fromParam)
    : new Date((Number.isFinite(to.getTime()) ? to.getTime() : Date.now()) - (Number.isFinite(days) && days > 0 ? days : 30) * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Health readings, imports and the overview the /health view draws. */
export function createHealthRoutes(deps: HealthRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== "/api/health/records" && !path.startsWith("/api/health/")) return PASS;
    // The cloud sign-in surface is its own handler; declining here is what lets it answer.
    if (path.startsWith("/api/health/cloud")) return PASS;
    if (path === "/api/health" || path.startsWith("/api/health/")) {
      // /api/health is the liveness probe; it is not ours.
      if (path === "/api/health") return PASS;
    }
    if (!deps.mayManage(auth)) return json(res, 403, { error: "Only an owner or administrator can read or change health data." });
    res.setHeader("Cache-Control", "no-store");

    const fail = (error: unknown) => {
      if (error instanceof HealthStoreError) return json(res, STATUS[error.code], { error: { code: error.code, message: error.message } });
      return json(res, 500, { error: { code: "store_failure", message: error instanceof Error ? error.message : String(error) } });
    };

    try {
      if (method === "GET" && path === "/api/health/overview") {
        const range = windowFrom(url);
        const metrics = url.searchParams.get("metrics")?.split(",").filter(Boolean);
        const bucketParam = url.searchParams.get("bucket");
        const bucket = isBucket(bucketParam) ? bucketParam : "day";
        return json(res, 200, deps.store.overview(range, metrics?.length ? metrics : undefined, bucket));
      }

      if (method === "GET" && path === "/api/health/records") {
        const range = windowFrom(url);
        const metrics = url.searchParams.get("metrics")?.split(",").filter(Boolean);
        const sources = url.searchParams.get("sources")?.split(",").filter(Boolean);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 5_000);
        const records = deps.store.query({
          ...(metrics?.length ? { metrics } : {}),
          ...(sources?.length ? { sources } : {}),
          from: range.from,
          to: range.to,
          limit,
        });
        return json(res, 200, { range, count: records.length, records });
      }

      if (method === "GET" && path === "/api/health/series") {
        const metric = url.searchParams.get("metric") ?? "";
        const bucketParam = url.searchParams.get("bucket");
        return json(res, 200, deps.store.series(metric, { ...windowFrom(url) }, isBucket(bucketParam) ? bucketParam : "day"));
      }

      if (method === "GET" && path === "/api/health/trend") {
        const metric = url.searchParams.get("metric") ?? "";
        return json(res, 200, deps.store.trend(metric, windowFrom(url)));
      }

      if (method === "GET" && path === "/api/health/sources") {
        return json(res, 200, { sources: deps.store.sources(), formats: HEALTH_IMPORTERS.map((importer) => importer.format) });
      }

      if (method === "POST" && path === "/api/health/records") {
        const body = await readBody(req, 8_192);
        const metric = typeof body?.metric === "string" ? body.metric.trim() : "";
        if (!HEALTH_METRIC_PATTERN.test(metric)) {
          return json(res, 400, { error: { code: "invalid_metric", message: `metric must be 2-40 chars of a-z0-9_: e.g. "weight_kg"` } });
        }
        const value = Number(body?.value);
        if (!Number.isFinite(value)) return json(res, 400, { error: { code: "invalid_value", message: `value must be a number: e.g. 72.4` } });
        const at = typeof body?.at === "string" ? new Date(body.at) : new Date(deps.now?.() ?? Date.now());
        if (Number.isNaN(at.getTime())) return json(res, 400, { error: { code: "invalid_time", message: `at is not a time: e.g. "2026-11-14T08:00:00Z"` } });
        const endedAt = typeof body?.endedAt === "string" ? new Date(body.endedAt) : null;
        if (endedAt && Number.isNaN(endedAt.getTime())) return json(res, 400, { error: { code: "invalid_time", message: `endedAt is not a time` } });
        const written = deps.store.write([{
          metric,
          value,
          unit: typeof body?.unit === "string" && body.unit.trim() ? body.unit.trim().slice(0, 20) : "",
          at: at.toISOString(),
          ...(endedAt ? { endedAt: endedAt.toISOString() } : {}),
          sourceId: "manual",
          quality: "measured",
          ...(typeof body?.note === "string" && body.note.trim() ? { note: body.note.trim().slice(0, 500) } : {}),
        }]);
        return json(res, 200, { added: written.added, replaced: written.replaced, sample: written.samples[0] });
      }

      if (method === "POST" && path === "/api/health/import") {
        const body = await readBody(req, 64 * 1024);
        const sourceId = typeof body?.sourceId === "string" && body.sourceId.trim() ? body.sourceId.trim().slice(0, 120) : null;
        const requested = isFormat(body?.format) ? body.format : null;
        let text: string;
        let label = sourceId;
        if (typeof body?.path === "string" && body.path.trim()) {
          if (!isAbsolute(body.path)) return json(res, 400, { error: { code: "unreadable_file", message: "path must be absolute" } });
          const stats = statSync(body.path);
          if (!stats.isFile()) return json(res, 400, { error: { code: "unreadable_file", message: "path is not a file" } });
          if (stats.size > MAX_IMPORT_BYTES) {
            return json(res, 413, { error: { code: "too_many_rows", message: `the file is ${Math.round(stats.size / 1_048_576)} MB; the limit is ${MAX_IMPORT_BYTES / 1_048_576} MB` } });
          }
          text = readFileSync(body.path, "utf8");
          label = label ?? `file:${body.path.split(/[\\/]/).pop()?.slice(0, 100) ?? "import"}`;
        } else if (typeof body?.text === "string" && body.text.trim()) {
          text = body.text;
          label = label ?? "file:pasted";
        } else {
          return json(res, 400, { error: { code: "unreadable_file", message: `give a path to the export, or its text: {"path": "/Users/me/export.xml"}` } });
        }
        const format = requested ?? detectFormat(text);
        if (!format) {
          return json(res, 400, { error: { code: "unsupported_format", message: `could not tell the format; name it: ${HEALTH_IMPORT_FORMATS.join(", ")}` } });
        }
        const importer = importerFor(format);
        if (!importer) return json(res, 400, { error: { code: "unsupported_format", message: `this build cannot read ${format}` } });
        const parsed = importer.parse(text, { sourceId: label!, now: deps.now ?? (() => new Date().toISOString()) });
        const written = parsed.samples.length ? deps.store.write(parsed.samples) : { added: 0, replaced: 0 };
        return json(res, 200, {
          format,
          sourceId: label,
          read: parsed.read,
          added: written.added,
          replaced: written.replaced,
          skipped: parsed.problems.length,
          problems: parsed.problems,
        });
      }

      if (method === "DELETE" && path === "/api/health/records") {
        const body = await readBody(req, 32_768);
        const sampleIds = Array.isArray(body?.sampleIds) ? body.sampleIds.filter((id: unknown): id is string => typeof id === "string") : [];
        const sourceId = typeof body?.sourceId === "string" && body.sourceId.trim() ? body.sourceId.trim() : undefined;
        if (!sampleIds.length && !sourceId) {
          return json(res, 400, { error: { code: "not_found", message: `give sampleIds, or a sourceId to remove every reading from that source` } });
        }
        return json(res, 200, { removed: deps.store.remove(sampleIds.length ? { sampleIds } : { sourceId: sourceId! }) });
      }

      return json(res, 404, { error: { code: "not_found", message: "no such health endpoint" } });
    } catch (error) {
      return fail(error);
    }
  };
}
