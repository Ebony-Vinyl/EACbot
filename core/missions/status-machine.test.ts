import { describe, expect, it } from "vitest";

import {
  canTransition,
  IllegalTransitionError,
  isTerminalMissionStatus,
  legalTargets,
  MISSION_STATUSES,
  type MissionStatus,
} from "../../packages/agent-protocol/mission-status.ts";
import { canTransitionRun, isTerminalRunStatus, RUN_STATUSES } from "../../packages/agent-protocol/run.ts";

const TERMINAL: MissionStatus[] = ["succeeded", "failed", "cancelled"];

describe("the mission status machine", () => {
  it("knows the ten statuses and exactly three terminal ones", () => {
    expect(MISSION_STATUSES).toHaveLength(10);
    expect(MISSION_STATUSES.filter(isTerminalMissionStatus)).toEqual(TERMINAL);
  });

  it("never leaves a terminal status", () => {
    for (const status of TERMINAL) {
      expect(legalTargets(status)).toEqual([]);
      for (const target of MISSION_STATUSES) expect(canTransition(status, target)).toBe(false);
    }
  });

  it("never moves to its own status", () => {
    for (const status of MISSION_STATUSES) expect(canTransition(status, status)).toBe(false);
  });

  it("lets interrupt be resumed and lets resume return to running", () => {
    expect(canTransition("running", "interrupted")).toBe(true);
    expect(canTransition("interrupted", "resuming")).toBe(true);
    expect(canTransition("resuming", "running")).toBe(true);
  });

  it("does not let an interrupted mission jump straight back to running", () => {
    expect(canTransition("interrupted", "running")).toBe(false);
  });

  it("reaches every status but the entry state from at least one other", () => {
    for (const target of MISSION_STATUSES) {
      if (target === "queued") continue;
      const reachable = MISSION_STATUSES.some((from) => canTransition(from, target));
      expect(reachable, target).toBe(true);
    }
    expect(MISSION_STATUSES.some((from) => canTransition(from, "queued"))).toBe(false);
  });

  it("names the rejected pair", () => {
    const error = new IllegalTransitionError("succeeded", "running");
    expect(error.message).toBe("mission cannot move from succeeded to running");
  });

  it("has a run machine whose completed and cancelled runs are final", () => {
    expect(RUN_STATUSES).toContain("accepted");
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(canTransitionRun("running", "completed")).toBe(true);
    expect(canTransitionRun("interrupted", "resuming")).toBe(true);
    expect(canTransitionRun("completed", "running")).toBe(false);
    expect(canTransitionRun("accepted", "running")).toBe(true);
  });
});
