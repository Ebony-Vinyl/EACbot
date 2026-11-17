/** The mission tree a person reads: the root, its children, and how the
 * workbench walks between them.
 *
 * Only the mission authority decides who is whose child. This module arranges
 * what a snapshot already says; it never infers a parent from a run, a
 * terminal or an event. */

import type { Mission, MissionSummary } from "../../../packages/agent-protocol/mission.ts";
import { isActive, needsInput, sortMissions } from "./status.ts";

export interface MissionNode<T extends MissionLike = MissionLike> {
  readonly mission: T;
  readonly children: readonly MissionNode<T>[];
  readonly depth: number;
}

export type MissionLike = Pick<
  Mission,
  "id" | "rootMissionId" | "parentMissionId" | "title" | "agent" | "status" | "revision" | "updatedAt"
>;

/** A mission and everything below it, ordered by the same rule as the list.
 * A child whose parent is absent from the snapshot stays at the top level, so
 * no mission silently disappears. */
export function buildTree<T extends MissionLike>(missions: readonly T[], rootId?: string): MissionNode<T>[] {
  const byId = new Map<string, T>(missions.map((mission) => [mission.id, mission]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const mission of missions) {
    const parent = mission.parentMissionId;
    if (parent !== undefined && parent !== mission.id && byId.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(mission);
      children.set(parent, list);
    } else {
      roots.push(mission);
    }
  }
  const build = (mission: T, depth: number): MissionNode<T> => ({
    mission,
    depth,
    children: sortMissions(children.get(mission.id) ?? []).map((child) => build(child, depth + 1)),
  });
  const ordered = rootId !== undefined ? roots.filter((mission) => mission.id === rootId) : roots;
  return sortMissions(ordered).map((mission) => build(mission, 0));
}

/** The chain from the root down to `id`, for a breadcrumb. Empty when the
 * mission is not in the snapshot. */
export function ancestry<T extends MissionLike>(missions: readonly T[], id: string): T[] {
  const byId = new Map<string, T>(missions.map((mission) => [mission.id, mission]));
  const chain: T[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentMissionId === undefined ? undefined : byId.get(current.parentMissionId);
  }
  return chain;
}

/** Flattens the tree in reading order, for a list that keeps its indentation. */
export function flatten<T extends MissionLike>(nodes: readonly MissionNode<T>[]): MissionNode<T>[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

export interface MissionCounts {
  readonly total: number;
  readonly needsInput: number;
  readonly active: number;
}

export function countMissions(missions: readonly MissionLike[]): MissionCounts {
  return {
    total: missions.length,
    needsInput: missions.filter(needsInput).length,
    active: missions.filter(isActive).length,
  };
}

/** The summary a tab strip shows, so the strip does not hold whole missions. */
export function toSummary(mission: MissionLike): MissionSummary {
  return {
    id: mission.id,
    rootMissionId: mission.rootMissionId,
    ...(mission.parentMissionId !== undefined ? { parentMissionId: mission.parentMissionId } : {}),
    title: mission.title,
    agent: mission.agent,
    status: mission.status,
    revision: mission.revision,
    updatedAt: mission.updatedAt,
  };
}

/** The mission whose tab should be selected when the current one disappears:
 * the nearest neighbour in strip order, then the first, then none. */
export function neighbourMission(open: readonly string[], removed: string): string | null {
  const at = open.indexOf(removed);
  const rest = open.filter((id) => id !== removed);
  if (rest.length === 0) return null;
  if (at < 0) return rest[0] ?? null;
  return rest[Math.min(at, rest.length - 1)] ?? null;
}
