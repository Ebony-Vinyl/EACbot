/**
 * The task centre: every mission in one tree, filtered by what a person needs
 * to act on now.
 *
 * The tree is built from `listMissions`, which returns every mission; a
 * mission whose parent is not in the list becomes its own root rather than
 * disappearing, because a list that hides a task is worse than one that shows
 * it at the wrong depth.
 */
import { useMemo, useState, type ReactNode } from "react";

import type { Mission, MissionTreeNode } from "../../../packages/agent-protocol/mission.ts";
import { isTerminalMissionStatus } from "../../../packages/agent-protocol/mission-status.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { missionStatusTone, statusLabel } from "../shared/status.ts";
import { StatusDot } from "../shared/StatusDot.tsx";
import { useMissions } from "./foundation.ts";
import { ChoiceGroup } from "./ChoiceGroup.tsx";
import { FILTER_LABELS, MISSION_FILTERS, countForFilter, filterTree, needsReconcile, type MissionFilter } from "./missions.ts";
import { LoadableView } from "./ui.tsx";

/** Groups a flat mission list into trees. A mission whose parent is missing is
 * promoted to a root, and a cycle is broken rather than followed. */
export function buildForest(missions: readonly Mission[]): MissionTreeNode[] {
  const children = new Map<string, MissionTreeNode[]>();
  const nodes = new Map<string, MissionTreeNode>();
  for (const mission of missions) {
    const list: MissionTreeNode[] = [];
    children.set(mission.id, list);
    nodes.set(mission.id, { mission, children: list });
  }
  const roots: MissionTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.mission.parentMissionId;
    const parent = parentId === undefined ? undefined : nodes.get(parentId);
    if (parent === undefined || parent === node || reaches(node.mission.id, parent, nodes)) roots.push(node);
    else children.get(parent.mission.id)!.push(node);
  }
  return roots;
}

/** Whether walking up from `candidate` reaches `target`, which would make
 * attaching them a cycle. */
function reaches(target: string, candidate: MissionTreeNode, byId: ReadonlyMap<string, MissionTreeNode>): boolean {
  const seen = new Set<string>();
  let cursor: MissionTreeNode | undefined = candidate;
  while (cursor !== undefined && !seen.has(cursor.mission.id)) {
    if (cursor.mission.id === target) return true;
    seen.add(cursor.mission.id);
    const parentId: string | undefined = cursor.mission.parentMissionId;
    cursor = parentId === undefined ? undefined : byId.get(parentId);
  }
  return false;
}

export interface MissionCenterProps {
  readonly selectedId: string | null;
  readonly onSelect: (missionId: string) => void;
  readonly onCreate?: () => void;
}

export function MissionCenter({ selectedId, onSelect, onCreate }: MissionCenterProps): ReactNode {
  const missions = useMissions();
  const [filter, setFilter] = useState<MissionFilter>("active");

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="mission-center">
      <header className="flex shrink-0 flex-col gap-2 border-b border-hairline/30 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">任务</h1>
          {onCreate !== undefined && (
            <Button variant="primary" size="sm" onClick={onCreate}>
              新建任务
            </Button>
          )}
        </div>
        <ChoiceGroup
          label="按状态筛选"
          value={filter}
          options={MISSION_FILTERS.map((option) => ({ value: option, label: FILTER_LABELS[option] }))}
          onChange={setFilter}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <LoadableView state={missions} label="正在读取任务" what="任务列表">
          {(data) => <ForestView missions={data} filter={filter} selectedId={selectedId} onSelect={onSelect} />}
        </LoadableView>
      </div>
    </div>
  );
}

function ForestView({
  missions,
  filter,
  selectedId,
  onSelect,
}: {
  readonly missions: readonly Mission[];
  readonly filter: MissionFilter;
  readonly selectedId: string | null;
  readonly onSelect: (missionId: string) => void;
}): ReactNode {
  const forest = useMemo(() => buildForest(missions), [missions]);
  const total = forest.reduce((count, root) => count + countForFilter(root, filter), 0);

  if (forest.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 py-16 text-center" data-testid="mission-center-empty">
        <p className="text-[12px] font-medium text-ink">还没有任务</p>
        <p className="max-w-[34rem] text-[11px] leading-relaxed text-ink-secondary">
          交给 Hermes 一件事，它会把工作拆成任务，并在这里显示每一层的进度。
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="mission-forest">
      <p className="text-[10px] text-ink-secondary">
        {total} 个任务符合“{FILTER_LABELS[filter]}”
      </p>
      {forest.map((root) => (
        <MissionBranch key={root.mission.id} root={root} filter={filter} selectedId={selectedId} onSelect={onSelect} />
      ))}
      {total === 0 && (
        <p className="text-[11px] text-ink-secondary" data-testid="mission-filter-empty">
          这个筛选下没有任务。切换到“全部”可以看到所有任务。
        </p>
      )}
    </div>
  );
}

