// The health view's arithmetic and wording, kept out of the component so it can be tested without a DOM.
// Nothing here fetches; it turns a server overview into the rows and chart data the view draws.
import { intlLocale, t, tFromServer } from "@/lib/i18n";
import type { HealthBucket, HealthMetricSummary, HealthOverview, HealthPoint, HealthSeries, HealthTrend } from "../../shared/health";

/** The groups the view shows, in order. A metric outside them lands in `other`. */
export const HEALTH_GROUPS = ["activity", "sleep", "heart", "body", "lifestyle"] as const;
export type HealthGroup = (typeof HEALTH_GROUPS)[number];

const GROUP_OF: Readonly<Record<string, HealthGroup>> = {
  steps: "activity",
  distance_m: "activity",
  active_calories: "activity",
  total_calories: "activity",
  workout_minutes: "activity",
  workout_calories: "activity",
  vo2max: "activity",
  sleep_hours: "sleep",
  sleep_deep_hours: "sleep",
  sleep_rem_hours: "sleep",
  sleep_light_hours: "sleep",
  sleep_awake_hours: "sleep",
  sleep_score: "sleep",
  readiness_score: "sleep",
  heart_rate: "heart",
  resting_heart_rate: "heart",
  hrv_ms: "heart",
  spo2: "heart",
  respiratory_rate: "heart",
  blood_pressure_systolic: "heart",
  blood_pressure_diastolic: "heart",
  weight_kg: "body",
  body_fat_pct: "body",
  muscle_mass_kg: "body",
  body_temperature: "body",
  blood_glucose: "body",
  water_ml: "lifestyle",
  caffeine_mg: "lifestyle",
  alcohol_units: "lifestyle",
  mood: "lifestyle",
  stress: "lifestyle",
};

export function healthGroupOf(metric: string): HealthGroup {
  return GROUP_OF[metric] ?? "lifestyle";
}

/** A metric's name in the person's language, falling back to its identifier so an unknown one still shows. */
export function metricLabel(metric: string): string {
  const key = `health.metric.${metric}`;
  // An unknown metric is still a metric: tFromServer answers the fallback when the key is not in the catalog.
  return tFromServer(key, metric.replace(/_/g, " "));
}

/** The number as a person reads it: no trailing zeros, and a unit that sits close. */
export function metricValue(value: number, unit: string): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  const text = new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1 }).format(rounded);
  return unit === "%" ? `${text}%` : unit ? `${text} ${unit}` : text;
}

/** The direction as an arrow and a word, with the change it stands for. */
export function trendLabel(trend: Pick<HealthTrend, "direction" | "change" | "changePct" | "reason">, unit: string): string {
  if (trend.direction === "unknown") {
    return trend.reason === "single_sample" ? t("health.trend.oneReading") : t("health.trend.noReadings");
  }
  if (trend.direction === "flat") return t("health.trend.flat");
  if (trend.change === undefined) return trend.direction === "up" ? t("health.trend.upPlain") : t("health.trend.downPlain");
  const amount = metricValue(Math.abs(trend.change), unit);
  const pct = trend.changePct === undefined ? "" : ` (${Math.abs(Math.round(trend.changePct))}%)`;
  return trend.direction === "up" ? t("health.trend.up", { amount, pct }) : t("health.trend.down", { amount, pct });
}

export function trendArrow(direction: HealthTrend["direction"]): "up" | "down" | "flat" | "none" {
  return direction === "unknown" ? "none" : direction;
}

/** The window the view shows, as the two ISO instants the server takes. */
export function healthWindow(days: number, now = new Date()): { from: string; to: string } {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

/** A summary as the tile the view draws: a headline value, its unit, and the trend behind it. */
export interface HealthTile {
  metric: string;
  label: string;
  group: HealthGroup;
  value: string;
  raw: number;
  unit: string;
  trend: HealthTrend["direction"];
  trendText: string;
  count: number;
  min: string;
  max: string;
}

export function tilesFor(overview: Pick<HealthOverview, "summaries">): HealthTile[] {
  return overview.summaries.map((summary: HealthMetricSummary) => ({
    metric: summary.metric,
    label: metricLabel(summary.metric),
    group: healthGroupOf(summary.metric),
    value: metricValue(summary.avg, summary.unit),
    raw: summary.avg,
    unit: summary.unit,
    trend: summary.trend,
    trendText: trendLabel({ direction: summary.trend, change: undefined, changePct: undefined, reason: undefined }, summary.unit),
    count: summary.count,
    min: metricValue(summary.min, summary.unit),
    max: metricValue(summary.max, summary.unit),
  }));
}

/** Tiles grouped the way the view shows them, with empty groups left out. */
export function groupedTiles(tiles: readonly HealthTile[]): Array<{ group: HealthGroup; tiles: HealthTile[] }> {
  return HEALTH_GROUPS
    .map((group) => ({ group, tiles: tiles.filter((tile) => tile.group === group) }))
    .filter((entry) => entry.tiles.length > 0);
}

/** One series as a Vega-Lite line spec, so the view draws with the same chart code as the Data panel. */
export function seriesSpec(series: HealthSeries, options: { title: string; color: string }): Record<string, unknown> {
  const rows = series.points.map((point: HealthPoint) => ({ when: point.bucket, value: point.value }));
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { values: rows },
    mark: { type: "line", strokeWidth: 2, interpolate: "monotone" },
    encoding: {
      x: { field: "when", type: "temporal", axis: { title: null, grid: false, format: bucketFormat(series.bucket) } },
      y: { field: "value", type: "quantitative", title: series.unit, axis: { title: series.unit, grid: true } },
      color: { value: options.color },
      tooltip: [
        { field: "when", type: "temporal", title: options.title },
        { field: "value", type: "quantitative", title: series.unit },
      ],
    },
    height: 160,
    autosize: { type: "fit", contains: "padding" },
  };
}

function bucketFormat(bucket: HealthBucket): string {
  if (bucket === "hour") return "%H:%M";
  if (bucket === "month") return "%b %Y";
  return "%b %d";
}

/** Which bucket a window is worth reading at: a week of readings by hour is noise, a year by hour is unusable. */
export function bucketFor(days: number): HealthBucket {
  if (days <= 2) return "hour";
  if (days <= 90) return "day";
  if (days <= 400) return "week";
  return "month";
}

/** A reading as one line in the record list. */
export function recordLine(sample: { metric: string; value: number; unit: string; at: string }, locale = intlLocale()): string {
  const when = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(sample.at));
  return `${when} · ${metricLabel(sample.metric)} ${metricValue(sample.value, sample.unit)}`;
}

/** How a source reads: its label, and whether it is currently delivering. */
export function sourceLine(source: { label: string; status: string; sampleCount: number; lastSyncAt?: string }): string {
  const count = t("health.source.count", { n: source.sampleCount });
  if (source.status === "expired") return t("health.source.expired", { label: source.label, count });
  if (source.status === "unavailable") return t("health.source.unavailable", { label: source.label, count });
  if (source.status === "revoked") return t("health.source.revoked", { label: source.label, count });
  return source.lastSyncAt
    ? t("health.source.synced", { label: source.label, count, when: new Intl.DateTimeFormat(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(source.lastSyncAt)) })
    : t("health.source.local", { label: source.label, count });
}
