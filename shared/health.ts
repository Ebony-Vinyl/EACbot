import { z } from "zod";

/**
 * The health data domain's wire contract. Every producer (a file import, a cloud
 * adapter, a paired phone) and every consumer (the /health view, a bot tool, a
 * routine) speaks only this, so a new source is a new adapter and nothing else.
 *
 * A sample is one observation of one metric. `at` is when the body was measured,
 * never when the row was written: a watch that syncs at noon still reports the
 * 03:00 sleep. Interval samples (a night's sleep, a workout) carry `endedAt`.
 */

/** Canonical metrics the UI groups and charts; any other `a-z0-9_` name is stored as-is. */
export const HEALTH_METRICS = [
  "steps",
  "distance_m",
  "active_calories",
  "total_calories",
  "heart_rate",
  "resting_heart_rate",
  "hrv_ms",
  "spo2",
  "respiratory_rate",
  "body_temperature",
  "weight_kg",
  "body_fat_pct",
  "muscle_mass_kg",
  "sleep_hours",
  "sleep_deep_hours",
  "sleep_rem_hours",
  "sleep_light_hours",
  "sleep_awake_hours",
  "sleep_score",
  "readiness_score",
  "stress",
  "blood_pressure_systolic",
  "blood_pressure_diastolic",
  "blood_glucose",
  "water_ml",
  "caffeine_mg",
  "alcohol_units",
  "mood",
  "workout_minutes",
  "workout_calories",
  "vo2max",
] as const;
export type CanonicalHealthMetric = (typeof HEALTH_METRICS)[number];

export const HEALTH_METRIC_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/** What a metric is measured in, so two sources agree before anything is compared. */
export const HEALTH_METRIC_UNITS: Readonly<Record<CanonicalHealthMetric, string>> = {
  steps: "count",
  distance_m: "m",
  active_calories: "kcal",
  total_calories: "kcal",
  heart_rate: "bpm",
  resting_heart_rate: "bpm",
  hrv_ms: "ms",
  spo2: "%",
  respiratory_rate: "brpm",
  body_temperature: "c",
  weight_kg: "kg",
  body_fat_pct: "%",
  muscle_mass_kg: "kg",
  sleep_hours: "h",
  sleep_deep_hours: "h",
  sleep_rem_hours: "h",
  sleep_light_hours: "h",
  sleep_awake_hours: "h",
  sleep_score: "score",
  readiness_score: "score",
  stress: "score",
  blood_pressure_systolic: "mmHg",
  blood_pressure_diastolic: "mmHg",
  blood_glucose: "mmol_l",
  water_ml: "ml",
  caffeine_mg: "mg",
  alcohol_units: "unit",
  mood: "score",
  workout_minutes: "min",
  workout_calories: "kcal",
  vo2max: "ml_kg_min",
};

/** Metrics a day is summed over rather than averaged: two step counts a day add up, two heart rates do not. */
export const HEALTH_SUM_METRICS: ReadonlySet<string> = new Set([
  "steps", "distance_m", "active_calories", "total_calories", "water_ml", "caffeine_mg",
  "alcohol_units", "workout_minutes", "workout_calories", "sleep_hours", "sleep_deep_hours",
  "sleep_rem_hours", "sleep_light_hours", "sleep_awake_hours",
]);

const instant = z.string().datetime({ offset: true });

/** How a sample came to exist. `derived` is computed by a source (a sleep score); `measured` is a sensor reading. */
export const HEALTH_QUALITIES = ["measured", "derived"] as const;
export type HealthQuality = (typeof HEALTH_QUALITIES)[number];

export const healthSampleSchema = z.object({
  sampleId: z.string().uuid(),
  metric: z.string().regex(HEALTH_METRIC_PATTERN),
  value: z.number().finite(),
  unit: z.string().trim().min(1).max(20),
  at: instant,
  endedAt: instant.optional(),
  /** The adapter or file that produced this row: `file:apple-health`, `cloud:withings`, `manual`. */
  sourceId: z.string().trim().min(1).max(120),
  quality: z.enum(HEALTH_QUALITIES),
  deviceId: z.string().uuid().optional(),
  note: z.string().trim().max(500).optional(),
  /** Bumped when a later import replaces this row at the same (source, metric, at, endedAt). */
  revision: z.number().int().nonnegative(),
}).strict();
export type HealthSample = z.infer<typeof healthSampleSchema>;

/** A sample as it arrives from an importer or adapter, before the store assigns identity. */
export const healthSampleInputSchema = healthSampleSchema
  .omit({ sampleId: true, revision: true })
  .extend({ sampleId: z.string().uuid().optional() });
export type HealthSampleInput = z.infer<typeof healthSampleInputSchema>;

export const HEALTH_SOURCE_KINDS = ["manual", "file", "cloud", "device"] as const;
export type HealthSourceKind = (typeof HEALTH_SOURCE_KINDS)[number];

export const HEALTH_SOURCE_STATUSES = ["connected", "expired", "revoked", "unavailable"] as const;
export type HealthSourceStatus = (typeof HEALTH_SOURCE_STATUSES)[number];

/** A place samples come from. `credentialRef` is an opaque secret-store key, never a token. */
export const healthSourceSchema = z.object({
  sourceId: z.string().trim().min(1).max(120),
  kind: z.enum(HEALTH_SOURCE_KINDS),
  label: z.string().trim().min(1).max(120),
  status: z.enum(HEALTH_SOURCE_STATUSES),
  credentialRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,119}$/).nullable(),
  /** ISO instant of the last successful sync, absent until one happens. */
  lastSyncAt: instant.optional(),
  sampleCount: z.number().int().nonnegative(),
  createdAt: instant,
  updatedAt: instant,
}).strict();
export type HealthSource = z.infer<typeof healthSourceSchema>;

