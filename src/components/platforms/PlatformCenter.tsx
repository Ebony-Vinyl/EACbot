// The platform centre: one card per platform, so a person sees what each account is doing before opening a board.
// The list comes from the host, which asks each serving plugin; nothing here knows a platform's business.
import { useCallback, useEffect, useState } from "react";

import { ChevronRight, Loader2, Plug } from "lucide-react";

import type { PlatformSummary } from "../../../shared/plugins/boards";
import type { PlatformId } from "../../../shared/plugins/accounts";
import { PLATFORM_LABELS } from "@/lib/platforms";
import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BoardShell, ErrorNotice, LoadingRow, SummaryChip } from "./kit";

export function PlatformCenter({ onOpen, onConnect }: { onOpen(platform: PlatformId): void; onConnect(): void }) {
  const [summaries, setSummaries] = useState<PlatformSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const answer = await api<{ platforms: PlatformSummary[] }>(`/api/platform-boards${refresh ? "?refresh=1" : ""}`, { background: true });
      setSummaries(answer.platforms);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <BoardShell
      title={t("platforms.center.title")}
      subtitle={t("platforms.center.subtitle")}
      busy={loading}
      onRefresh={() => void load(true)}
    >
      {error && <ErrorNotice error={error} onRetry={() => void load(true)} />}
      {loading && !summaries ? <LoadingRow /> : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {(summaries ?? []).map((summary) => (
            <button
              key={summary.platform}
              type="button"
              onClick={() => onOpen(summary.platform)}
              className="flex min-w-0 flex-col gap-2 rounded-xl border border-hairline/30 bg-inset p-3 text-start transition-colors hover:border-hairline/60 hover:bg-raised/40"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-secondary">
                  <Plug size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-ink">{PLATFORM_LABELS[summary.platform as keyof typeof PLATFORM_LABELS] ?? summary.label}</span>
                  <span className="block truncate text-[11px] text-ink-secondary">
                    {summary.account?.displayName ?? t("platforms.center.none")}
                  </span>
                </span>
                <SummaryChip summary={summary} />
                <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-ink-secondary rtl:-scale-x-100" />
              </div>
              {summary.headline.length > 0 && (
                <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                  {summary.headline.slice(0, 3).map((item) => (
                    <span key={item.key} className="flex items-baseline gap-1 text-[11px]">
                      <span className="text-ink-secondary">{item.label}</span>
                      <span className={cn("font-semibold tabular-nums", item.tone === "danger" ? "text-danger" : item.tone === "warning" ? "text-warning" : "text-ink")}>{item.value}</span>
                    </span>
                  ))}
                </div>
              )}
              {summary.error && <p className="text-[11px] text-ink-tertiary">{summary.error}</p>}
              {summary.blocked.length > 0 && (
                <p className="text-[11px] text-ink-tertiary">
                  {t("platforms.center.blocked")}: {summary.blocked.map((entry) => entry.label).join(" · ")}
                </p>
              )}
            </button>
          ))}
        </div>
      )}
      <button type="button" onClick={onConnect} className="self-start rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-raised">
        {t("platforms.center.connect")}
      </button>
      {loading && summaries && (
        <p className="flex items-center gap-1.5 text-[11px] text-ink-secondary"><Loader2 size={12} className="animate-spin" />{t("platforms.loading")}</p>
      )}
    </BoardShell>
  );
}
