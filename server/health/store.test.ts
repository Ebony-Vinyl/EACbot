// The store's own rules: one row per (source, metric, window), a re-import replaces rather than duplicates, and
// the aggregates the view and the tools read. Times are built from local midnight because a day bucket is local.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HealthStore } from "./store.ts";

const folders: string[] = [];
const stores: HealthStore[] = [];
const store = () => {
  const folder = mkdtempSync(join(tmpdir(), "eac-health-store-"));
  folders.push(folder);
  const health = new HealthStore({ dataDir: folder });
  stores.push(health);
  return health;
};

afterEach(() => {
  for (const health of stores.splice(0)) health.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A local wall-clock time on a day in November 2026, as the ISO string the store parses back to that instant. */
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).toISOString();
const dayRange = (day: number) => ({ from: local(day, 0), to: local(day + 1, 0) });

describe("health store", () => {
  it("writes a reading and reads it back", () => {
    const health = store();
    const written = health.write([{ metric: "weight_kg", value: 72.4, unit: "kg", at: local(1, 7), sourceId: "manual", quality: "measured" }]);
    expect(written.added).toBe(1);
    const rows = health.query({ metrics: ["weight_kg"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ metric: "weight_kg", value: 72.4, unit: "kg", sourceId: "manual", revision: 0 });
  });

  it("replaces the same (source, metric, time) instead of adding a second row", () => {
    const health = store();
    const row = { metric: "steps", value: 1_000, unit: "count", at: local(2, 9), sourceId: "file:watch", quality: "measured" as const };
    health.write([row]);
    const again = health.write([{ ...row, value: 2_500 }]);
    expect(again).toMatchObject({ added: 0, replaced: 1 });
    const rows = health.query({ metrics: ["steps"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: 2_500, revision: 1 });
  });

  it("keeps two sources' readings of the same moment apart", () => {
    const health = store();
    health.write([
      { metric: "steps", value: 900, unit: "count", at: local(2, 9), sourceId: "file:watch", quality: "measured" },
      { metric: "steps", value: 1_100, unit: "count", at: local(2, 9), sourceId: "cloud:withings", quality: "measured" },
    ]);
    expect(health.query({ metrics: ["steps"] })).toHaveLength(2);
    expect(health.sources().map((source) => source.sourceId).sort()).toEqual(["cloud:withings", "file:watch"]);
  });

  it("sums a count-like metric per day and averages a reading", () => {
    const health = store();
    health.write([
      { metric: "steps", value: 1_000, unit: "count", at: local(2, 8), sourceId: "manual", quality: "measured" },
      { metric: "steps", value: 2_000, unit: "count", at: local(2, 18), sourceId: "manual", quality: "measured" },
      { metric: "resting_heart_rate", value: 50, unit: "bpm", at: local(2, 8), sourceId: "manual", quality: "measured" },
      { metric: "resting_heart_rate", value: 54, unit: "bpm", at: local(2, 20), sourceId: "manual", quality: "measured" },
    ]);
    const steps = health.series("steps", dayRange(2), "day");
    expect(steps.aggregation).toBe("sum");
    expect(steps.points).toHaveLength(1);
    expect(steps.points[0]!.value).toBe(3_000);
    const hr = health.series("resting_heart_rate", dayRange(2), "day");
    expect(hr.aggregation).toBe("avg");
    expect(hr.points[0]!.value).toBe(52);
  });

  it("calls a trend unknown when there is nothing to compare", () => {
    const health = store();
    health.write([{ metric: "weight_kg", value: 72, unit: "kg", at: local(1, 7), sourceId: "manual", quality: "measured" }]);
    expect(health.trend("weight_kg", { from: local(1, 0), to: local(30, 0) })).toMatchObject({ direction: "unknown", reason: "single_sample" });
    expect(health.trend("sleep_hours", { from: local(1, 0), to: local(30, 0) })).toMatchObject({ direction: "unknown", reason: "no_samples" });
  });

  it("reports a direction from the halves of the window", () => {
    const health = store();
    health.write([
      { metric: "resting_heart_rate", value: 60, unit: "bpm", at: local(1, 7), sourceId: "manual", quality: "measured" },
      { metric: "resting_heart_rate", value: 60, unit: "bpm", at: local(2, 7), sourceId: "manual", quality: "measured" },
      { metric: "resting_heart_rate", value: 52, unit: "bpm", at: local(3, 7), sourceId: "manual", quality: "measured" },
      { metric: "resting_heart_rate", value: 52, unit: "bpm", at: local(4, 7), sourceId: "manual", quality: "measured" },
    ]);
    expect(health.trend("resting_heart_rate", { from: local(1, 0), to: local(30, 0) })).toMatchObject({ direction: "down", change: -8, count: 4 });
  });

  it("refuses a reading that is not a number or not a time", () => {
    const health = store();
    expect(() => health.write([{ metric: "steps", value: Number.NaN, unit: "count", at: local(2, 9), sourceId: "manual", quality: "measured" }]))
      .toThrow(/finite number/);
    expect(() => health.write([{ metric: "steps", value: 1, unit: "count", at: "not a time", sourceId: "manual", quality: "measured" }]))
      .toThrow(/not a valid time/);
  });

  it("removes a source's readings and its source row together", () => {
    const health = store();
    health.write([
      { metric: "steps", value: 1_000, unit: "count", at: local(2, 8), sourceId: "file:watch", quality: "measured" },
      { metric: "steps", value: 900, unit: "count", at: local(2, 9), sourceId: "manual", quality: "measured" },
    ]);
    expect(health.remove({ sourceId: "file:watch" })).toBe(1);
    expect(health.query({ metrics: ["steps"] })).toHaveLength(1);
    expect(health.sources().map((source) => source.sourceId)).toEqual(["manual"]);
  });

  it("answers an overview with summaries, series and sources in one call", () => {
    const health = store();
    health.write([
      { metric: "steps", value: 5_000, unit: "count", at: local(2, 8), sourceId: "manual", quality: "measured" },
      { metric: "sleep_hours", value: 7.5, unit: "h", at: local(2, 7), sourceId: "manual", quality: "measured" },
    ]);
    const overview = health.overview({ from: local(1, 0), to: local(3, 0) });
    expect(overview.sampleCount).toBe(2);
    expect(overview.summaries.map((summary) => summary.metric).sort()).toEqual(["sleep_hours", "steps"]);
    expect(overview.series).toHaveLength(2);
    expect(overview.sources).toHaveLength(1);
  });
});
