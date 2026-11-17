// Apple Health's export.xml: a `<Record>` element per observation. The file is huge (hundreds of MB) and is not
// well-formed XML in practice (a truncated export, a BOM, unescaped characters), so the elements are scanned
// rather than parsed as a document. No dependency: the export format is a stable, documented one.
import type { HealthImporter, ImportResult, ImportProblem } from "./types.ts";

/** Apple's own type identifiers, mapped to the domain's metric names. Anything else is skipped by name. */
export const APPLE_HEALTH_TYPES: Readonly<Record<string, string>> = {
  HKQuantityTypeIdentifierStepCount: "steps",
  HKQuantityTypeIdentifierDistanceWalkingRunning: "distance_m",
  HKQuantityTypeIdentifierActiveEnergyBurned: "active_calories",
  HKQuantityTypeIdentifierBasalEnergyBurned: "total_calories",
  HKQuantityTypeIdentifierHeartRate: "heart_rate",
  HKQuantityTypeIdentifierRestingHeartRate: "resting_heart_rate",
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: "hrv_ms",
  HKQuantityTypeIdentifierOxygenSaturation: "spo2",
  HKQuantityTypeIdentifierRespiratoryRate: "respiratory_rate",
  HKQuantityTypeIdentifierBodyTemperature: "body_temperature",
  HKQuantityTypeIdentifierBodyMass: "weight_kg",
  HKQuantityTypeIdentifierBodyFatPercentage: "body_fat_pct",
  HKQuantityTypeIdentifierLeanBodyMass: "muscle_mass_kg",
  HKQuantityTypeIdentifierBloodPressureSystolic: "blood_pressure_systolic",
  HKQuantityTypeIdentifierBloodPressureDiastolic: "blood_pressure_diastolic",
  HKQuantityTypeIdentifierBloodGlucose: "blood_glucose",
  HKQuantityTypeIdentifierVO2Max: "vo2max",
  HKQuantityTypeIdentifierDietaryWater: "water_ml",
  HKQuantityTypeIdentifierDietaryCaffeine: "caffeine_mg",
  HKQuantityTypeIdentifierAppleExerciseTime: "workout_minutes",
  HKCategoryTypeIdentifierSleepAnalysis: "sleep_hours",
};

/** Apple's unit strings, converted to the domain's canonical unit for that metric. */
const UNIT_SCALE: Readonly<Record<string, { unit: string; factor: number }>> = {
  count: { unit: "count", factor: 1 },
  km: { unit: "m", factor: 1_000 },
  mi: { unit: "m", factor: 1_609.344 },
  m: { unit: "m", factor: 1 },
  Cal: { unit: "kcal", factor: 1 },
  kcal: { unit: "kcal", factor: 1 },
  "count/min": { unit: "bpm", factor: 1 },
  ms: { unit: "ms", factor: 1 },
  "%": { unit: "%", factor: 1 },
  kg: { unit: "kg", factor: 1 },
  lb: { unit: "kg", factor: 0.45359237 },
  "degC": { unit: "c", factor: 1 },
  "degF": { unit: "c", factor: 1 },
  mmHg: { unit: "mmHg", factor: 1 },
  "mg/dL": { unit: "mmol_l", factor: 0.0555 },
  mL: { unit: "ml", factor: 1 },
  mg: { unit: "mg", factor: 1 },
  min: { unit: "min", factor: 1 },
  hr: { unit: "h", factor: 1 },
};

const ATTRIBUTE = /([\w:]+)="([^"]*)"/g;

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(ATTRIBUTE)) out[match[1]!] = decodeEntities(match[2]!);
  return out;
}

function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (_whole, name: string) => {
    if (name === "amp") return "&";
    if (name === "lt") return "<";
    if (name === "gt") return ">";
    if (name === "quot") return '"';
    if (name === "apos") return "'";
    return String.fromCodePoint(Number(name.slice(1)));
  });
}

/** `2023-01-15 08:30:00 +0800` → ISO. Apple writes local time with its offset, never a zone name. */
export function appleHealthTime(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}):?(\d{2}))?$/.exec(value.trim());
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
  }
  const offset = match[3] ? `${match[3]}:${match[4] ?? "00"}` : "Z";
  const parsed = new Date(`${match[1]}T${match[2]}${offset}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Sleep analysis rows carry a value that names the stage; Apple reports a span, not a duration. */
function sleepStageHours(start: string, end: string): number | null {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return Math.round(((to - from) / 3_600_000) * 100) / 100;
}

export const appleHealthImporter: HealthImporter = {
  format: "apple-health",

  detects(text) {
    return /<HealthData\b/.test(text) || /HKQuantityTypeIdentifierStepCount/.test(text);
  },

  parse(text, options): ImportResult {
    const problems: ImportProblem[] = [];
    const samples: ImportResult["samples"] = [];
    let read = 0;
    let row = 0;
    for (const match of text.matchAll(/<Record\b([^>]*?)\/?>/g)) {
      row += 1;
      const attrs = attributes(match[1]!);
      const type = attrs.type ?? "";
      const metric = APPLE_HEALTH_TYPES[type];
      if (!metric) continue;
      read += 1;
      const start = appleHealthTime(attrs.startDate ?? "");
      if (!start) {
        problems.push({ row, reason: `startDate "${(attrs.startDate ?? "").slice(0, 40)}" is not a time` });
        continue;
      }
      const end = attrs.endDate ? appleHealthTime(attrs.endDate) : null;
      if (metric === "sleep_hours") {
        const hours = end ? sleepStageHours(start, end) : null;
        if (hours === null) {
          problems.push({ row, reason: "sleep span is not a duration" });
          continue;
        }
        const stage = attrs.value ?? "";
        const stageMetric = stage === "HKCategoryValueSleepAnalysisAsleepDeep" ? "sleep_deep_hours"
          : stage === "HKCategoryValueSleepAnalysisAsleepREM" ? "sleep_rem_hours"
            : stage === "HKCategoryValueSleepAnalysisAsleepCore" ? "sleep_light_hours"
              : stage === "HKCategoryValueSleepAnalysisAwake" ? "sleep_awake_hours"
                : "sleep_hours";
        samples.push({ metric: stageMetric, value: hours, unit: "h", at: start, ...(end ? { endedAt: end } : {}), sourceId: options.sourceId, quality: "measured" });
        continue;
      }
      const rawValue = Number(attrs.value);
      if (!Number.isFinite(rawValue)) {
        problems.push({ row, reason: `value "${(attrs.value ?? "").slice(0, 40)}" is not a number` });
        continue;
      }
      const appleUnit = attrs.unit ?? "";
      const scale = UNIT_SCALE[appleUnit];
      let value = rawValue;
      let unit = appleUnit;
      if (scale) {
        unit = scale.unit;
        // Body temperature arrives in Fahrenheit under the same unit token when the phone is set to it.
        value = appleUnit === "degF" ? (rawValue - 32) * (5 / 9) : rawValue * scale.factor;
      }
      if (metric === "body_fat_pct" || metric === "spo2") value = rawValue > 1 ? rawValue : rawValue * 100;
      samples.push({
        metric,
        value: Math.round(value * 100) / 100,
        unit: unit || "unit",
        at: start,
        ...(end ? { endedAt: end } : {}),
        sourceId: options.sourceId,
        quality: "measured",
      });
    }
    if (read === 0) problems.push({ row: 0, reason: "no records of a known type were found; is this an Apple Health export.xml?" });
    return { samples, problems: problems.slice(0, 20), read };
  },
};
