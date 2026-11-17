/**
 * The Hermes conversation: one mission's log as a chat, with the controls
 * that belong to it.
 *
 * The screen reads three things — the mission, its history and its tree — and
 * renders each of their four states separately, because a mission can be
 * readable while its history page fails. Acting never guesses a new revision:
 * after a command the screen refetches, and the live stream says when.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { Mission } from "../../../packages/agent-protocol/mission.ts";
import { cn } from "@/lib/cn";
import { missionStatusTone, statusLabel } from "../shared/status.ts";
import { StatusDot } from "../shared/StatusDot.tsx";
import { actionFailureMessage, useMission, useMissionHistory, useMissionTree } from "./foundation.ts";
import { buildFeed } from "./feed.ts";
import { ComposerBar, Feed } from "./feed-view.tsx";
import { allowedOperations, composerBlocker, summarizeChildren } from "./missions.ts";
import { commandId, missionActions } from "./actions.ts";
import type { MissionActions } from "./port.ts";
import { ErrorState, LoadableView, LoadingState, UnauthorizedState } from "./ui.tsx";

export interface HermesViewProps {
  readonly missionId: string | null;
  readonly actions?: MissionActions;
  readonly onSelectMission?: (missionId: string) => void;
  readonly liveStatus?: string;
}

/** One action in flight at a time per mission: a second press while the first
 * is unconfirmed would be a second command for the same intent. */
interface Pending {
  readonly kind: "steer" | "interrupt" | "resume" | "cancel" | "approval" | "answer";
  readonly approvalId?: string;
}

export function HermesView({ missionId, actions = missionActions, onSelectMission, liveStatus }: HermesViewProps): ReactNode {
  const mission = useMission(missionId);
  const history = useMissionHistory(missionId);
  const tree = useMissionTree(missionId);

  if (missionId === null) {
    return (
      <div className="flex min-h-0 flex-1" data-testid="hermes-view-empty">
        <EmptyConversation />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="hermes-view">
      <MissionHeader mission={mission} liveStatus={liveStatus} />
      {mission.status === "unauthorized" ? (
        <UnauthorizedState what="这段对话" />
      ) : (
        <ConversationBody
          mission={mission}
          history={history}
          tree={tree}
          actions={actions}
          {...(onSelectMission !== undefined ? { onSelectMission } : {})}
        />
      )}
    </div>
  );
}

function MissionHeader({ mission, liveStatus }: { readonly mission: ReturnType<typeof useMission>; readonly liveStatus: string | undefined }): ReactNode {
  return (
    <header className="flex shrink-0 flex-col gap-1.5 border-b border-hairline/30 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 truncate text-[13px] font-semibold text-ink">
          {mission.status === "ready" ? mission.data.title : "Hermes"}
        </h1>
        {mission.status === "ready" && (
          <>
            <span className="flex items-center gap-1">
              <StatusDot tone={missionStatusTone(mission.data.status)} />
              <span className="text-[10px] text-ink-secondary">{statusLabel(mission.data.status)}</span>
            </span>
            <span className="rounded-full bg-raised px-2 py-0.5 text-[10px] text-ink-secondary">{mission.data.agent}</span>
          </>
        )}
        {liveStatus !== undefined && liveStatus !== "open" && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px]",
              liveStatus === "retrying" ? "bg-warning/15 text-warning" : "bg-raised text-ink-secondary",
            )}
          >
            {liveStatus === "retrying" ? "正在重连" : "离线"}
          </span>
        )}
      </div>
      {mission.status === "ready" && mission.data.model !== undefined && (
        <p className="truncate text-[10px] text-ink-tertiary">
          模型：{mission.data.model.label ?? mission.data.model.model} · 环境：{mission.data.environment.label}
        </p>
      )}
    </header>
  );
}

function ConversationBody({
  mission,
  history,
  tree,
  actions,
  onSelectMission,
}: {
  readonly mission: ReturnType<typeof useMission>;
  readonly history: ReturnType<typeof useMissionHistory>;
  readonly tree: ReturnType<typeof useMissionTree>;
  readonly actions: MissionActions;
  readonly onSelectMission?: (missionId: string) => void;
}): ReactNode {
  if (mission.status === "loading") return <LoadingState label="正在读取任务" />;
  if (mission.status === "error") return <ErrorState message={mission.message} onRetry={mission.retry} />;
  if (mission.status !== "ready") return <UnauthorizedState what="这段对话" />;
  return (
    <ReadyConversation
      mission={mission.data}
      refreshMission={mission.refresh}
      history={history}
      tree={tree}
      actions={actions}
      {...(onSelectMission !== undefined ? { onSelectMission } : {})}
    />
  );
}

