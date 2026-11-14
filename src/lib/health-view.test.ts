// The health view's arithmetic: grouping, tiles, the bucket a window is worth reading at, and a chart spec.
import { describe, expect, it } from "vitest";

import { bucketFor, groupedTiles, healthGroupOf, healthWindow, metricLabel, metricValue, seriesSpec, tilesFor, trendLabel } from "./health-view";
import type { HealthOverview } from "../../shared/health";

describe("health grouping", () => {
  it("puts each canonical metric in its group", () => {
    expect(healthGroupOf("steps")).toBe("activity");
    expect(healthGroupOf("sleep_deep_hours")).toBe("sleep");
    expect(healthGroupOf("resting_heart_rate")).toBe("heart");
    expect(healthGroupOf("weight_kg")).toBe("body");
    expect(healthGroupOf("water_ml")).toBe("lifestyle");
  });

  it("keeps a metric it has never heard of, in the last group", () => {
    expect(healthGroupOf("something_new")).toBe("lifestyle");
  });
});

describe("metric wording", () => {
  it("names a metric it knows and shows the identifier of one it does not", () => {
    expect(metricLabel("resting_heart_rate")).toBe("Resting heart rate");
    expect(metricLabel("mystery_metric")).toBe("mystery metric");
  });

  it("writes a number the way a person reads it", () => {
    expect(metricValue(7.5, "h")).toBe("7.5 h");
    expect(metricValue(1234.567, "count")).toBe("1,235 count");
    expect(metricValue(97, "%")).toBe("97%");
  });

  it("says a trend as a direction and its size", () => {
    expect(trendLabel({ direction: "down", change: -8, changePct: -13, reason: undefined }, "bpm")).toBe("Down 8 bpm (13%)");
    expect(trendLabel({ direction: "flat", change: 0, changePct: 0, reason: undefined }, "bpm")).toBe("Holding steady");
    expect(trendLabel({ direction: "unknown", change: undefined, changePct: undefined, reason: "single_sample" }, "bpm")).toBe("One reading, so nothing to compare");
    expect(trendLabel({ direction: "unknown", change: undefined, changePct: undefined, reason: "no_samples" }, "bpm")).toBe("No readings in this range");
  });
});

describe("the window and its bucket", () => {
  it("asks for whole local days, ending tomorrow", () => {
    const window = healthWindow(7, new Date(2026, 10, 14, 15, 30));
    expect(new Date(window.to).getTime()).toBe(new Date(2026, 10, 15).getTime());
    expect(new Date(window.from).getTime()).toBe(new Date(2026, 10, 8).getTime());
  });

  it("picks a bucket that stays readable as the window grows", () => {
    expect(bucketFor(2)).toBe("hour");
    expect(bucketFor(30)).toBe("day");
    expect(bucketFor(365)).toBe("week");
    expect(bucketFor(1000)).toBe("month");
  });
});

describe("tiles", () => {
  const overview = {
    summaries: [
      { metric: "steps", unit: "count", count: 4, total: 12_000, avg: 3_000, min: 1_000, max: 5_000, latest: null, trend: "up" as const },
      { metric: "sleep_hours", unit: "h", count: 3, total: 22.5, avg: 7.5, min: 6, max: 9, latest: null, trend: "flat" as const },
    ],
  } satisfies Pick<HealthOverview, "summaries">;

  it("turns a summary into the headline a tile shows", () => {
    const [steps] = tilesFor(overview);
    expect(steps).toMatchObject({ metric: "steps", label: "Steps", group: "activity", value: "3,000 count", count: 4 });
    expect(steps!.trendText).toBe("Rising");
  });

  it("groups the tiles and leaves an empty group out", () => {
    const groups = groupedTiles(tilesFor(overview));
    expect(groups.map((entry) => entry.group)).toEqual(["activity", "sleep"]);
  });
});

describe("chart spec", () => {
  const series = {
    metric: "steps", unit: "count", bucket: "day" as const, aggregation: "sum" as const,
    points: [
      { bucket: "2026-11-01T00:00:00.000Z", value: 1_000, n: 1 },
      { bucket: "2026-11-02T00:00:00.000Z", value: 2_000, n: 1 },
    ],
  };

  it("draws a temporal line of the points", () => {
    const spec = seriesSpec(series, { title: "Steps", color: "#1084fe" }) as Record<string, any>;
    expect(spec.data.values).toHaveLength(2);
    expect(spec.mark.type).toBe("line");
    expect(spec.encoding.x.type).toBe("temporal");
    expect(spec.encoding.y.title).toBe("count");
  });

  it("formats the axis the way the bucket reads", () => {
    expect((seriesSpec({ ...series, bucket: "hour" }, { title: "t", color: "#000" }) as any).encoding.x.axis.format).toBe("%H:%M");
    expect((seriesSpec({ ...series, bucket: "month" }, { title: "t", color: "#000" }) as any).encoding.x.axis.format).toBe("%b %Y");
  });
});
