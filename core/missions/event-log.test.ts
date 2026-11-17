import { afterEach, describe, expect, it } from "vitest";

import { createFixture, createMission, type Fixture } from "./fixture.ts";

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture(): Fixture {
  const created = createFixture();
  open.push(created);
  return created;
}

async function started(f: Fixture) {
  const missionId = await createMission(f);
  const runId = f.runtime.store.requireMission(missionId).activeRunId!;
  return { missionId, runId, adapter: f.adapters.adapter("hermes") };
}

describe("the append-only event log", () => {
  it("records the adapter's own start event at sequence 1", async () => {
    const f = fixture();
    const { missionId } = await started(f);
    const events = f.runtime.log.events(missionId);
    expect(events.map((entry) => entry.type)).toEqual(["mission.accepted", "run.accepted", "run.started"]);
    const adapterEvent = events.find((entry) => entry.source === "adapter")!;
    expect(adapterEvent.adapterSeq).toBe(1);
  });

  it("drops a duplicate event id without writing a second row", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);
    const before = f.runtime.log.countFor(missionId);
    const event = adapter.emitRaw(runId, 2, "run.output", { text: "once", stream: "assistant" });
    expect(f.runtime.ingest(event).duplicate).toBe(true);
    expect(f.runtime.log.countFor(missionId)).toBe(before + 1);
  });

  it("buffers an event that arrives before its predecessor, then replays in order", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);

    adapter.emitRaw(runId, 3, "run.output", { text: "third", stream: "assistant" });
    expect(f.runtime.log.pendingFor(runId).map((pending) => pending.adapterSeq)).toEqual([3]);
    expect(f.runtime.log.events(missionId).some((entry) => entry.type === "run.output")).toBe(false);

    adapter.emitRaw(runId, 2, "run.output", { text: "second", stream: "assistant" });
    const outputs = f.runtime.log.events(missionId).filter((entry) => entry.type === "run.output");
    expect(outputs.map((entry) => entry.adapterSeq)).toEqual([2, 3]);
    expect(outputs.map((entry) => (entry.payload as { text: string }).text)).toEqual(["second", "third"]);
    expect(f.runtime.log.pendingFor(runId)).toEqual([]);
  });

  it("keeps a gap open until the missing sequence arrives", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);
    adapter.emitRaw(runId, 4, "run.output", { text: "four", stream: "assistant" });
    adapter.emitRaw(runId, 3, "run.output", { text: "three", stream: "assistant" });
    expect(f.runtime.log.events(missionId).filter((e) => e.type === "run.output")).toHaveLength(0);
    adapter.emitRaw(runId, 2, "run.output", { text: "two", stream: "assistant" });
    expect(
      f.runtime.log
        .events(missionId)
        .filter((e) => e.type === "run.output")
        .map((e) => (e.payload as { text: string }).text),
    ).toEqual(["two", "three", "four"]);
  });

  it("applies a buffered completion only after the gap closes, and settles once", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);
    adapter.emitRaw(runId, 3, "run.completed", { outcome: "succeeded" });
    expect(f.runtime.store.requireMission(missionId).status).toBe("running");

    adapter.emitRaw(runId, 2, "run.output", { text: "work", stream: "assistant" });
    expect(f.runtime.store.requireMission(missionId).status).toBe("succeeded");
    expect(f.runtime.log.events(missionId).filter((e) => e.type === "run.completed")).toHaveLength(1);
  });

  it("ignores every event for a run after it settled", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);
    adapter.emitRaw(runId, 2, "run.completed", { outcome: "succeeded" });
    expect(f.runtime.store.requireMission(missionId).status).toBe("succeeded");

    const late = adapter.emitRaw(runId, 3, "run.failed", { code: "late", message: "too late" });
    const result = f.runtime.ingest(late);
    expect(result.accepted).toBe(false);
    expect(f.runtime.store.requireMission(missionId).status).toBe("succeeded");
  });

  it("never lets a terminal status signal become an event", async () => {
    const f = fixture();
    const { missionId } = await started(f);
    const before = f.runtime.log.countFor(missionId);
    expect(() =>
      f.runtime.ingest({ kind: "terminal.status", terminalId: "t-1", state: "exited", at: "2026-01-01T00:00:05.000Z", source: "osc7501" } as never),
    ).toThrow(/not an adapter event/);
    expect(f.runtime.log.countFor(missionId)).toBe(before);
    expect(f.runtime.store.requireMission(missionId).status).toBe("running");
  });

  it("reports the sequence the log expects next", async () => {
    const f = fixture();
    const { runId, adapter } = await started(f);
    expect(f.runtime.log.expectedSeq(runId)).toBe(2);
    adapter.emitRaw(runId, 2, "run.output", { text: "x", stream: "stdout" });
    expect(f.runtime.log.expectedSeq(runId)).toBe(3);
  });

  it("pages events by sequence", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);
    for (let seq = 2; seq <= 5; seq += 1) {
      adapter.emitRaw(runId, seq, "run.output", { text: `line ${seq}`, stream: "stdout" });
    }
    const page = f.runtime.log.events(missionId, { limit: 2 });
    expect(page).toHaveLength(2);
    const next = f.runtime.log.events(missionId, { sinceSeq: page[1]!.seq, limit: 2 });
    expect(next[0]!.seq).toBeGreaterThan(page[1]!.seq);
  });
});
