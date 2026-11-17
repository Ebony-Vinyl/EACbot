import { describe, expect, it } from "vitest";

import type { MissionLogEntry } from "../../../packages/agent-protocol/events.ts";
import { drawn, newCreditLedger, received, repainted } from "./credit.ts";
import { EMPTY_LOG, eventDetail, eventLabel, findGap, mergeEntries, refetchFrom, replaceEntries } from "./event-log.ts";
import { ancestry, buildTree, countMissions, flatten, neighbourMission, toSummary } from "./mission-tree.ts";
import { INITIAL_CREDIT_BYTES } from "./terminal-transport.ts";

function entry(seq: number, type = "run.output"): MissionLogEntry {
  return {
    seq,
    eventId: `e${seq}`,
    missionId: "m1",
    at: "2026-01-01T00:00:00.000Z",
    source: "adapter",
    type,
    payload: { text: `line ${seq}` },
  };
}

describe("the event log", () => {
  it("keeps entries in sequence order as pages arrive out of order", () => {
    const view = mergeEntries(mergeEntries(EMPTY_LOG, [entry(3), entry(4)]), [entry(1), entry(2)]);
    expect(view.entries.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(view.lastSeq).toBe(4);
    expect(view.gap).toBeNull();
  });

  it("reports a gap instead of splicing over it", () => {
    const view = mergeEntries(EMPTY_LOG, [entry(1), entry(2), entry(6)]);
    expect(view.gap).toEqual({ afterSeq: 2, beforeSeq: 6, missing: 3 });
  });

  it("treats a first entry above one as a gap from the beginning", () => {
    expect(findGap([entry(4)])).toBeNull();
    const view = mergeEntries(EMPTY_LOG, [entry(1), entry(4)]);
    expect(view.gap?.missing).toBe(2);
  });

  it("counts a duplicate instead of showing it twice", () => {
    const view = mergeEntries(mergeEntries(EMPTY_LOG, [entry(1), entry(2)]), [entry(2), entry(3)]);
    expect(view.entries.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(view.duplicates).toBe(1);
  });

  it("asks for the next page from the last sequence it holds", () => {
    const view = mergeEntries(EMPTY_LOG, [entry(1), entry(2), entry(5)]);
    expect(refetchFrom(view)).toBe(5);
    expect(refetchFrom(EMPTY_LOG)).toBe(0);
  });

  it("replaces the view on a refetch and keeps a gap the server still reports", () => {
    const view = replaceEntries([entry(1), entry(5), entry(5)]);
    expect(view.entries.map((item) => item.seq)).toEqual([1, 5]);
    expect(view.gap).toEqual({ afterSeq: 1, beforeSeq: 5, missing: 3 });
    expect(view.duplicates).toBe(1);
  });

  it("ignores an empty page", () => {
    const view = mergeEntries(EMPTY_LOG, [entry(1)]);
    expect(mergeEntries(view, [])).toBe(view);
  });

  it("names an event type and takes the first readable detail", () => {
    expect(eventLabel("run.tool_call")).toBe("Tool call");
    expect(eventLabel("authority.something")).toBe("authority.something");
    expect(eventDetail(entry(1))).toBe("line 1");
    expect(eventDetail({ ...entry(1), payload: {} })).toBe("");
  });

  it("truncates a long detail to one line", () => {
    const detail = eventDetail({ ...entry(1), payload: { text: `${"a".repeat(400)}\n\nmore` } }, 20);
    expect(detail.length).toBeLessThanOrEqual(20);
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("the mission tree", () => {
  const mission = (id: string, parentMissionId?: string, status: "running" | "waiting_input" | "succeeded" = "running") => ({
    id,
    rootMissionId: "root",
    ...(parentMissionId !== undefined ? { parentMissionId } : {}),
    title: id,
    agent: "hermes" as const,
    status,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("nests children under their parent and keeps siblings ordered", () => {
    const tree = buildTree([mission("root"), mission("b", "root"), mission("a", "root", "waiting_input")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.mission.id).toBe("root");
    expect(tree[0]?.children.map((node) => node.mission.id)).toEqual(["a", "b"]);
    expect(tree[0]?.children[0]?.depth).toBe(1);
  });

  it("keeps an orphan at the top level rather than dropping it", () => {
    const tree = buildTree([mission("a", "missing")]);
    expect(tree.map((node) => node.mission.id)).toEqual(["a"]);
  });

  it("builds one root when asked for it", () => {
    expect(buildTree([mission("root"), mission("other")], "root").map((node) => node.mission.id)).toEqual(["root"]);
  });

  it("walks ancestry root first and stops on a cycle", () => {
    const chain = ancestry([mission("root"), mission("child", "root")], "child");
    expect(chain.map((item) => item.id)).toEqual(["root", "child"]);
    const cyclic = [mission("a", "b"), mission("b", "a")];
    expect(ancestry(cyclic, "a").map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("flattens the tree in reading order", () => {
    const tree = buildTree([mission("root"), mission("child", "root")]);
    expect(flatten(tree).map((node) => node.mission.id)).toEqual(["root", "child"]);
  });

  it("counts needs-input and active missions", () => {
    expect(countMissions([mission("a", undefined, "waiting_input"), mission("b", undefined, "running"), mission("c", undefined, "succeeded")]))
      .toEqual({ total: 3, needsInput: 1, active: 2 });
  });

  it("summarises a mission for a tab strip", () => {
    expect(toSummary(mission("a", "root"))).toEqual({
      id: "a",
      rootMissionId: "root",
      parentMissionId: "root",
      title: "a",
      agent: "hermes",
      status: "running",
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("picks the nearest neighbour when a tab closes", () => {
    expect(neighbourMission(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourMission(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourMission(["a"], "a")).toBeNull();
    expect(neighbourMission(["a", "b"], "zzz")).toBe("a");
  });
});

describe("credit", () => {
  it("starts with the server's window", () => {
    expect(newCreditLedger()).toEqual({ pending: 0, window: INITIAL_CREDIT_BYTES });
  });

  it("accumulates received bytes and returns them once drawn", () => {
    const after = received(received(newCreditLedger(), 100), 50);
    expect(after).toEqual({ pending: 150, window: INITIAL_CREDIT_BYTES - 150 });
    const credited = drawn(after);
    expect(credited.credit).toBe(150);
    expect(credited.ledger).toEqual({ pending: 0, window: INITIAL_CREDIT_BYTES });
  });

  it("credits nothing when nothing is pending", () => {
    const ledger = newCreditLedger();
    expect(drawn(ledger).credit).toBe(0);
    expect(drawn(ledger).ledger).toBe(ledger);
  });

  it("drops uncredited bytes when the screen is repainted", () => {
    const ledger = received(newCreditLedger(), 500);
    expect(repainted(ledger)).toEqual({ pending: 0, window: INITIAL_CREDIT_BYTES });
  });

  it("never lets the window go negative and ignores nonsense", () => {
    expect(received(newCreditLedger(), INITIAL_CREDIT_BYTES * 4).window).toBe(0);
    const ledger = newCreditLedger();
    expect(received(ledger, -1)).toBe(ledger);
    expect(received(ledger, Number.NaN)).toBe(ledger);
  });
});
