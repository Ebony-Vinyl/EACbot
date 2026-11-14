// Oura: daily summaries plus sleep periods. Facts from Oura's published v2 API (api.ouraring.com/v2):
// - Every daily endpoint takes `start_date`/`end_date` as `YYYY-MM-DD`, so a sync is read per day.
// - `daily_sleep` carries `score` and `contributors`; `daily_readiness` carries `score`.
// - `sleep` periods carry `total_sleep_duration`, `deep_sleep_duration`, `rem_sleep_duration`,
//   `light_sleep_duration` and `awake_time` in seconds, plus `day` as the date the night ended.
// - `daily_activity` carries `steps`, `active_calories`, `total_calories`, `equivalent_walking_distance` (metres).
// - `daily_cardiovascular_age` and `daily_spo2` differ between accounts; a missing one is skipped, never invented.
import type { HealthCloudAdapter, HealthSyncResult, HealthSyncWindow } from "./types.ts";
import { HealthCloudError } from "./types.ts";

export interface OuraConfig {
  sourceId: string;
  accessToken: string;
  label?: string;
  baseUrl?: string;
}

const DEFAULT_BASE = "https://api.ouraring.com";
const REQUEST_TIMEOUT_MS = 20_000;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const round = (value: number) => Math.round(value * 100) / 100;
const hours = (seconds: unknown): number | null => {
  const number = Number(seconds);
  return Number.isFinite(number) && number >= 0 ? round(number / 3600) : null;
};

