import { describe, expect, it } from "vitest";

import type { Mission, MissionTreeNode } from "../../../packages/agent-protocol/mission.ts";
import {
  allowedOperations, composerBlocker, countForFilter, filterTree, flattenTree, matchesFilter, needsReconcile,
  summarizeChildren,
} from "./missions.ts";

const mission = (overrides: Partial<Mission> = {}): Mission => ({
  protocolVersion: 1,
  id: "m-1",
  rootMissionId: "m-1",
  depth: 0,
  title: "Sort the inbox",
  prompt: "Sort it",
  agent: "hermes",
  environment: { id: "env-1", label: "box", kind: "ssh", authMode: "subscription" },
  status: "running",
  revision: 7,
  createdAt: "2026-11-15T09:00:00Z",
  updatedAt: "2026-11-15T09:05:00Z",
  acceptedAt: "2026-11-15T09:00:00Z",
  runIds: ["r-1"],
  childIds: [],
  artifactIds: [],
  approvalIds: [],
  wakeGeneration: 0,
  ...overrides,
});

describe("which operations a status allows", () => {
  it("offers steer only while a run can take it", () => {
    expect(allowedOperations({ status: "running" }).steer).toBe(true);
    expect(allowedOperations({ status: "waiting_children" }).steer).toBe(true);
    expect(allowedOperations({ status: "waiting_input" }).steer).toBe(false);
    expect(allowedOperations({ status: "succeeded" }).steer).toBe(false);
  });

  it("offers interrupt while the run is live or blocked", () => {
    for (const status of ["running", "waiting_input", "waiting_children"] as const) {
      expect(allowedOperations({ status }).interrupt).toBe(true);
    }
    expect(allowedOperations({ status: "queued" }).interrupt).toBe(false);
  });

  it("offers resume only from interrupted", () => {
    expect(allowedOperations({ status: "interrupted" }).resume).toBe(true);
    expect(allowedOperations({ status: "running" }).resume).toBe(false);
    expect(allowedOperations({ status: "failed" }).resume).toBe(false);
  });

  it("offers no change at all once a mission is terminal", () => {
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      const operations = allowedOperations({ status });
      expect([operations.steer, operations.interrupt, operations.resume, operations.cancel, operations.answer]).toEqual([
        false, false, false, false, false,
      ]);
    }
  });

  it("offers an answer only while the run waits for one", () => {
    expect(allowedOperations({ status: "waiting_input" }).answer).toBe(true);
    expect(allowedOperations({ status: "running" }).answer).toBe(false);
  });

  it("asks for a reconcile only when a restart left the mission interrupted", () => {
    expect(needsReconcile({ status: "interrupted" })).toBe(true);
    expect(needsReconcile({ status: "running" })).toBe(false);
  });
});

describe("the composer says why it is closed instead of silently refusing", () => {
  it("is open while a run can take input", () => {
    expect(composerBlocker({ status: "running" })).toBeUndefined();
    expect(composerBlocker({ status: "waiting_children" })).toBeUndefined();
  });

  it("names the reason for each status that cannot", () => {
    expect(composerBlocker({ status: "succeeded" })).toContain("已结束");
    expect(composerBlocker({ status: "interrupted" })).toContain("中断");
    expect(composerBlocker({ status: "queued" })).toContain("启动");
    expect(composerBlocker({ status: "waiting_input" })).toContain("回答");
  });
});

describe("filtering and the tree", () => {
  it("puts every status in exactly the filter that describes it", () => {
    const statuses = ["queued", "provisioning", "running", "resuming", "waiting_input", "waiting_children", "interrupted", "succeeded", "failed", "cancelled"] as const;
    for (const status of statuses) {
      const matched = (["active", "waiting", "finished"] as const).filter((filter) => matchesFilter(status, filter));
      expect(matched).toHaveLength(1);
      expect(matchesFilter(status, "all")).toBe(true);
    }
  });

  it("reads a tree in the order a nested list shows it", () => {
    expect(flattenTree(tree()).map((row) => `${row.depth}:${row.node.mission.id}`)).toEqual([
      "0:m-1", "1:m-2", "2:m-4", "1:m-3",
    ]);
  });

  it("keeps an ancestor so a matching child never appears detached", () => {
    const rows = filterTree(tree(), "waiting");
    expect(rows.map((row) => row.node.mission.id)).toEqual(["m-1", "m-2", "m-4"]);
  });

  it("keeps the root when the root itself matches", () => {
    const rows = filterTree(tree(), "active");
    expect(rows.map((row) => row.node.mission.id)).toContain("m-1");
    expect(rows.map((row) => row.node.mission.id)).toContain("m-2");
  });

  it("returns nothing when no row matches", () => {
    const onlyRunning: MissionTreeNode = { mission: mission({ id: "m-1", status: "running" }), children: [] };
    expect(filterTree(onlyRunning, "finished")).toEqual([]);
  });

  it("counts what a chip shows the same way the filter keeps rows", () => {
    const root = tree();
    expect(countForFilter(root, "all")).toBe(4);
    expect(countForFilter(root, "waiting")).toBe(2);
    expect(countForFilter(root, "active")).toBe(1);
    expect(countForFilter(root, "finished")).toBe(1);
  });

  it("counts children by what a person needs to know", () => {
    expect(summarizeChildren(tree())).toEqual({ total: 3, running: 1, waiting: 1, succeeded: 0, failed: 1, cancelled: 0 });
  });

  it("counts no children for a leaf", () => {
    expect(summarizeChildren({ mission: mission(), children: [] })).toEqual({ total: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, cancelled: 0 });
  });
});

function tree(): MissionTreeNode {
  return {
    mission: mission({ id: "m-1", status: "waiting_children" }),
    children: [
      {
        mission: mission({ id: "m-2", status: "running", depth: 1, parentMissionId: "m-1" }),
        children: [{ mission: mission({ id: "m-4", status: "waiting_input", depth: 2, parentMissionId: "m-2" }), children: [] }],
      },
      { mission: mission({ id: "m-3", status: "failed", depth: 1, parentMissionId: "m-1" }), children: [] },
    ],
  };
}
