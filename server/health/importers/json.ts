// `{ "samples": [ { metric, value, at, unit?, endedAt?, note?, quality? } ] }`, or a bare array of the same.
// This is also what an adapter writes when it pulls from a cloud API, so one shape covers both.
import { healthUnitOf, HEALTH_QUALITIES, type HealthQuality } from "../../../shared/health.ts";
import type { HealthImporter, ImportResult, ImportProblem } from "./types.ts";

function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const samples = (value as { samples?: unknown }).samples;
    if (Array.isArray(samples)) return samples;
  }
  return null;
}

export const jsonImporter: HealthImporter = {
  format: "json",

  detects(text) {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
    try {
      return asArray(JSON.parse(text)) !== null;
    } catch {
      return false;
    }
  },

  parse(text, options): ImportResult {
    const problems: ImportProblem[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { samples: [], problems: [{ row: 0, reason: "the file is not valid JSON" }], read: 0 };
    }
    const rows = asArray(parsed);
    if (!rows) return { samples: [], problems: [{ row: 0, reason: "expected an array, or an object with a samples array" }], read: 0 };
    const samples: ImportResult["samples"] = [];
    for (const [offset, row] of rows.entries()) {
      const rowNumber = offset + 1;
      if (!row || typeof row !== "object") {
        problems.push({ row: rowNumber, reason: "not an object" });
        continue;
      }
      const record = row as Record<string, unknown>;
      const metric = typeof record.metric === "string" ? record.metric.trim() : "";
      if (!metric) {
        problems.push({ row: rowNumber, reason: "metric is empty" });
        continue;
      }
      const value = typeof record.value === "number" ? record.value : Number(record.value);
      if (!Number.isFinite(value)) {
        problems.push({ row: rowNumber, reason: "value is not a number" });
        continue;
      }
      const at = typeof record.at === "string" ? new Date(record.at) : null;
      if (!at || Number.isNaN(at.getTime())) {
        problems.push({ row: rowNumber, reason: "at is not a time" });
        continue;
      }
      const endedAt = typeof record.endedAt === "string" ? new Date(record.endedAt) : null;
      if (endedAt && Number.isNaN(endedAt.getTime())) {
        problems.push({ row: rowNumber, reason: "endedAt is not a time" });
        continue;
      }
      const quality = HEALTH_QUALITIES.includes(record.quality as HealthQuality) ? (record.quality as HealthQuality) : "measured";
      const unit = typeof record.unit === "string" && record.unit.trim() ? record.unit.trim().slice(0, 20) : healthUnitOf(metric);
      const note = typeof record.note === "string" && record.note.trim() ? record.note.trim().slice(0, 500) : undefined;
      samples.push({
        metric, value, unit, at: at.toISOString(),
        ...(endedAt ? { endedAt: endedAt.toISOString() } : {}),
        sourceId: options.sourceId,
        quality,
        ...(note ? { note } : {}),
      });
    }
    return { samples, problems: problems.slice(0, 20), read: rows.length };
  },
};
