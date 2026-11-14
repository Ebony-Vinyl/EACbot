// Each importer reads one file shape and reports its own refusals. They do not know about each other or the store.
import { describe, expect, it } from "vitest";

import { appleHealthImporter, APPLE_HEALTH_TYPES } from "./apple-health.ts";
import { csvImporter, parseCsvRows } from "./csv.ts";
import { jsonImporter } from "./json.ts";
import { detectFormat } from "./index.ts";

const options = { sourceId: "file:test", now: () => "2026-11-14T00:00:00.000Z" };

describe("CSV importer", () => {
  it("reads a hand-kept sheet whatever the column order", () => {
    const text = "at,value,metric\n2026-11-01T07:00:00Z,72.4,weight_kg\n2026-11-02T07:00:00Z,7.5,sleep_hours\n";
    const result = csvImporter.parse(text, options);
    expect(result.read).toBe(2);
    expect(result.problems).toHaveLength(0);
    expect(result.samples).toHaveLength(2);
    expect(result.samples[0]).toMatchObject({ metric: "weight_kg", value: 72.4, unit: "kg", sourceId: "file:test" });
    expect(result.samples[1]).toMatchObject({ metric: "sleep_hours", value: 7.5, unit: "h" });
  });

  it("keeps a quoted field that holds a comma and a quote", () => {
    const rows = parseCsvRows('metric,value,at,note\nmood,7,2026-11-01T07:00:00Z,"tired, but ""ok"""\n');
    expect(rows[1]![3]).toBe('tired, but "ok"');
  });

  it("names the row it refused and keeps the good ones", () => {
    const text = "metric,value,at\nsteps,1000,2026-11-01T07:00:00Z\nsteps,not-a-number,2026-11-01T08:00:00Z\nsteps,2000,not-a-time\n";
    const result = csvImporter.parse(text, options);
    expect(result.samples).toHaveLength(1);
    expect(result.problems).toEqual([
      { row: 3, reason: expect.stringContaining("not a number") },
      { row: 4, reason: expect.stringContaining("not a time") },
    ]);
    expect(result.read).toBe(3);
  });

  it("refuses a file whose header has no metric column", () => {
    const result = csvImporter.parse("value,at\n1,2026-11-01T07:00:00Z\n", options);
    expect(result.samples).toHaveLength(0);
    expect(result.problems[0]!.reason).toMatch(/missing metric/);
  });

  it("detects itself from its header", () => {
    expect(csvImporter.detects("metric,value,at\nsteps,1,2026-11-01T07:00:00Z\n")).toBe(true);
    expect(csvImporter.detects("name,count\nsteps,1\n")).toBe(false);
  });
});

describe("JSON importer", () => {
  it("reads a bare array and an object with a samples key", () => {
    const bare = jsonImporter.parse(JSON.stringify([{ metric: "steps", value: 800, at: "2026-11-01T07:00:00Z" }]), options);
    expect(bare.samples).toHaveLength(1);
    const wrapped = jsonImporter.parse(JSON.stringify({ samples: [{ metric: "steps", value: 800, at: "2026-11-01T07:00:00Z" }] }), options);
    expect(wrapped.samples).toHaveLength(1);
    expect(wrapped.samples[0]).toMatchObject({ unit: "count", quality: "measured" });
  });

  it("keeps a declared quality and note", () => {
    const result = jsonImporter.parse(JSON.stringify([{ metric: "sleep_score", value: 82, at: "2026-11-01T07:00:00Z", quality: "derived", note: "from the ring" }]), options);
    expect(result.samples[0]).toMatchObject({ quality: "derived", note: "from the ring", unit: "score" });
  });

  it("refuses malformed JSON with one problem, not a throw", () => {
    const result = jsonImporter.parse("{ not json", options);
    expect(result.samples).toHaveLength(0);
    expect(result.problems[0]!.reason).toMatch(/not valid JSON/);
  });

  it("reports each bad row by number", () => {
    const result = jsonImporter.parse(JSON.stringify([
      { metric: "steps", value: 1, at: "2026-11-01T07:00:00Z" },
      { metric: "", value: 1, at: "2026-11-01T07:00:00Z" },
      { metric: "steps", value: "x", at: "2026-11-01T07:00:00Z" },
      { metric: "steps", value: 1, at: "nope" },
    ]), options);
    expect(result.samples).toHaveLength(1);
    expect(result.problems.map((problem) => problem.row)).toEqual([2, 3, 4]);
  });
});

