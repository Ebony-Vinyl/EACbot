/**
 * The Personal Agent page: the task tree on the left, the conversation in the
 * middle, and the selected mission's detail beside it.
 *
 * A phone does not get the same three columns. Narrow screens show one place
 * at a time — the tree, then the conversation — because three columns at phone
 * width leaves each of them unusable.
 */
import { useCallback, useState, type ReactNode } from "react";

import type { Mission } from "../../../packages/agent-protocol/mission.ts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { useEnvironments, useMissionTree, useNotifications } from "./foundation.ts";
import { ChoiceGroup } from "./ChoiceGroup.tsx";
import { HermesView } from "./HermesView.tsx";
import { MissionCenter, MissionDetail } from "./MissionCenter.tsx";
import { CreateMission } from "./CreateMission.tsx";
import { missionActions } from "./actions.ts";
import { summarizeChildren } from "./missions.ts";
import { actionFailureMessage } from "./foundation.ts";
import type { ReconcileInput } from "./port.ts";

type Place = "tree" | "conversation";

const selectClass =
  "rounded-lg border border-hairline/40 bg-app px-2.5 py-1.5 text-[12px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/60";
const textareaClass =
  "w-full resize-y rounded-lg border border-hairline/40 bg-app px-2.5 py-1.5 text-[12px] leading-5 text-ink outline-none placeholder:text-ink-secondary focus:ring-1 focus:ring-accent/60";

export function PersonalAgentPage(): ReactNode {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [place, setPlace] = useState<Place>("tree");
  const [reconciling, setReconciling] = useState<Mission | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const environments = useEnvironments();
  const tree = useMissionTree(selectedId);
  const [version, setVersion] = useState(0);

  // A notification is a hint to read again, so the page bumps a version the
  // reads depend on rather than trusting the notification as state.
  useNotifications((notification) => {
    if (notification.kind === "stream.resync" || notification.missionId === undefined || notification.missionId === selectedId) {
      setVersion((previous) => previous + 1);
    }
  });

  const select = useCallback((missionId: string) => {
    setSelectedId(missionId);
    setCreating(false);
    setPlace("conversation");
  }, []);

  const first = environments.status === "ready" ? environments.data[0] : undefined;
  const environment = first === undefined ? null : { id: first.id, label: first.label };

  const operate = async (run: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await run();
      setVersion((previous) => previous + 1);
    } catch (error) {
      setFailure(actionFailureMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const selectedMission = tree.status === "ready" ? tree.data.mission : null;

  return (
    <div className="flex h-full min-h-0" data-testid="personal-agent-page" data-version={version}>
      <div className="hidden min-h-0 w-[320px] shrink-0 border-e border-hairline/30 md:flex md:flex-col">
        <MissionCenter
          selectedId={selectedId}
          onSelect={select}
          onCreate={() => {
            setCreating(true);
            setPlace("conversation");
          }}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-hairline/30 px-3 py-2 md:hidden">
          <ChoiceGroup
            label="切换"
            value={place}
            options={[{ value: "tree" as const, label: "任务" }, { value: "conversation" as const, label: "对话" }]}
            onChange={setPlace}
          />
        </div>

        {place === "tree" && (
          <div className="min-h-0 flex-1 md:hidden">
            <MissionCenter selectedId={selectedId} onSelect={select} onCreate={() => setCreating(true)} />
          </div>
        )}

        <div className={cn("min-h-0 flex-1", place === "conversation" ? "flex flex-col" : "hidden md:flex md:flex-col")}>
          {creating ? (
            <div className="p-4">
              <CreateMission
                environment={environment}
                onCreated={(missionId) => {
                  setCreating(false);
                  select(missionId);
                }}
                onCancel={() => setCreating(false)}
              />
            </div>
          ) : (
            <HermesView missionId={selectedId} onSelectMission={select} />
          )}
        </div>
      </div>

      <div className="hidden min-h-0 w-[300px] shrink-0 border-s border-hairline/30 lg:flex lg:flex-col">
        {selectedMission !== null && (
          <MissionDetail
            mission={selectedMission}
            childSummary={tree.status === "ready" ? summarizeChildren(tree.data) : summarizeChildren({ mission: selectedMission, children: [] })}
            busy={busy}
            onResume={() =>
              void operate(() =>
                missionActions.resume(selectedMission.id, { commandId: crypto.randomUUID(), expectedRevision: selectedMission.revision }),
              )
            }
            onCancel={() =>
              void operate(() =>
                missionActions.cancel(selectedMission.id, { commandId: crypto.randomUUID(), expectedRevision: selectedMission.revision }, { cascade: true }),
              )
            }
            onReconcile={() => setReconciling(selectedMission)}
          />
        )}
        {failure !== null && (
          <p role="alert" className="px-4 pb-2 text-[10px] text-danger">
            {failure}
          </p>
        )}
      </div>

      {reconciling !== null && (
        <ReconcileDialog
          mission={reconciling}
          onClose={() => setReconciling(null)}
          onSubmit={(input) => {
            const target = reconciling;
            void operate(() => missionActions.reconcile(target.id, { ...input, commandId: crypto.randomUUID(), expectedRevision: target.revision })).then(() =>
              setReconciling(null),
            );
          }}
        />
      )}
    </div>
  );
}

const RECONCILE_CHOICES = [
  { value: "start", label: "启动这个 run", detail: "它被接受了但从未开始。" },
  { value: "resume", label: "从原生会话恢复", detail: "原生会话可能还在，继续它。" },
  { value: "cancel", label: "重试取消", detail: "上一次取消没有确认到原生端。" },
  { value: "abandon", label: "标记为失败", detail: "不再重放，把它结束掉。" },
] as const;

/** The reconcile dialog. Nothing is replayed on its own: a person names the
 * run and the action, because guessing would either double-run work or
 * silently drop it. */
export function ReconcileDialog({
  mission,
  onClose,
  onSubmit,
}: {
  readonly mission: Mission;
  readonly onClose: () => void;
  readonly onSubmit: (input: Omit<ReconcileInput, "commandId" | "expectedRevision">) => void;
}): ReactNode {
  const runId = mission.activeRunId ?? mission.runIds[mission.runIds.length - 1] ?? "";
  const [action, setAction] = useState<(typeof RECONCILE_CHOICES)[number]["value"]>("cancel");
  const [reason, setReason] = useState("");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[520px]">
        <DialogTitle>对账这个运行</DialogTitle>
        <div className="mt-3 flex flex-col gap-3" data-testid="reconcile-dialog">
          <p className="text-[11px] leading-relaxed text-ink-secondary">
            重启之后，这个任务的运行状态需要在原生端确认。选择一个动作，它只会执行一次。
          </p>
          <Field label="动作">
            <select
              value={action}
              onChange={(event) => setAction(event.currentTarget.value as typeof action)}
              className={cn(selectClass, "w-full")}
            >
              {RECONCILE_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label} —— {choice.detail}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-ink-secondary">原因（可选）</span>
            <textarea
              className={textareaClass}
              value={reason}
              rows={2}
              placeholder="例如：主机重启过"
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </label>
          <p className="break-all font-mono text-[10px] text-ink-secondary">
            run {runId.length > 0 ? runId : "（没有记录的运行）"}
          </p>
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={runId.length === 0}
              onClick={() => onSubmit({ runId, action, ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}) })}
            >
              执行
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
