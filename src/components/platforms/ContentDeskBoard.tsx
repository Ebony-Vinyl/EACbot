// The board a content platform gets: a desk of collected content, a publishing rule, and the web line's health.
// Xiaohongshu and Douyin have the same shape, so they share this component; a platform that answers the shared
// contract gets it for free, and a platform that needs a different body writes its own.
import { useCallback, useEffect, useState } from "react";

import { Loader2 } from "lucide-react";

import type { PlatformId } from "../../../shared/plugins/accounts";
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
  LoadingRow,
  Notice,
  SectionCard,
  StatStrip,
  useActionConfirm,
  usePlatformBoard,
} from "./kit";

const PUBLISHER: Partial<Record<PlatformId, string>> = {
  xiaohongshu: "eac.xiaohongshu",
  douyin: "eac.douyin",
};

/** A content desk's board: the same frame for every platform that publishes rather than answers. */
export function ContentDeskBoard({ platform, title, onBack }: { platform: PlatformId; title: string; onBack(): void }) {
  const { board, error, loading, busyAction, notice, load, run } = usePlatformBoard(platform);
  const confirm = useActionConfirm();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const answer = await api<{ plugins: Array<{ pluginId: string; installationId: string }> }>("/api/plugins", { background: true });
      const plugin = (answer.plugins ?? []).find((entry) => entry.pluginId === PUBLISHER[platform]);
      if (!plugin) {
        setConnected(null);
        setStatusError(t("platforms.state.missing"));
        return;
      }
      const detail = await api<{ status: { values?: Record<string, unknown>; error?: string } }>(`/api/plugins/${plugin.installationId}/status`, { background: true });
      setStatusError(detail.status.error ?? null);
      setConnected(detail.status.values?.connected === true);
    } catch (reason) {
      setStatusError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [platform]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      {board?.account ? (
        <>
          <span className="truncate text-[12px] text-ink-secondary">{board.account.displayName}</span>
          <span className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            connected ? "bg-success/15 text-success" : "bg-raised text-ink-secondary",
          )}>
            {connected ? t("platforms.state.ready") : t("platforms.state.unavailable")}
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
        title={title}
        subtitle={board?.account?.displayName ?? undefined}
        account={header}
        busy={loading}
        onRefresh={() => { void load(true); void loadStatus(); }}
        onBack={onBack}
      >
        {error && <ErrorNotice error={error} onRetry={() => void load(true)} />}
        {notice && <Notice tone="warning" text={notice} />}
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
