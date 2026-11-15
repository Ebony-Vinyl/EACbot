import { describe, expect, it } from "vitest";

import { EventHub, parseCursor } from "./hub.ts";

function hub(replayLimit?: number): EventHub {
  let tick = 0;
  return new EventHub({
    now: () => new Date(Date.parse("2026-01-01T00:00:00.000Z") + (tick += 1) * 1_000).toISOString(),
    ...(replayLimit !== undefined ? { replayLimit } : {}),
  });
}

describe("event hub", () => {
  it("numbers notifications monotonically from 1", () => {
    const events = hub();
    expect(events.publish({ kind: "mission.updated", missionId: "m1" }).cursor).toBe(1);
    expect(events.publish({ kind: "run.updated", missionId: "m1", runId: "r1" }).cursor).toBe(2);
    expect(events.cursor).toBe(2);
  });

  it("replays everything after a cursor", () => {
    const events = hub();
    events.publish({ kind: "mission.updated", missionId: "m1" });
    events.publish({ kind: "mission.updated", missionId: "m2" });
    events.publish({ kind: "mission.updated", missionId: "m3" });
    const replay = events.replay("1");
    expect(replay.resync).toBe(false);
    expect(replay.notifications.map((notification) => notification.missionId)).toEqual(["m2", "m3"]);
  });

  it("replays nothing for a first connection, which has no snapshot yet", () => {
    const events = hub();
    events.publish({ kind: "mission.updated" });
    const replay = events.replay(undefined);
    expect(replay.notifications).toEqual([]);
    expect(replay.resync).toBe(false);
  });

  it("asks for a resync when the cursor is older than the retained window", () => {
    const events = hub(3);
    for (let index = 0; index < 10; index += 1) events.publish({ kind: "mission.updated", missionId: `m${index}` });
    const replay = events.replay("1");
    expect(replay.resync).toBe(true);
    expect(replay.notifications).toEqual([]);
    expect(replay.cursor).toBe(10);
  });

  it("still replays the oldest retained notification when the cursor is exactly before it", () => {
    const events = hub(3);
    for (let index = 0; index < 5; index += 1) events.publish({ kind: "mission.updated", missionId: `m${index}` });
    // Retained: 3,4,5. A client at 2 can be served without a gap.
    const replay = events.replay("2");
    expect(replay.resync).toBe(false);
    expect(replay.notifications.map((notification) => notification.cursor)).toEqual([3, 4, 5]);
  });

  it("treats a malformed or future cursor as a resync rather than a silent gap", () => {
    const events = hub();
    events.publish({ kind: "mission.updated" });
    expect(events.replay("not-a-cursor").resync).toBe(true);
    expect(events.replay("99").resync).toBe(true);
    expect(events.replay("-1").resync).toBe(true);
  });

  it("delivers live notifications and stops after unsubscribe", () => {
    const events = hub();
    const seen: number[] = [];
    const subscription = events.subscribe((notification) => seen.push(notification.cursor));
    events.publish({ kind: "mission.updated" });
    subscription.close();
    events.publish({ kind: "mission.updated" });
    expect(seen).toEqual([1]);
    expect(events.listenerCount).toBe(0);
  });

  it("survives a listener that throws", () => {
    const errors: unknown[] = [];
    const events = new EventHub({ now: () => "2026-01-01T00:00:00.000Z", onListenerError: (error) => errors.push(error) });
    events.subscribe(() => {
      throw new Error("listener failed");
    });
    const second: number[] = [];
    events.subscribe((notification) => second.push(notification.cursor));
    expect(() => events.publish({ kind: "mission.updated" })).not.toThrow();
    expect(second).toEqual([1]);
    expect(errors).toHaveLength(1);
  });

  it("announces shutdown once and refuses later subscribers", () => {
    const events = hub();
    const seen: string[] = [];
    events.subscribe((notification) => seen.push(notification.kind));
    events.close();
    events.close();
    expect(seen).toEqual(["server.shutdown"]);
    expect(events.closed).toBe(true);
    expect(events.listenerCount).toBe(0);
  });
});

describe("cursor parsing", () => {
  it("accepts only a non-negative decimal", () => {
    expect(parseCursor("0")).toBe(0);
    expect(parseCursor("42")).toBe(42);
    expect(parseCursor(" 42")).toBeUndefined();
    expect(parseCursor("4.2")).toBeUndefined();
    expect(parseCursor("")).toBeUndefined();
    expect(parseCursor("999999999999999999999")).toBeUndefined();
  });
});