export function ouraAdapter(config: OuraConfig): HealthCloudAdapter {
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const label = config.label?.trim() || "Oura";

  async function get(path: string, params: Record<string, string>): Promise<unknown> {
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
      if ((error as { name?: string }).name === "TimeoutError") throw new HealthCloudError("timeout", "Oura did not answer within 20 s");
      throw new HealthCloudError("unavailable", "Oura is unreachable");
    }
    if (response.status === 401 || response.status === 403) throw new HealthCloudError("unauthorized", "Oura rejected this sign-in; connect it again");
    if (response.status === 429) throw new HealthCloudError("rate_limited", "Oura is rate-limiting this account; try again later");
    if (response.status === 404) throw new HealthCloudError("not_supported", "this Oura account does not offer that data");
    if (!response.ok) throw new HealthCloudError("unavailable", `Oura answered ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new HealthCloudError("bad_response", "Oura did not send JSON");
    }
  }

  return {
    adapterId: `oura:${config.sourceId}`,
    label,
    sourceId: config.sourceId,

    async fetch(window: HealthSyncWindow, cursor: string | undefined): Promise<HealthSyncResult> {
      const fromDate = (cursor ? new Date(cursor) : new Date(window.from)).toISOString().slice(0, 10);
      const toDate = new Date(window.to).toISOString().slice(0, 10);
      const samples: HealthSyncResult["samples"] = [];
      const problems: HealthSyncResult["problems"] = [];
      let skipped = 0;
      let row = 0;

      const dayAt = (day: unknown): string | null => {
        if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
        const at = Date.parse(`${day}T00:00:00Z`);
        return Number.isFinite(at) ? new Date(at).toISOString() : null;
      };
      const push = (metric: string, value: number | null, at: string, quality: "measured" | "derived") => {
        if (value === null) return;
        row += 1;
        samples.push({ metric, value, unit: "", at, sourceId: config.sourceId, quality });
      };

      const activity = await get("/v2/usercollection/daily_activity", { start_date: fromDate, end_date: toDate });
      for (const entry of isRecord(activity) && Array.isArray(activity.data) ? activity.data : []) {
        if (!isRecord(entry)) continue;
        const at = dayAt(entry.day);
        if (!at) {
          problems.push({ row: ++row, reason: "an activity day had no usable date" });
          continue;
        }
        push("steps", Number.isFinite(Number(entry.steps)) ? Number(entry.steps) : null, at, "measured");
        push("active_calories", Number.isFinite(Number(entry.active_calories)) ? Number(entry.active_calories) : null, at, "measured");
        push("total_calories", Number.isFinite(Number(entry.total_calories)) ? Number(entry.total_calories) : null, at, "measured");
        push("distance_m", Number.isFinite(Number(entry.equivalent_walking_distance)) ? Number(entry.equivalent_walking_distance) : null, at, "derived");
      }

      const sleep = await get("/v2/usercollection/sleep", { start_date: fromDate, end_date: toDate });
      for (const entry of isRecord(sleep) && Array.isArray(sleep.data) ? sleep.data : []) {
        if (!isRecord(entry)) continue;
        const at = dayAt(entry.day);
        if (!at) {
          problems.push({ row: ++row, reason: "a sleep period had no usable day" });
          continue;
        }
        const total = hours(entry.total_sleep_duration);
        const endedAt = new Date(Date.parse(at) + 86_399_000).toISOString();
        if (total !== null) {
          row += 1;
          samples.push({ metric: "sleep_hours", value: total, unit: "", at, endedAt, sourceId: config.sourceId, quality: "measured" });
        }
        push("sleep_deep_hours", hours(entry.deep_sleep_duration), at, "measured");
        push("sleep_rem_hours", hours(entry.rem_sleep_duration), at, "measured");
        push("sleep_light_hours", hours(entry.light_sleep_duration), at, "measured");
        push("sleep_awake_hours", hours(entry.awake_time), at, "measured");
        push("resting_heart_rate", Number.isFinite(Number(entry.lowest_heart_rate)) ? Number(entry.lowest_heart_rate) : null, at, "measured");
        push("hrv_ms", Number.isFinite(Number(entry.average_hrv)) ? Number(entry.average_hrv) : null, at, "measured");
        push("respiratory_rate", Number.isFinite(Number(entry.average_breath)) ? round(Number(entry.average_breath)) : null, at, "measured");
      }

      const dailySleep = await get("/v2/usercollection/daily_sleep", { start_date: fromDate, end_date: toDate });
      for (const entry of isRecord(dailySleep) && Array.isArray(dailySleep.data) ? dailySleep.data : []) {
        if (!isRecord(entry)) continue;
        const at = dayAt(entry.day);
        if (!at) continue;
        push("sleep_score", Number.isFinite(Number(entry.score)) ? Number(entry.score) : null, at, "derived");
      }

      const readiness = await get("/v2/usercollection/daily_readiness", { start_date: fromDate, end_date: toDate });
      for (const entry of isRecord(readiness) && Array.isArray(readiness.data) ? readiness.data : []) {
        if (!isRecord(entry)) continue;
        const at = dayAt(entry.day);
        if (!at) continue;
        push("readiness_score", Number.isFinite(Number(entry.score)) ? Number(entry.score) : null, at, "derived");
        push("body_temperature", Number.isFinite(Number(entry.temperature_deviation)) ? round(Number(entry.temperature_deviation)) : null, at, "derived");
      }

      // SpO2 is a separate collection and some accounts have none; a 404 means the account, not a broken sync.
      try {
        const spo2 = await get("/v2/usercollection/daily_spo2", { start_date: fromDate, end_date: toDate });
        for (const entry of isRecord(spo2) && Array.isArray(spo2.data) ? spo2.data : []) {
          if (!isRecord(entry)) continue;
          const at = dayAt(entry.day);
          if (!at) continue;
          const average = isRecord(entry.spo2_percentage) ? Number(entry.spo2_percentage.average) : Number.NaN;
          push("spo2", Number.isFinite(average) ? round(average) : null, at, "measured");
        }
      } catch (error) {
        if (!(error instanceof HealthCloudError) || error.code !== "not_supported") throw error;
        skipped += 1;
      }

      return { samples, skipped, problems, cursor: `${toDate}T00:00:00.000Z` };
    },
  };
}