function ReadyConversation({
  mission,
  refreshMission,
  history,
  tree,
  actions,
  onSelectMission,
}: {
  readonly mission: Mission;
  readonly refreshMission: () => void;
  readonly history: ReturnType<typeof useMissionHistory>;
  readonly tree: ReturnType<typeof useMissionTree>;
  readonly actions: MissionActions;
  readonly onSelectMission?: (missionId: string) => void;
}): ReactNode {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string>("");
  const live = mission.status === "running" || mission.status === "resuming";

  const entries = history.status === "ready" ? history.data.events : [];
  const items = useMemo(() => buildFeed(entries, { prompt: mission.prompt, promptAt: mission.acceptedAt, live }), [entries, mission.prompt, mission.acceptedAt, live]);
  const operations = allowedOperations(mission);
  const blocker = composerBlocker(mission);

  const run = useCallback(
    async (action: Pending, send: () => Promise<unknown>, done: string) => {
      if (pending !== null) return;
      setPending(action);
      setFailure(null);
      try {
        await send();
        setAnnouncement(done);
        refreshMission();
        if (history.status === "ready") history.refresh();
      } catch (error) {
        setFailure(actionFailureMessage(error));
      } finally {
        setPending(null);
      }
    },
    [pending, refreshMission, history],
  );

  const send = (): void => {
    const input = draft.trim();
    if (input.length === 0) return;
    void run(
      { kind: "steer" },
      () => actions.steer(mission.id, input, { commandId: commandId(), expectedRevision: mission.revision }),
      "指令已送达",
    ).then(() => setDraft(""));
  };

  return (
    <>
      {tree.status === "ready" && tree.data.children.length > 0 && (
        <ChildSummaryRow tree={tree.data} {...(onSelectMission !== undefined ? { onSelectMission } : {})} />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <LoadableView state={history} label="正在读取对话记录" what="这段对话">
          {() => <Feed items={items} live={live} {...feedHandlers(mission, actions, run, pending)} />}
        </LoadableView>
      </div>

      {failure !== null && (
        <div role="alert" className="px-4 pb-2">
          <p className="text-[11px] text-danger">{failure}</p>
        </div>
      )}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <footer className="shrink-0 border-t border-hairline/30 px-4 py-3">
        <ComposerBar
          value={draft}
          onChange={setDraft}
          onSend={send}
          {...(blocker !== undefined ? { disabledReason: blocker } : {})}
          isBusy={pending?.kind === "steer"}
          canInterrupt={operations.interrupt}
          onInterrupt={() =>
            void run(
              { kind: "interrupt" },
              () => actions.interrupt(mission.id, { commandId: commandId(), expectedRevision: mission.revision }),
              "已请求中断",
            )
          }
          canResume={operations.resume}
          onResume={() =>
            void run(
              { kind: "resume" },
              () => actions.resume(mission.id, { commandId: commandId(), expectedRevision: mission.revision }),
              "已请求恢复",
            )
          }
          canCancel={operations.cancel}
          onCancel={() =>
            void run(
              { kind: "cancel" },
              () => actions.cancel(mission.id, { commandId: commandId(), expectedRevision: mission.revision }, { cascade: true }),
              "已请求取消",
            )
          }
        />
      </footer>
    </>
  );
}

function feedHandlers(
  mission: Mission,
  actions: MissionActions,
  run: (action: Pending, send: () => Promise<unknown>, done: string) => Promise<void>,
  pending: Pending | null,
): {
  onDecide: (approvalId: string, decision: "allow" | "deny" | "answer", answer?: string) => void;
  onAnswerQuestion: (answer: string) => void;
  busyApprovalId?: string;
} {
  return {
    onDecide: (approvalId, decision, answer) => {
      void run(
        { kind: "approval", approvalId },
        () =>
          actions.resolve({
            missionId: mission.id,
            approvalId,
            decision,
            commandId: commandId(),
            expectedRevision: mission.revision,
            ...(answer !== undefined ? { answer } : {}),
          }),
        decision === "allow" ? "已允许" : decision === "deny" ? "已拒绝" : "已回答",
      );
    },
    onAnswerQuestion: (answer) => {
      void run(
        { kind: "answer" },
        () => actions.submitInput(mission.id, answer, { commandId: commandId(), expectedRevision: mission.revision }),
        "已回答",
      );
    },
    ...(pending?.kind === "approval" && pending.approvalId !== undefined ? { busyApprovalId: pending.approvalId } : {}),
  };
}

const CHILD_BADGES: Readonly<Record<"running" | "waiting" | "failed" | "succeeded" | "cancelled", string>> = {
  running: "bg-accent/15 text-accent",
  waiting: "bg-warning/15 text-warning",
  failed: "bg-danger/15 text-danger",
  succeeded: "bg-success/15 text-success",
  cancelled: "bg-raised text-ink-secondary",
};

function ChildSummaryRow({ tree, onSelectMission }: { readonly tree: Parameters<typeof summarizeChildren>[0]; readonly onSelectMission?: (missionId: string) => void }): ReactNode {
  const summary = summarizeChildren(tree);
  const counts = [
    ["running", `进行中 ${summary.running}`],
    ["waiting", `等你 ${summary.waiting}`],
    ["failed", `失败 ${summary.failed}`],
    ["succeeded", `完成 ${summary.succeeded}`],
    ["cancelled", `取消 ${summary.cancelled}`],
  ] as const;
  return (
    <div className="shrink-0 border-b border-hairline/30 px-4 py-2" data-testid="child-summary">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-ink-secondary">子任务 {summary.total}</span>
        {counts.map(([key, label]) =>
          summary[key] > 0 ? (
            <span key={key} className={cn("rounded-full px-2 py-0.5 text-[10px]", CHILD_BADGES[key])}>
              {label}
            </span>
          ) : null,
        )}
      </div>
      {onSelectMission !== undefined && summary.total > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {tree.children.map((child) => (
            <button
              key={child.mission.id}
              type="button"
              onClick={() => onSelectMission(child.mission.id)}
              className="cursor-pointer rounded-full px-2 py-0.5 text-[11px] text-ink-secondary transition-colors duration-150 hover:bg-raised hover:text-ink"
            >
              {child.mission.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyConversation(): ReactNode {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center" data-testid="hermes-view-idle">
      <p className="text-[12px] font-medium text-ink">还没有选中的任务</p>
      <p className="text-[11px] text-ink-secondary">在左侧任务列表里选一个，或新建一个任务交给 Hermes。</p>
    </div>
  );
}