export const healthRangeSchema = z.object({
  from: instant,
  to: instant,
}).strict();
export type HealthRange = z.infer<typeof healthRangeSchema>;

export const healthQuerySchema = z.object({
  metrics: z.array(z.string().regex(HEALTH_METRIC_PATTERN)).min(1).max(32).optional(),
  sources: z.array(z.string().trim().min(1).max(120)).min(1).max(32).optional(),
  from: instant.optional(),
  to: instant.optional(),
  limit: z.number().int().min(1).max(5_000).optional(),
}).strict();
export type HealthQuery = z.infer<typeof healthQuerySchema>;

export const HEALTH_BUCKETS = ["hour", "day", "week", "month"] as const;
export type HealthBucket = (typeof HEALTH_BUCKETS)[number];

/** One bucket of a series: `sum` for count-like metrics, `avg` otherwise, `n` the samples behind it. */
export const healthPointSchema = z.object({
  bucket: instant,
  value: z.number().finite(),
  n: z.number().int().nonnegative(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
}).strict();
export type HealthPoint = z.infer<typeof healthPointSchema>;

export const healthSeriesSchema = z.object({
  metric: z.string().regex(HEALTH_METRIC_PATTERN),
  unit: z.string(),
  bucket: z.enum(HEALTH_BUCKETS),
  aggregation: z.enum(["sum", "avg"]),
  points: z.array(healthPointSchema).max(2_000),
}).strict();
export type HealthSeries = z.infer<typeof healthSeriesSchema>;

/** A trend compares the recent half of the window with the half before it. */
export const HEALTH_DIRECTIONS = ["up", "down", "flat", "unknown"] as const;
export type HealthDirection = (typeof HEALTH_DIRECTIONS)[number];

export const healthTrendSchema = z.object({
  metric: z.string().regex(HEALTH_METRIC_PATTERN),
  unit: z.string(),
  direction: z.enum(HEALTH_DIRECTIONS),
  /** Why a direction is `unknown`: no samples, or only one. */
  reason: z.enum(["no_samples", "single_sample"]).optional(),
  change: z.number().finite().optional(),
  changePct: z.number().finite().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  latest: healthSampleSchema.nullable(),
  count: z.number().int().nonnegative(),
}).strict();
export type HealthTrend = z.infer<typeof healthTrendSchema>;

export const healthMetricSummarySchema = z.object({
  metric: z.string().regex(HEALTH_METRIC_PATTERN),
  unit: z.string(),
  count: z.number().int().nonnegative(),
  total: z.number().finite(),
  avg: z.number().finite(),
  min: z.number().finite(),
  max: z.number().finite(),
  latest: healthSampleSchema.nullable(),
  trend: z.enum(HEALTH_DIRECTIONS),
}).strict();
export type HealthMetricSummary = z.infer<typeof healthMetricSummarySchema>;

/** The /health view's one request: a range, the metrics present in it, and their series. */
export const healthOverviewSchema = z.object({
  range: healthRangeSchema,
  summaries: z.array(healthMetricSummarySchema).max(64),
  series: z.array(healthSeriesSchema).max(32),
  sources: z.array(healthSourceSchema).max(64),
  sampleCount: z.number().int().nonnegative(),
}).strict();
export type HealthOverview = z.infer<typeof healthOverviewSchema>;

export const HEALTH_IMPORT_FORMATS = ["csv", "json", "apple-health"] as const;
export type HealthImportFormat = (typeof HEALTH_IMPORT_FORMATS)[number];

/** What an import did, per row, so a file that is half bad reports both halves. */
export const healthImportReportSchema = z.object({
  format: z.enum(HEALTH_IMPORT_FORMATS),
  sourceId: z.string().trim().min(1).max(120),
  read: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  replaced: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** The first few refusals, each naming the row and the reason. */
  problems: z.array(z.object({
    row: z.number().int().nonnegative(),
    reason: z.string().max(300),
  }).strict()).max(20),
}).strict();
export type HealthImportReport = z.infer<typeof healthImportReportSchema>;

export const healthErrorCodeSchema = z.enum([
  "invalid_metric",
  "invalid_value",
  "invalid_time",
  "unknown_source",
  "source_unavailable",
  "not_found",
  "too_many_rows",
  "unreadable_file",
  "unsupported_format",
  "store_failure",
]);
export type HealthErrorCode = z.infer<typeof healthErrorCodeSchema>;

export const healthErrorSchema = z.object({
  code: healthErrorCodeSchema,
  message: z.string().max(2_000),
}).strict();
export type HealthError = z.infer<typeof healthErrorSchema>;

export function healthUnitOf(metric: string): string {
  return (HEALTH_METRIC_UNITS as Record<string, string>)[metric] ?? "unit";
}

export function healthAggregationOf(metric: string): "sum" | "avg" {
  return HEALTH_SUM_METRICS.has(metric) ? "sum" : "avg";
}

/** Whether a metric is one the domain knows how to label, chart and aggregate on purpose. */
export function isCanonicalHealthMetric(metric: string): metric is CanonicalHealthMetric {
  return Object.hasOwn(HEALTH_METRIC_UNITS, metric);
}
