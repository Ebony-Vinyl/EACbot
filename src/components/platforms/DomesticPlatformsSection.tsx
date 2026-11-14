// The Apps panel's domestic-platforms strip: one card per platform with its live state, so the place a person
// connects an app is also the place they open that platform's board.
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";

import type { PlatformSummary } from "../../../shared/plugins/boards";
import type { PlatformId } from "../../../shared/plugins/accounts";
import { PLATFORM_LABELS } from "@/lib/platforms";
import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

const TILE = "flex min-w-0 flex-col gap-1.5 rounded-xl border border-hairline/40 bg-control/30 px-3 py-2.5 text-left transition-colors hover:border-hairline/60 hover:bg-raised";

function stateTag(summary: PlatformSummary | undefined): { label: string; tone: string } {
  if (!summary) return { label: t("platforms.state.missing"), tone: "bg-raised text-ink-secondary" };
  if (summary.state === "ready" && summary.account) return { label: t("platforms.state.ready"), tone: "bg-success/15 text-success" };
  if (summary.state === "ready") return { label: t("platforms.center.none"), tone: "bg-warning/15 text-warning" };
  if (summary.state === "installed-disabled") return { label: t("platforms.state.installed-disabled"), tone: "bg-warning/15 text-warning" };
  if (summary.state === "failed") return { label: t("platforms.state.failed"), tone: "bg-danger/15 text-danger" };
  return { label: t("platforms.state.missing"), tone: "bg-raised text-ink-secondary" };
}

export function DomesticPlatformsSection({ onOpen, onManage }: { onOpen(platform: PlatformId): void; onManage(): void }) {
  const [summaries, setSummaries] = useState<PlatformSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const answer = await api<{ platforms: PlatformSummary[] }>("/api/platform-boards", { background: true });
      setSummaries(answer.platforms);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // A section that vanishes when its data cannot be read leaves a person unable to tell "nothing here" from
  // "this build cannot answer". It says so instead, and still offers the way in.
  if (failed) {
    return (
      <section aria-label={t("apps.section.domestic")} className="mb-4" data-apps-section="domestic">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{t("apps.section.domestic")}</h2>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-ink">
          <span className="min-w-0 flex-1">{t("platforms.center.unavailable")}</span>
          <button type="button" onClick={onManage} className="shrink-0 underline underline-offset-2">
            {t("platforms.center.connect")}
          </button>
        </div>
      </section>
    );
  }
  if (!summaries) {
    return (
      <section aria-label={t("apps.section.domestic")} className="mb-4">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{t("apps.section.domestic")}</h2>
        <p className="flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={12} className="animate-spin" />{t("platforms.loading")}</p>
      </section>
    );
  }

  return (
    <section aria-label={t("apps.section.domestic")} className="mb-4" data-apps-section="domestic">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{t("apps.section.domestic")}</h2>
        <button type="button" onClick={onManage} className="shrink-0 text-[11px] text-ink-secondary underline underline-offset-2 hover:text-ink">
          {t("platforms.center.connect")}
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {summaries.map((summary) => {
          const tag = stateTag(summary);
          return (
            <button key={summary.platform} type="button" data-apps-platform={summary.platform} onClick={() => onOpen(summary.platform)} className={TILE}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{PLATFORM_LABELS[summary.platform] ?? summary.label}</span>
                <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", tag.tone)}>{tag.label}</span>
                <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-secondary rtl:-scale-x-100" />
              </span>
              <span className="truncate text-[11px] text-ink-secondary">
                {summary.account?.displayName ?? summary.error ?? t("platforms.center.noneBody")}
              </span>
              {summary.headline.length > 0 && (
                <span className="flex min-w-0 flex-wrap gap-x-2.5 gap-y-0.5">
                  {summary.headline.slice(0, 2).map((item) => (
                    <span key={item.key} className="flex items-baseline gap-1 text-[10px]">
                      <span className="text-ink-tertiary">{item.label}</span>
                      <span className="font-semibold tabular-nums text-ink">{item.value}</span>
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
