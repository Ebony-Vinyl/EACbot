// The Tieba board. It is the generic board plus the one thing only this platform has: the web line's health,
// because Tieba has no API and every capability depends on a page that still matches.
import { useCallback, useEffect, useState } from "react";

import { Loader2 } from "lucide-react";

import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  ActionConfirmDialog,
  ActionRow,
  BoardBody,
  BoardShell,
  CapabilityList,
  ErrorNotice,
  LimitBars,
  LoadingRow,
  Notice,
  SectionCard,
  StatStrip,
  useActionConfirm,
  usePlatformBoard,
} from "./kit";

interface TiebaStatus {
  connected?: boolean;
  webState?: string;
  inboxQueued?: number;
  inboxDelivered?: number;
  inboxRefused?: number;
  outboxPending?: number;
  lastError?: string;
}

export function TiebaBoard({ onBack }: { onBack(): void }) {
  const { board, error, loading, busyAction, notice, load, run } = usePlatformBoard("tieba");
  const confirm = useActionConfirm();
  const [status, setStatus] = useState<TiebaStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const answer = await api<{ plugins: Array<{ pluginId: string; installationId: string }> }>("/api/plugins", { background: true });
      const plugin = (answer.plugins ?? []).find((entry) => entry.pluginId === "eac.tieba");
      if (!plugin) {
        setStatus(null);
        setStatusError(t("platforms.state.missing"));
        return;
      }
      const detail = await api<{ status: { values?: Record<string, unknown>; error?: string } }>(`/api/plugins/${plugin.installationId}/status`, { background: true });
      const values = detail.status.values ?? {};
      setStatusError(detail.status.error ?? null);
      setStatus({
        connected: values.connected === true,
        webState: String(values.webState ?? ""),
        inboxQueued: Number(values.inboxQueued ?? 0),
        inboxDelivered: Number(values.inboxDelivered ?? 0),
        inboxRefused: Number(values.inboxRefused ?? 0),
        outboxPending: Number(values.outboxPending ?? 0),
        lastError: String(values.lastError ?? ""),
      });
    } catch (reason) {
      setStatusError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      {board?.account ? (
        <>
          <span className="truncate text-[12px] text-ink-secondary">{board.account.displayName}</span>
          <span className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            status?.connected ? "bg-success/15 text-success" : "bg-raised text-ink-secondary",
          )}>
            {status?.connected ? t("platforms.state.ready") : t("platforms.state.unavailable")}
          </span>
        </>
      ) : (
        <span className="truncate text-[12px] text-ink-secondary">{t("platforms.center.none")}</span>
      )}
    </div>
  );

  return (
    <>
      <BoardShell
        title="贴吧"
        subtitle={board?.account?.displayName ?? undefined}
        account={header}
        busy={loading}
        onRefresh={() => { void load(true); void loadStatus(); }}
        onBack={onBack}
      >
        {error && <ErrorNotice error={error} onRetry={() => void load(true)} />}
        {notice && <Notice tone="warning" text={notice} />}

        {status && (
          <SectionCard title={t("platforms.tieba.web")} hint={status.webState}>
            <div className="flex flex-col gap-2">
              {status.lastError && <p className="text-[11px] text-danger">{status.lastError}</p>}
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  { label: t("platforms.xianyu.queued"), value: status.inboxQueued ?? 0 },
                  { label: t("platforms.xianyu.delivered"), value: status.inboxDelivered ?? 0 },
                  { label: t("platforms.xianyu.refused"), value: status.inboxRefused ?? 0 },
                  { label: t("platforms.xianyu.pendingReplies"), value: status.outboxPending ?? 0 },
                ].map((item) => (
                  <div key={item.label} className="rounded-lg bg-app px-2 py-1.5">
                    <dt className="truncate text-[10px] uppercase tracking-wide text-ink-secondary">{item.label}</dt>
                    <dd className="text-[16px] font-semibold tabular-nums text-ink">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </SectionCard>
        )}
        {statusError && <ErrorNotice error={statusError} onRetry={() => void loadStatus()} />}

        {loading && !board ? <LoadingRow /> : board && (
          <>
            <StatStrip items={board.headline} />
            <BoardBody
              sections={board.sections}
              busyAction={busyAction}
              onQueueAction={(itemId, actionId) => void run(actionId, { itemId })}
              onSubmitForm={(action, values) => void run(action, values)}
            />
            {board.actions.length > 0 && (
              <SectionCard title={t("platforms.xianyu.actions")}>
                <div className="flex flex-col gap-1.5">
                  {board.actions.map((action) => (
                    <ActionRow
                      key={action.id}
                      action={action}
                      busy={busyAction === action.id}
                      onRun={(chosen) => confirm.request(chosen, () => void run(chosen.id))}
                    />
                  ))}
                </div>
              </SectionCard>
            )}
            {board.limits.length > 0 && (
              <SectionCard title={t("platforms.xianyu.limits")}>
                <LimitBars items={board.limits} />
              </SectionCard>
            )}
            {board.capability.length > 0 && (
              <SectionCard title={t("platforms.xianyu.capability")}>
                <CapabilityList items={board.capability} />
              </SectionCard>
            )}
          </>
        )}
        {loading && board && (
          <p className="flex items-center gap-1.5 text-[11px] text-ink-secondary"><Loader2 size={12} className="animate-spin" />{t("platforms.loading")}</p>
        )}
      </BoardShell>
      <ActionConfirmDialog ask={confirm.ask} onCancel={confirm.cancel} onConfirm={confirm.confirm} />
    </>
  );
}
