// The board every platform gets for free: the contract's sections in the plugin's order, plus the account's
// actions, limits and capability list. A platform that needs a different shape writes its own board; the rest
// never do, which is why adding a platform does not add a renderer.
import { useState } from "react";

import type { PlatformId } from "../../../shared/plugins/accounts";
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

export function GenericBoard({ platform, title, subtitle, onBack }: {
  platform: PlatformId;
  title: string;
  subtitle?: string;
  onBack?(): void;
}) {
  const { board, error, loading, busyAction, notice, load, run, setNotice } = usePlatformBoard(platform);
  const confirm = useActionConfirm();
  const [openRow, setOpenRow] = useState<string | null>(null);

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      {board?.account ? (
        <>
          <span className="truncate text-[12px] text-ink-secondary">{board.account.displayName}</span>
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${board.account.status === "connected" ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>
            {t(`platforms.capability.${board.account.status === "connected" ? "production" : "experimental"}`)}
          </span>
        </>
      ) : (
        <span className="truncate text-[12px] text-ink-secondary">{t("platforms.center.none")}</span>
      )}
    </div>
  );

  return (
    <>
      <BoardShell title={title} subtitle={subtitle ?? board?.account?.displayName} account={header} busy={loading} onRefresh={() => void load(true)} onBack={onBack}>
        {error && <ErrorNotice error={error} onRetry={() => void load(true)} />}
        {notice && <Notice tone="warning" text={notice} />}
        {loading && !board ? <LoadingRow /> : board && (
          <>
            <StatStrip items={board.headline} />
            {board.sections.length ? (
              <BoardBody
                sections={board.sections}
                busyAction={busyAction}
                onOpen={setOpenRow}
                onQueueAction={(itemId, actionId) => void run(actionId, { itemId })}
                onSubmitForm={(action, values) => void run(action, values)}
              />
            ) : null}
            {board.actions.length > 0 && (
              <SectionCard title={t("platforms.center.open")}>
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
              <SectionCard title={t("platforms.center.blocked")}>
                <LimitBars items={board.limits} />
              </SectionCard>
            )}
            {board.capability.length > 0 && (
              <SectionCard title={title}>
                <CapabilityList items={board.capability} />
              </SectionCard>
            )}
          </>
        )}
        {openRow && (
          <button type="button" onClick={() => { setOpenRow(null); setNotice(null); }} className="self-start text-[11px] text-ink-secondary underline underline-offset-2">
            {t("platforms.board.back")}
          </button>
        )}
      </BoardShell>
      <ActionConfirmDialog ask={confirm.ask} onCancel={confirm.cancel} onConfirm={confirm.confirm} />
    </>
  );
}
