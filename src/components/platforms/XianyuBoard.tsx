// The Xianyu board. It is the generic board plus the two things only this platform has: which transport line is
// live, and the reply desk that decides what an answer is made of. Everything else — rules, queue, audit and
// capability list — comes from the plugin's own board answer, so the business stays in one place.
import { useCallback, useEffect, useState } from "react";

import { Loader2 } from "lucide-react";

import type { BoardSection } from "../../../shared/plugins/boards";
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
  Segmented,
  StatStrip,
  useActionConfirm,
  usePlatformBoard,
} from "./kit";

/** The plugin's own `status` method: which line runs, and what each line last saw. */
interface XianyuStatus {
  transportMode?: string;
  transportLive?: string;
  protocolState?: string;
  webState?: string;
  connected?: boolean;
  inboxQueued?: number;
  inboxDelivered?: number;
  inboxRefused?: number;
  outboxSent?: number;
  outboxPending?: number;
  rulesEnabled?: boolean;
  maxRepliesPerDay?: number;
  repliesToday?: number;
  lastError?: string;
}

const LINE_TONE = (state: string | undefined) => state === "up" || state === "connected"
  ? "bg-success/15 text-success"
  : state === "failed" ? "bg-danger/15 text-danger" : "bg-raised text-ink-secondary";

/** The board above already draws the transport lines, so the plugin's own notice for them would say it twice. */
const ownSections = (sections: BoardSection[] | undefined) => (sections ?? []).filter((section) => section.id !== "transport");

export function XianyuBoard({ onBack }: { onBack(): void }) {
  const { board, error, loading, busyAction, notice, load, run } = usePlatformBoard("xianyu");
  const confirm = useActionConfirm();
  const [status, setStatus] = useState<XianyuStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [transport, setTransport] = useState<string>("");

  const loadStatus = useCallback(async () => {
    try {
      const answer = await api<{ plugins: Array<{ pluginId: string; installationId: string }> }>("/api/plugins", { background: true });
      const plugin = (answer.plugins ?? []).find((entry) => entry.pluginId === "eac.xianyu");
      if (!plugin) {
        setStatus(null);
        setStatusError(t("platforms.state.missing"));
        return;
      }
      const detail = await api<{ status: { values?: Record<string, unknown>; error?: string } }>(`/api/plugins/${plugin.installationId}/status`, { background: true });
      const values = detail.status.values ?? {};
      setStatusError(detail.status.error ?? null);
      setStatus({
        transportMode: String(values.transportMode ?? ""),
        transportLive: String(values.transportLive ?? ""),
        protocolState: String(values.protocolState ?? ""),
        webState: String(values.webState ?? ""),
        connected: values.connected === true,
        inboxQueued: Number(values.inboxQueued ?? 0),
        inboxDelivered: Number(values.inboxDelivered ?? 0),
        inboxRefused: Number(values.inboxRefused ?? 0),
        outboxSent: Number(values.outboxSent ?? 0),
        outboxPending: Number(values.outboxPending ?? 0),
        rulesEnabled: values.rulesEnabled === true,
        maxRepliesPerDay: Number(values.maxRepliesPerDay ?? 0),
        repliesToday: Number(values.repliesToday ?? 0),
        lastError: String(values.lastError ?? ""),
      });
      setTransport(String(values.transportMode ?? ""));
    } catch (reason) {
      setStatusError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const refresh = () => {
    void load(true);
    void loadStatus();
  };

  const switchTransport = async (next: string) => {
    setTransport(next);
    await run("set-transport", { transport: next });
    void loadStatus();
  };

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      {board?.account ? (
        <>
          <span className="truncate text-[12px] text-ink-secondary">{board.account.displayName}</span>
          <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", LINE_TONE(status?.connected ? "connected" : "down"))}>
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
        title="闲鱼"
        subtitle={board?.account?.displayName ?? undefined}
        account={header}
        busy={loading}
        onRefresh={refresh}
        onBack={onBack}
      >
        {error && <ErrorNotice error={error} onRetry={() => void load(true)} />}
        {notice && <Notice tone="warning" text={notice} />}

        {status && (
          <SectionCard title={t("platforms.xianyu.lines")} hint={status.transportMode}>
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", LINE_TONE(status.protocolState))}>
                  {t("platforms.xianyu.protocol")} · {status.protocolState || "down"}
                </span>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", LINE_TONE(status.webState))}>
                  {t("platforms.xianyu.web")} · {status.webState || "unknown"}
                </span>
                <span className="text-[11px] text-ink-secondary">{t("platforms.xianyu.live", { line: status.transportLive || "none" })}</span>
              </div>
              <div className="max-w-[280px]">
                <Segmented
                  label={t("platforms.xianyu.transportLabel")}
                  value={(transport || "auto") as "auto" | "protocol" | "web"}
                  onChange={(next) => void switchTransport(next)}
                  options={[
                    { value: "auto", label: t("platforms.xianyu.transport.auto") },
                    { value: "protocol", label: t("platforms.xianyu.transport.protocol") },
                    { value: "web", label: t("platforms.xianyu.transport.web") },
                  ]}
                />
              </div>
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
              sections={ownSections(board.sections)}
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
