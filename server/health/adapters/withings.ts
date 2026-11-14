// Withings: the measure groups are read per category, and every reading arrives as a (type, unit, value) triple that
// this file translates. Facts from Withings' published API (wbsapi.withings.net, v2):
// - `getmeas` returns `measuregrps[].measures[]` with `type`, `unit` (a power of ten) and `value`.
// - `getactivity` returns per-day summaries; `steps`, `distance`, `calories`, `soft`/`moderate`/`intense` are metres,
//   kilometres, kcal and seconds respectively.
// - The token goes in the Authorization header as `Bearer`; the API answers `{status, body}` with status 0 meaning ok.
import type { HealthCloudAdapter, HealthSyncResult, HealthSyncWindow } from "./types.ts";
import { HealthCloudError } from "./types.ts";

export interface WithingsConfig {
  sourceId: string;
  accessToken: string;
  label?: string;
  /** Overridden for a test double; the production host is the default. */
  baseUrl?: string;
}

const DEFAULT_BASE = "https://wbsapi.withings.net";
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Withings' measurement types. The list is the subset that maps onto a metric this domain stores; anything else is
 * counted as skipped rather than guessed at.
 */
const MEASURE_TYPES: Readonly<Record<number, { metric: string; scale: number }>> = {
  1: { metric: "weight_kg", scale: 1 },          // kg
  6: { metric: "body_fat_pct", scale: 1 },       // %
  5: { metric: "muscle_mass_kg", scale: 1 },     // kg
  88: { metric: "muscle_mass_kg", scale: 1 },    // kg, newer devices
  11: { metric: "heart_rate", scale: 1 },        // bpm, measured by a scale
  9: { metric: "blood_pressure_diastolic", scale: 1 },
  10: { metric: "blood_pressure_systolic", scale: 1 },
  12: { metric: "body_temperature", scale: 1 },  // °C
  54: { metric: "spo2", scale: 1 },              // %
  76: { metric: "muscle_mass_kg", scale: 1 },
  77: { metric: "water_ml", scale: 1 },          // kg of body water, reported as ml below
  91: { metric: "heart_rate", scale: 1 },        // pulse wave velocity source, kept as heart rate
};

interface WithingsResponse {
  status: number;
  error?: string;
  body?: Record<string, unknown>;
}

function decodeMeasure(measure: { value?: unknown; unit?: unknown; type?: unknown }): { metric: string; value: number } | null {
  const type = Number(measure.type);
  const mapped = Object.hasOwn(MEASURE_TYPES, type) ? MEASURE_TYPES[type]! : null;
  if (!mapped) return null;
  const raw = Number(measure.value);
  const unit = Number(measure.unit);
  if (!Number.isFinite(raw) || !Number.isFinite(unit)) return null;
  const value = raw * 10 ** unit;
  if (!Number.isFinite(value)) return null;
  // Body water comes back as kilograms; the domain stores millilitres, and a litre of body water is a kilogram.
  if (type === 77) return { metric: mapped.metric, value: value * 1_000 };
  return { metric: mapped.metric, value };
}

