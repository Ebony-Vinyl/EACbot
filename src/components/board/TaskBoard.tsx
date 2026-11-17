// The board: a stack of cards, one per state, in the shape the reference uses — a large-radius card holding an inner
// tile, a full-width button row, and a quiet footer. It takes the sidebar's place rather than sitting beside it.
//
// Cards rather than columns: at this pane's width four columns squeeze each other and every title truncates. A stack
// keeps titles readable and matches the shell's floating-card language.

import { useMemo } from "react";
import { Plus } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { openBotThread } from "@/state/thread-navigation";
import type { LocaleKey } from "@/locales";
import { BotAvatar } from "@/components/Avatar";

type Group = "needsYou" | "moving" | "later" | "resting";

const GROUPS: readonly { id: Group; title: LocaleKey; hint: LocaleKey }[] = [
  { id: "needsYou", title: "board.column.needsYou", hint: "board.hint.needsYou" },
  { id: "moving", title: "board.column.moving", hint: "board.hint.moving" },
  { id: "later", title: "board.column.later", hint: "board.hint.later" },
  { id: "resting", title: "board.column.resting", hint: "board.hint.resting" },
];

type BotLike = (ReturnType<typeof useStore>)["state"]["bots"][number];

interface Row {
  key: string;
  botId: string;
  threadId: string;
  botName: string;
  bot: BotLike;
  title: string;
  updatedAt: number;
  unread: boolean;
  group: Group;
}

function groupFor(task: { unread?: boolean; busy?: boolean; snoozedUntil?: number; archivedAt?: number }): Group {
  if (task.archivedAt !== undefined) return "resting";
  if (task.busy) return "moving";
  if (task.unread) return "needsYou";
  if (task.snoozedUntil !== undefined && task.snoozedUntil > Date.now()) return "later";
  return "resting";
}

function timeAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return t("board.time.now");
  if (minutes < 60) return t("board.time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("board.time.hours", { count: hours });
  return t("board.time.days", { count: Math.round(hours / 24) });
}

/** One conversation, as an inner tile: the face, the title, and where it stands. */
function ConversationTile({ row, now }: { row: Row; now: number }) {
  const { dispatch } = useStore();
  return (
    <button
      type="button"
      onClick={() => openBotThread(dispatch, { id: row.botId, threadId: row.threadId }, row.threadId, true)}
      className={cn(
        "flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left",
        // The inner tile sits a step lighter than its card, the way the reference's cells do.
        "bg-[color-mix(in_srgb,var(--color-raised)_55%,transparent)]",
        "transition-[background-color,transform] duration-150 hover:bg-[color-mix(in_srgb,var(--color-raised)_82%,transparent)] active:scale-[0.99]",
      )}
    >
      <BotAvatar bot={row.bot} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-tight text-ink">{row.title}</span>
        <span className="mt-1 block truncate text-[11px] text-ink-tertiary">
          {row.botName} · {timeAgo(row.updatedAt, now)}
        </span>
      </span>
      {row.unread && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />}
    </button>
  );
}

function GroupCard({ group, rows, now }: { group: (typeof GROUPS)[number]; rows: Row[]; now: number }) {
  return (
    <section
      data-board-group={group.id}
      className="rounded-[24px] bg-[color-mix(in_srgb,var(--color-panel)_70%,transparent)] p-3"
    >
      <header className="flex items-baseline justify-between gap-2 px-1.5 pb-2.5">
        <h3 className="text-[14px] font-semibold text-ink">{t(group.title)}</h3>
        <span className="text-[11px] tabular-nums text-ink-tertiary">{rows.length}</span>
      </header>
      {rows.length === 0 ? (
        <p className="rounded-[14px] bg-[color-mix(in_srgb,var(--color-raised)_38%,transparent)] px-3 py-3 text-[12px] leading-relaxed text-ink-tertiary">
          {t(group.hint)}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row) => <ConversationTile key={row.key} row={row} now={now} />)}
        </div>
      )}
    </section>
  );
}

export function TaskBoard() {
  const { state } = useStore();
  const now = Date.now();

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const bot of state.bots) {
      if (bot.hidden) continue;
      for (const task of bot.tasks ?? []) {
        out.push({
          key: `${bot.id}:${task.threadId}`,
          botId: bot.id,
          threadId: task.threadId,
          botName: bot.name,
          bot,
          title: task.title || t("board.untitled"),
          updatedAt: task.updatedAt ?? task.createdAt,
          unread: task.unread === true,
          group: groupFor(task),
        });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [state.bots]);

  const byGroup = useMemo(() => {
    const map = new Map<Group, Row[]>();
    for (const group of GROUPS) map.set(group.id, []);
    for (const row of rows) map.get(row.group)?.push(row);
    return map;
  }, [rows]);

  return (
    <div data-task-board className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-baseline justify-between gap-3 px-4 pb-3 pt-4">
        <h2 className="text-[15px] font-semibold text-ink">{t("board.title")}</h2>
        <span className="text-[11px] text-ink-tertiary">{t("board.count", { count: rows.length })}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pb-3">
        {GROUPS.map((group) => (
          <GroupCard key={group.id} group={group} rows={byGroup.get(group.id) ?? []} now={now} />
        ))}
      </div>
      {/* The reference's footer: one full-width row that starts something new. */}
      <div className="shrink-0 px-3 pb-3">
        <button
          type="button"
          className="flex w-full items-center justify-center gap-2 rounded-[16px] bg-[color-mix(in_srgb,var(--color-raised)_55%,transparent)] py-3 text-[13px] text-ink-secondary transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--color-raised)_85%,transparent)] hover:text-ink"
        >
          <Plus size={15} aria-hidden="true" />
          {t("board.newPanel")}
        </button>
      </div>
    </div>
  );
}