function MissionBranch({
  root,
  filter,
  selectedId,
  onSelect,
}: {
  readonly root: MissionTreeNode;
  readonly filter: MissionFilter;
  readonly selectedId: string | null;
  readonly onSelect: (missionId: string) => void;
}): ReactNode {
  const rows = filterTree(root, filter);
  if (rows.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-0.5 rounded-xl border border-hairline/30 bg-inset/50 p-1.5"
      data-testid={`mission-branch-${root.mission.id}`}
    >
      {rows.map((row) => (
        <MissionRow
          key={row.node.mission.id}
          mission={row.node.mission}
          depth={row.depth}
          childCount={row.node.children.length}
          selected={row.node.mission.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function MissionRow({
  mission,
  depth,
  childCount,
  selected,
  onSelect,
}: {
  readonly mission: Mission;
  readonly depth: number;
  readonly childCount: number;
  readonly selected: boolean;
  readonly onSelect: (missionId: string) => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={() => onSelect(mission.id)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150",
        selected ? "bg-raised" : "hover:bg-raised/60",
      )}
      style={{ paddingInlineStart: `${8 + depth * 14}px` }}
      data-testid={`mission-row-${mission.id}`}
    >
      <span className="mt-1.5">
        <StatusDot tone={missionStatusTone(mission.status)} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] text-ink">{mission.title}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-ink-secondary">
          <span>{statusLabel(mission.status)}</span>
          <span>·</span>
          <span className="font-mono">{mission.agent}</span>
          {childCount > 0 && (
            <>
              <span>·</span>
              <span>{childCount} 个子任务</span>
            </>
          )}
        </span>
      </span>
      {needsReconcile(mission) && (
        <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] text-warning">需对账</span>
      )}
      {isTerminalMissionStatus(mission.status) && (
        <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-[10px] text-ink-secondary">已结束</span>
      )}
    </button>
  );
}

export interface MissionDetailProps {
  readonly mission: Mission | null;
  readonly childSummary: { readonly total: number; readonly running: number; readonly waiting: number; readonly succeeded: number; readonly failed: number; readonly cancelled: number };
  readonly onResume: () => void;
  readonly onCancel: () => void;
  readonly onReconcile: () => void;
  readonly busy: boolean;
}

/** The detail pane beside the tree: what a mission is, and the operations its
 * status allows. */
export function MissionDetail({ mission, childSummary, onResume, onCancel, onReconcile, busy }: MissionDetailProps): ReactNode {
  if (mission === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center" data-testid="mission-detail-empty">
        <p className="text-[11px] text-ink-secondary">选一个任务看详情。</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5 p-4" data-testid="mission-detail">
      <h2 className="break-words text-[13px] font-semibold text-ink">{mission.title}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot tone={missionStatusTone(mission.status)} />
        <span className="text-[10px] text-ink-secondary">{statusLabel(mission.status)}</span>
        <span className="rounded-full bg-raised px-2 py-0.5 text-[10px] text-ink-secondary">{mission.agent}</span>
        {mission.model !== undefined && (
          <span className="rounded-full bg-raised px-2 py-0.5 text-[10px] text-ink-secondary">
            {mission.model.label ?? mission.model.model}
          </span>
        )}
      </div>
      <hr className="border-hairline/30" />
      <dl className="m-0 flex flex-col gap-1 text-[11px]">
        <Row label="环境" value={mission.environment.label} />
        <Row label="创建" value={mission.createdAt} />
        <Row label="更新" value={mission.updatedAt} />
        <Row label="修订" value={String(mission.revision)} />
        <Row label="运行次数" value={String(mission.runIds.length)} />
        {childSummary.total > 0 && (
          <Row
            label="子任务"
            value={`${childSummary.total} 个 · 进行中 ${childSummary.running} · 等你 ${childSummary.waiting} · 失败 ${childSummary.failed}`}
          />
        )}
      </dl>
      {mission.error !== undefined && <p className="text-[11px] text-danger">{mission.error.message}</p>}
      {mission.cancelReason !== undefined && (
        <p className="text-[10px] text-ink-secondary">取消原因：{mission.cancelReason}</p>
      )}
      <hr className="border-hairline/30" />
      <div className="flex flex-wrap items-center gap-1.5">
        {mission.status === "interrupted" && (
          <Button variant="primary" size="sm" disabled={busy} onClick={onResume}>
            恢复
          </Button>
        )}
        {needsReconcile(mission) && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onReconcile}>
            对账运行
          </Button>
        )}
        {!isTerminalMissionStatus(mission.status) && (
          <Button variant="danger" size="sm" disabled={busy} onClick={onCancel}>
            取消任务
          </Button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-ink-secondary">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-ink">{value}</dd>
    </div>
  );
}