describe("Apple Health importer", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" creationDate="2026-11-01 08:00:00 +0800" startDate="2026-11-01 07:00:00 +0800" endDate="2026-11-01 08:00:00 +0800" value="1234"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale" unit="kg" startDate="2026-11-01 07:30:00 +0800" endDate="2026-11-01 07:30:00 +0800" value="72.4"/>
 <Record type="HKQuantityTypeIdentifierOxygenSaturation" sourceName="Watch" unit="%" startDate="2026-11-01 03:00:00 +0800" endDate="2026-11-01 03:00:00 +0800" value="0.97"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisAsleepDeep" startDate="2026-11-01 01:00:00 +0800" endDate="2026-11-01 02:30:00 +0800"/>
 <Record type="HKQuantityTypeIdentifierDietaryCaffeine" sourceName="App" unit="mg" startDate="2026-11-01 09:00:00 +0800" endDate="2026-11-01 09:00:00 +0800" value="80"/>
</HealthData>`;

  it("maps Apple's types onto the domain's metrics", () => {
    const result = appleHealthImporter.parse(xml, options);
    expect(result.samples.map((sample) => sample.metric).sort()).toEqual(["caffeine_mg", "sleep_deep_hours", "spo2", "steps", "weight_kg"]);
  });

  it("turns a percentage stored as a fraction into a percentage", () => {
    const spo2 = appleHealthImporter.parse(xml, options).samples.find((sample) => sample.metric === "spo2")!;
    expect(spo2.value).toBe(97);
    expect(spo2.unit).toBe("%");
  });

  it("turns a sleep span into hours and names its stage", () => {
    const sleep = appleHealthImporter.parse(xml, options).samples.find((sample) => sample.metric === "sleep_deep_hours")!;
    expect(sleep.value).toBe(1.5);
    expect(sleep.unit).toBe("h");
    expect(sleep.endedAt).toBeTruthy();
  });

  it("reads a local time with its own offset", () => {
    const steps = appleHealthImporter.parse(xml, options).samples.find((sample) => sample.metric === "steps")!;
    expect(new Date(steps.at).toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("converts miles and pounds when the phone is set to them", () => {
    const result = appleHealthImporter.parse(`<HealthData>
      <Record type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="mi" startDate="2026-11-01 07:00:00 +0000" value="1"/>
      <Record type="HKQuantityTypeIdentifierBodyMass" unit="lb" startDate="2026-11-01 07:00:00 +0000" value="160"/>
    </HealthData>`, options);
    expect(result.samples.find((sample) => sample.metric === "distance_m")!.value).toBe(1609.34);
    expect(result.samples.find((sample) => sample.metric === "weight_kg")!.value).toBe(72.57);
  });

  it("says so when the file holds nothing it knows", () => {
    const result = appleHealthImporter.parse("<HealthData></HealthData>", options);
    expect(result.samples).toHaveLength(0);
    expect(result.problems[0]!.reason).toMatch(/Apple Health export/);
  });

  it("knows every type it maps has a metric", () => {
    for (const metric of Object.values(APPLE_HEALTH_TYPES)) expect(metric).toMatch(/^[a-z][a-z0-9_]+$/);
  });
});

describe("format detection", () => {
  it("picks the importer the text belongs to", () => {
    expect(detectFormat("metric,value,at\nsteps,1,2026-11-01T07:00:00Z")).toBe("csv");
    expect(detectFormat('[{"metric":"steps","value":1,"at":"2026-11-01T07:00:00Z"}]')).toBe("json");
    expect(detectFormat("<HealthData><Record type=\"HKQuantityTypeIdentifierStepCount\" value=\"1\"/></HealthData>")).toBe("apple-health");
    expect(detectFormat("just some words")).toBeNull();
  });
});
