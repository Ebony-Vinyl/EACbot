import { describe, expect, it } from "vitest";

import { aggregateUsage, totalUsage, usageEntrySchema, type UsageEntry } from "./usage.ts";

const at = "2026-11-08T00:00:00.000Z";
const entry = (overrides: Record<string, unknown> = {}): UsageEntry => usageEntrySchema.parse({
  entryId: crypto.randomUUID(),
  at,
  kind: "model",
  botId: "bot-a",
  unit: "tokens",
  quantity: 100,
  cost: { state: "actual", amount: 0.002, currency: "USD" },
  ...overrides,
});

describe("usage aggregation", () => {
  it("counts each charge once and keeps actual and estimated costs apart", () => {
    const rows = [
      entry(),
      entry({ kind: "tts", unit: "characters", quantity: 500, cost: { state: "estimated", amount: 0.01, currency: "USD" } }),
      entry({ kind: "video", unit: "seconds", quantity: 30, cost: { state: "free" } }),
      entry({ kind: "stt", unit: "seconds", quantity: 20, cost: { state: "unknown" } }),
    ];
    const byKind = aggregateUsage(rows, "kind");
    expect(byKind).toMatchObject([
      { key: "model", entries: 1, actual: { USD: 0.002 } },
      { key: "stt", entries: 1, unknown: 1 },
      { key: "tts", entries: 1, estimated: { USD: 0.01 } },
      { key: "video", entries: 1, free: 1 },
    ]);
    expect(totalUsage(rows)).toMatchObject({ entries: 4, unknown: 1, free: 1 });
  });

  it("does not double count a parent rollup and its children", () => {
    const parent = entry({ entryId: crypto.randomUUID(), kind: "plugin", quantity: 100 });
    const child = entry({ parentId: parent.entryId, rootId: parent.entryId, quantity: 100 });
    const rows = [{ ...parent, rollup: true }, child];
    expect(aggregateUsage(rows, "bot")).toMatchObject([{ key: "bot-a", entries: 1, quantities: { tokens: 100 } }]);
    expect(totalUsage(rows).actual).toMatchObject({ USD: 0.002 });
  });

  it("groups by plugin and day without mixing currencies", () => {
    const rows = [
      entry({ pluginInstallationId: "plg_1", cost: { state: "actual", amount: 7, currency: "CNY" } }),
      entry({ pluginInstallationId: "plg_1", at: "2026-11-09T10:00:00.000Z" }),
    ];
    expect(aggregateUsage(rows, "plugin")).toMatchObject([{ key: "plg_1", actual: { USD: 0.002, CNY: 7 } }]);
    expect(aggregateUsage(rows, "day").map((group) => group.key)).toEqual(["2026-11-08", "2026-11-09"]);
  });

  it("refuses an actual cost without an amount", () => {
    expect(() => entry({ cost: { state: "actual", currency: "USD" } })).toThrow();
  });
});