export function withingsAdapter(config: WithingsConfig): HealthCloudAdapter {
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const label = config.label?.trim() || "Withings";

  async function call(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${config.accessToken}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError") throw new HealthCloudError("timeout", "Withings did not answer within 20 s");
      throw new HealthCloudError("unavailable", "Withings is unreachable");
    }
    if (response.status === 401 || response.status === 403) throw new HealthCloudError("unauthorized", "Withings rejected this sign-in; connect it again");
    if (response.status === 429) throw new HealthCloudError("rate_limited", "Withings is rate-limiting this account; try again later");
    if (!response.ok) throw new HealthCloudError("unavailable", `Withings answered ${response.status}`);
    let parsed: WithingsResponse;
    try {
      parsed = await response.json() as WithingsResponse;
    } catch {
      throw new HealthCloudError("bad_response", "Withings did not send JSON");
    }
    if (parsed.status === 401) throw new HealthCloudError("unauthorized", "Withings rejected this sign-in; connect it again");
    if (parsed.status === 601) throw new HealthCloudError("rate_limited", "Withings is rate-limiting this account; try again later");
    if (parsed.status !== 0) {
      throw new HealthCloudError("bad_response", `Withings refused the request (${parsed.status})`, parsed.error);
    }
    return parsed.body ?? {};
  }

  return {
    adapterId: `withings:${config.sourceId}`,
    label,
    sourceId: config.sourceId,

    async fetch(window: HealthSyncWindow, cursor: string | undefined): Promise<HealthSyncResult> {
      const from = cursor ? Math.max(Math.floor(Date.parse(cursor) / 1000), Math.floor(Date.parse(window.from) / 1000)) : Math.floor(Date.parse(window.from) / 1000);
      const to = Math.floor(Date.parse(window.to) / 1000);
      const samples: HealthSyncResult["samples"] = [];
      const problems: HealthSyncResult["problems"] = [];
      let skipped = 0;
      let row = 0;

      const measured = await call("/measure", {
        action: "getmeas",
        startdate: String(from),
        enddate: String(to),
        // 1 = realtime measurements, so a manual weigh-in is not folded into a daily average.
        category: "1",
      });
      const groups = Array.isArray(measured.measuregrps) ? measured.measuregrps : [];
      for (const group of groups) {
        if (!group || typeof group !== "object") continue;
        const record = group as Record<string, unknown>;
        const at = Number(record.date);
        if (!Number.isFinite(at)) {
          problems.push({ row: ++row, reason: "a measurement group carried no date" });
          continue;
        }
        const measures = Array.isArray(record.measures) ? record.measures : [];
        for (const measure of measures) {
          row += 1;
          if (!measure || typeof measure !== "object") {
            problems.push({ row, reason: "a measurement was not an object" });
            continue;
          }
          const decoded = decodeMeasure(measure as Record<string, unknown>);
          if (!decoded) {
            skipped += 1;
            continue;
          }
          samples.push({
            metric: decoded.metric,
            value: Math.round(decoded.value * 100) / 100,
            unit: "",
            at: new Date(at * 1000).toISOString(),
            sourceId: config.sourceId,
            quality: "measured",
          });
        }
      }

      // Activity is per day and the API wants both bounds inclusive, so the last day is read again on the next sync.
      const activity = await call("/v2/measure", {
        action: "getactivity",
        startdateymd: new Date(from * 1000).toISOString().slice(0, 10),
        enddateymd: new Date(to * 1000).toISOString().slice(0, 10),
      });
      const days = Array.isArray(activity.activities) ? activity.activities : [];
      for (const entry of days) {
        if (!entry || typeof entry !== "object") continue;
        const day = entry as Record<string, unknown>;
        const date = typeof day.date === "string" ? day.date : "";
        const at = Date.parse(`${date}T00:00:00Z`);
        if (!Number.isFinite(at)) {
          problems.push({ row: ++row, reason: `an activity day had no usable date: ${String(date).slice(0, 20)}` });
          continue;
        }
        const push = (metric: string, value: unknown, divisor = 1) => {
          const number = Number(value);
          if (!Number.isFinite(number)) return;
          row += 1;
          samples.push({
            metric,
            value: Math.round((number / divisor) * 100) / 100,
            unit: "",
            at: new Date(at).toISOString(),
            endedAt: new Date(at + 86_399_000).toISOString(),
            sourceId: config.sourceId,
            quality: "derived",
          });
        };
        push("steps", day.steps);
        push("distance_m", day.distance);
        push("total_calories", day.totalcalories);
        push("active_calories", day.calories);
        const activeSeconds = Number(day.soft) + Number(day.moderate) + Number(day.intense);
        if (Number.isFinite(activeSeconds) && activeSeconds > 0) push("workout_minutes", activeSeconds, 60);
      }

      return { samples, skipped, problems, cursor: new Date(to * 1000).toISOString() };
    },
  };
}
