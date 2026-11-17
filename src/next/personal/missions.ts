/**
 * Mission-tree logic: what a person filters by, the order a tree is read in,
 * and which operations a status allows.
 *
 * Nothing here builds a request. `api.ts` sends commands through
 * `foundation/api.ts`, which owns command ids and revisions; this module only
 * decides what to show and what to offer.
 */
import type { Mission, MissionTreeNode } from "../../../packages/agent-protocol/mission.ts";
import type { MissionStatus } from "../../../packages/agent-protocol/mission-status.ts";
import { isTerminalMissionStatus } from "../../../packages/agent-protocol/mission-status.ts";

/** The statuses a person filters by. Each group names what it contains, so a
 * filter never silently swallows a status it did not list. */
export const MISSION_FILTERS = ["active", "waiting", "finished", "all"] as const;

export type MissionFilter = (typeof MISSION_FILTERS)[number];

export const FILTER_LABELS: Readonly<Record<MissionFilter, string>> = {
  active: "进行中",
  waiting: "等待中",
  finished: "已结束",
  all: "全部",
};

const ACTIVE: readonly MissionStatus[] = ["queued", "provisioning", "running", "resuming"];
const WAITING: readonly MissionStatus[] = ["waiting_input", "waiting_children", "interrupted"];

export function matchesFilter(status: MissionStatus, filter: MissionFilter): boolean {
  switch (filter) {
    case "active":
      return ACTIVE.includes(status);
    case "waiting":
      return WAITING.includes(status);
    case "finished":
      return isTerminalMissionStatus(status);
    case "all":
      return true;
  }
}

export interface TreeRow {
  readonly node: MissionTreeNode;
  readonly depth: number;
}

/** The tree in reading order, so a keyboard user and a screen reader walk the
 * same sequence a nested list shows. */
export function flattenTree(root: MissionTreeNode): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: MissionTreeNode, depth: number): void => {
    rows.push({ node, depth });
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return rows;
}

/** The rows a filter keeps, with every ancestor of a match kept too, so a
 * matching child never appears detached from its parent. */
export function filterTree(root: MissionTreeNode, filter: MissionFilter): TreeRow[] {
  const rows = flattenTree(root);
  if (filter === "all") return rows;
  const keep = new Set<string>();
  for (const row of rows) {
    if (!matchesFilter(row.node.mission.status, filter)) continue;
    let cursor: string | undefined = row.node.mission.id;
    while (cursor !== undefined) {
      keep.add(cursor);
      const parent: string | undefined = rows.find((candidate) => candidate.node.mission.id === cursor)?.node.mission.parentMissionId;
      if (parent === undefined || keep.has(parent)) break;
      cursor = parent;
    }
  }
  return rows.filter((row) => keep.has(row.node.mission.id));
}

export interface ChildSummary {
  readonly total: number;
  readonly running: number;
  readonly waiting: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
}

/** Counts a parent's children by what a person needs to know at a glance. */
export function summarizeChildren(root: MissionTreeNode): ChildSummary {
  const summary = { total: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const row of flattenTree(root).slice(1)) {
    const status = row.node.mission.status;
    summary.total += 1;
    if (status === "waiting_input" || status === "waiting_children") summary.waiting += 1;
    else if (status === "succeeded") summary.succeeded += 1;
    else if (status === "failed") summary.failed += 1;
    else if (status === "cancelled") summary.cancelled += 1;
    else summary.running += 1;
  }
  return summary;
}

/** Which operations the mission's own status allows. The authority enforces
 * the same table; showing a button it would refuse only teaches a person to
 * distrust the buttons that work. */
export function allowedOperations(mission: Pick<Mission, "status" | "activeRunId">): {
  readonly steer: boolean;
  readonly interrupt: boolean;
  readonly resume: boolean;
  readonly cancel: boolean;
  readonly answer: boolean;
} {
  const terminal = isTerminalMissionStatus(mission.status);
  return {
    steer: !terminal && (mission.status === "running" || mission.status === "waiting_children"),
    interrupt: !terminal && (mission.status === "running" || mission.status === "waiting_input" || mission.status === "waiting_children"),
    resume: mission.status === "interrupted",
    cancel: !terminal,
    answer: mission.status === "waiting_input",
  };
}

/** A restart left the mission's run in limbo, or a control action was recorded
 * without a confirmed native effect: only an explicit command settles it. */
export function needsReconcile(mission: Pick<Mission, "status">): boolean {
  return mission.status === "interrupted";
}

/** A short reason the composer is disabled, or `undefined` when it is open. */
export function composerBlocker(mission: Pick<Mission, "status">): string | undefined {
  if (isTerminalMissionStatus(mission.status)) return "该任务已结束，不能再追加指令。";
  if (mission.status === "interrupted") return "该任务已中断，先恢复再追加指令。";
  if (mission.status === "queued" || mission.status === "provisioning") return "该任务还在启动，暂时不能追加指令。";
  if (mission.status === "waiting_input") return "该任务在等你回答下面的问题。";
  return undefined;
}

/** The statuses a person sees in a filter chip, so a chip's count matches the
 * rows the same filter keeps. */
export function countForFilter(root: MissionTreeNode, filter: MissionFilter): number {
  return filterTree(root, filter).filter((row) => matchesFilter(row.node.mission.status, filter)).length;
}
