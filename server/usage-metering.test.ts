import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  meteredCsv,
  meteredEntries,
  meteredSummary,
  appendMeteredUsage,
} from "./usage-metering.ts";
import { flushUsageLedger, readUsage, type UsageRow } from "./usage-ledger.ts";
import { wavDuration } from "./tts/wav-duration.ts";
const dirs: string[] = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
const row = (patch: Partial<UsageRow> = {}): UsageRow => ({
  at: "2026-11-14T00:00:00Z",
  botId: "b",
  botName: "Bot",
  threadId: "thread",
  instanceId: "model-api",
  driverKind: "openai",
  model: "model",
  input: 10,
  output: 5,
  costUsd: null,
  trigger: { kind: "owner" },
  ...patch,
});

it("deduplicates a repeated call receipt while retaining independent parent and child costs and unknown history", () => {
  const parent = row({ turnId: "parent", costUsd: 0.1 });
  const child = row({ turnId: "child", costUsd: 0.2, costSource: "estimated" });
  const summary = meteredSummary(
    [parent, child, parent, row({ at: "2026-11-14T01:00:00Z" })],
    "provider",
  );
  expect(summary.entries).toHaveLength(3);
  expect(summary.groups[0]).toMatchObject({
    actual: { USD: 0.1 },
    estimated: { USD: 0.2 },
    unknown: 1,
    quantities: { tokens: 45 },
  });
});

it("persists media/plugin metering in the existing ledger with actual units and no message text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eac-metering-"));
  dirs.push(dir);
  await appendMeteredUsage(dir, {
    botId: "b",
    threadId: "thread",
    provider: "voice",
    kind: "tts",
    unit: "characters",
    quantity: 90,
  });
  await appendMeteredUsage(dir, {
    botId: "b",
    threadId: "thread",
    provider: "plugin",
    kind: "plugin",
    unit: "requests",
    quantity: 1,
    pluginInstallationId: "installed",
  });
  await flushUsageLedger(dir);
  const entries = meteredEntries(
    readUsage(dir, { from: new Date(0), to: new Date() }),
  );
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({
    kind: "tts",
    unit: "characters",
    quantity: 90,
    cost: { state: "unknown" },
  });
  expect(entries[1]?.pluginInstallationId).toBe("installed");
  expect(meteredCsv(entries)).not.toMatch(/message|prompt|secret/);
});

it("keeps currency, explicit free and rollup attribution distinct", () => {
  const entries: UsageRow[] = [
    row({
      metering: {
        entryId: "00000000-0000-4000-a000-000000000001",
        kind: "video",
        unit: "seconds",
        quantity: 2,
        cost: { state: "actual", amount: 3, currency: "CNY" },
      },
    }),
    row({
      metering: {
        entryId: "00000000-0000-4000-a000-000000000002",
        kind: "stt",
        unit: "seconds",
        quantity: 4,
        cost: { state: "free" },
      },
    }),
    row({
      metering: {
        entryId: "00000000-0000-4000-a000-000000000003",
        kind: "video",
        unit: "seconds",
        quantity: 2,
        cost: { state: "actual", amount: 3, currency: "CNY" },
        rollup: true,
      },
    }),
  ];
  expect(meteredSummary(entries, "bot").groups[0]).toMatchObject({
    entries: 2,
    actual: { CNY: 3 },
    free: 1,
    quantities: { seconds: 6 },
  });
});

it("reads WAV chunks with padding to measure uploaded audio duration", () => {
  const wav = Buffer.alloc(48);
  wav.write("RIFF");
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt32LE(4, 28);
  wav.write("data", 36);
  wav.writeUInt32LE(4, 40);
  expect(wavDuration(wav)).toBe(1);
  expect(wavDuration(wav.subarray(0, 46))).toBeNull();
});
