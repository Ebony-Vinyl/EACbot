// The platform boards' drawing kit: one set of primitives every board is built from, so six platforms look like
// one product and a new platform adds no new visual vocabulary. Everything here is presentational; a board's
// shape comes from the shared contract in shared/plugins/boards.ts, never from platform-specific branches.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Loader2, RefreshCw, ShieldAlert } from "lucide-react";

import type {
  BoardAction,
  BoardCapability,
  BoardCell,
  BoardColumn,
  BoardHeadline,
  BoardLimit,
  BoardNotice,
  BoardRow,
  BoardSection,
} from "../../../shared/plugins/boards";
import type { PlatformId } from "../../../shared/plugins/accounts";
import type { PlatformSummary } from "../../../shared/plugins/boards";
import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import { springTo } from "@/lib/use-spring";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export const BOARD_INPUT = "w-full rounded-lg border border-hairline/40 bg-app px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent/60 [color-scheme:dark]";
const CARD = "rounded-xl border border-hairline/30 bg-inset";
const QUIET_BUTTON = "rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-raised disabled:opacity-40";
const PRIMARY_BUTTON = "rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-accent-ink)] transition-opacity hover:opacity-90 disabled:opacity-40";

const TONE_TEXT: Record<string, string> = {
  normal: "text-ink",
  accent: "text-accent",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-ink-secondary",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A page's frame: the shared header every platform board shows, then the board's own sections. */
export function BoardShell({
  title,
  subtitle,
  account,
  busy,
  onRefresh,
  onBack,
  children,
}: {
  title: string;
  subtitle?: string;
  account?: ReactNode;
  busy?: boolean;
  onRefresh?(): void;
  onBack?(): void;
  children: ReactNode;
}) {
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header className="flex shrink-0 flex-col gap-2 border-b border-hairline/30 px-5 py-3">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t("platforms.board.back")}
              className="shrink-0 cursor-pointer rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
            >
              <ChevronRight size={16} className="rotate-180 rtl:rotate-0" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold">{title}</h1>
            {subtitle && <p className="truncate text-[11px] text-ink-secondary">{subtitle}</p>}
          </div>
          {account}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              aria-label={t("platforms.board.refresh")}
              disabled={busy}
              className="shrink-0 cursor-pointer rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
            >
              <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
            </button>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">{children}</div>
    </main>
  );
}

/** The headline figures: three to six, never a wall of tiles. */
export function StatStrip({ items }: { items: readonly BoardHeadline[] }) {
  if (!items.length) return null;
  return (
    <dl className={cn(CARD, "grid overflow-hidden", items.length >= 4 ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6" : "grid-cols-3")}>
      {items.map((item) => (
        <div key={item.key} className="flex min-w-0 flex-col gap-0.5 border-hairline/20 px-3 py-2.5 [&:not(:first-child)]:border-s">
          <dt className="truncate text-[10px] font-medium uppercase tracking-wide text-ink-secondary">{item.label}</dt>
          <dd className={cn("truncate text-[20px] font-semibold leading-none tabular-nums", TONE_TEXT[item.tone ?? "normal"])}>{item.value}</dd>
          {item.hint && <p className="truncate text-[10px] text-ink-tertiary" title={item.hint}>{item.hint}</p>}
        </div>
      ))}
    </dl>
  );
}

export function SectionCard({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={cn(CARD, "flex min-w-0 flex-col")}>
      <div className="flex items-baseline gap-2 border-b border-hairline/20 px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">{title}</h2>
        {hint && <span className="truncate text-[11px] text-ink-secondary" title={hint}>{hint}</span>}
        {action}
      </div>
      <div className="min-w-0 p-3">{children}</div>
    </section>
  );
}

export function EmptyCard({ title, body }: { title: string; body?: string }) {
  return (
    <div className={cn(CARD, "px-4 py-6 text-center")}>
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {body && <p className="mt-1 text-[12px] text-ink-secondary">{body}</p>}
    </div>
  );
}

export function Notice({ tone, text, action }: BoardNotice & { action?: ReactNode }) {
  const frame = tone === "danger" ? "border-danger/40 bg-danger/10 text-danger"
    : tone === "warning" ? "border-warning/40 bg-warning/10 text-ink"
    : "border-accent/40 bg-accent/10 text-ink";
  return (
    <div className={cn("flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px]", frame)}>
      <ShieldAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
      {action}
    </div>
  );
}

export function Chip({ active, onClick, children }: { active?: boolean; onClick?(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full px-2.5 py-1 text-[11px] transition-colors",
        active ? "bg-accent/15 text-accent" : "bg-inset text-ink-secondary hover:bg-raised hover:text-ink",
        !onClick && "cursor-default",
      )}
    >
      {children}
    </button>
  );
}

/** A segmented control with the house spring on its sliding pill. */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(next: T): void;
  label: string;
}) {
  const track = useRef<HTMLDivElement | null>(null);
  const pill = useRef<HTMLSpanElement | null>(null);
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const place = useCallback(() => {
    const trackEl = track.current;
    const pillEl = pill.current;
    if (!trackEl || !pillEl) return;
    const width = trackEl.clientWidth / options.length;
    pillEl.style.width = `${width}px`;
    pillEl.style.transform = `translateX(${width * index}px)`;
  }, [index, options.length]);
  useEffect(() => {
    place();
    const element = pill.current;
    if (element) springTo(element, { x: 0, opacity: 1 }, { x: 0, opacity: 1 });
  }, [place]);
  useEffect(() => {
    const observer = new ResizeObserver(place);
    if (track.current) observer.observe(track.current);
    return () => observer.disconnect();
  }, [place]);
  return (
    <div ref={track} role="tablist" aria-label={label} className="relative flex rounded-lg bg-inset p-0.5">
      <span ref={pill} aria-hidden="true" className="pointer-events-none absolute inset-y-0.5 start-0.5 rounded-md bg-raised transition-transform duration-200" />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "relative z-10 flex-1 cursor-pointer rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            option.value === value ? "text-ink" : "text-ink-secondary hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function CellView({ cell }: { cell: BoardCell }) {
  if (typeof cell !== "object") return <span className="tabular-nums">{cell}</span>;
  const tone = TONE_TEXT[cell.tone ?? "normal"];
  if (cell.kind === "status" || cell.kind === "badge") {
    return (
      <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold", cell.tone === "danger" ? "bg-danger/15" : cell.tone === "warning" ? "bg-warning/15" : cell.tone === "accent" ? "bg-accent/15" : "bg-raised", tone)}>
        {cell.value}
      </span>
    );
  }
  if (cell.kind === "link" && cell.href) {
    return <a href={cell.href} target="_blank" rel="noopener noreferrer" className={cn("underline underline-offset-2", tone)}>{cell.value}</a>;
  }
  if (cell.kind === "count" || cell.kind === "money") return <span className={cn("tabular-nums", tone)}>{cell.value}</span>;
  if (cell.kind === "time") return <span className={cn("tabular-nums text-ink-secondary", cell.tone && tone)}>{cell.value}</span>;
  return <span className={tone}>{cell.value}</span>;
}

export function DataTable({ columns, rows, empty, onOpen }: {
  columns: readonly BoardColumn[];
  rows: readonly BoardRow[];
  empty?: string;
  onOpen?(id: string): void;
}) {
  if (!rows.length) return <p className="text-[12px] text-ink-secondary">{empty ?? t("platforms.board.empty")}</p>;
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-0 border-collapse text-[12px]">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "border-b border-hairline/30 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary",
                  column.align === "end" ? "text-end" : "text-start",
                  column.priority === "secondary" && "hidden sm:table-cell",
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={row.opens && onOpen ? () => onOpen(row.opens!) : undefined}
              className={cn(
                "border-b border-hairline/15 last:border-0",
                row.opens && onOpen && "cursor-pointer hover:bg-raised/40",
                row.tone === "danger" && "bg-danger/5",
                row.tone === "warning" && "bg-warning/5",
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    "px-2 py-1.5 align-top",
                    column.align === "end" ? "text-end" : "text-start",
                    column.priority === "secondary" && "hidden sm:table-cell",
                  )}
                >
                  {row.cells[column.key] !== undefined ? <CellView cell={row.cells[column.key]!} /> : <span className="text-ink-tertiary">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DataList({ items, empty, onOpen }: {
  items: ReadonlyArray<{ id: string; title: string; subtitle?: string; meta?: string; tone?: "normal" | "warning" | "danger"; opens?: string }>;
  empty?: string;
  onOpen?(id: string): void;
}) {
  if (!items.length) return <p className="text-[12px] text-ink-secondary">{empty ?? t("platforms.board.empty")}</p>;
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            disabled={!item.opens || !onOpen}
            onClick={item.opens && onOpen ? () => onOpen(item.opens!) : undefined}
            className={cn(
              "flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-start transition-colors",
              item.opens && onOpen ? "cursor-pointer hover:bg-raised/50" : "cursor-default",
            )}
          >
            <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", item.tone === "danger" ? "bg-danger" : item.tone === "warning" ? "bg-warning" : "bg-accent/60")} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-ink">{item.title}</span>
              {item.subtitle && <span className="block truncate text-[11px] text-ink-secondary">{item.subtitle}</span>}
            </span>
            {item.meta && <span className="shrink-0 text-[10px] tabular-nums text-ink-tertiary">{item.meta}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Timeline({ entries, empty }: {
  entries: ReadonlyArray<{ id: string; at: string; title: string; detail?: string; tone?: "normal" | "warning" | "danger" }>;
  empty?: string;
}) {
  const format = useMemo(() => new Intl.DateTimeFormat(intlLocale(), { dateStyle: "short", timeStyle: "short" }), []);
  if (!entries.length) return <p className="text-[12px] text-ink-secondary">{empty ?? t("platforms.board.empty")}</p>;
  return (
    <ol className="flex flex-col">
      {entries.map((entry, index) => (
        <li key={entry.id} className="flex min-w-0 gap-2.5">
          <div className="flex flex-col items-center">
            <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", entry.tone === "danger" ? "bg-danger" : entry.tone === "warning" ? "bg-warning" : "bg-accent/60")} />
            {index < entries.length - 1 && <span className="my-0.5 w-px flex-1 bg-hairline/40" />}
          </div>
          <div className="min-w-0 flex-1 pb-2.5">
            <div className="flex items-baseline gap-2">
              <p className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{entry.title}</p>
              <time dateTime={entry.at} className="shrink-0 text-[10px] tabular-nums text-ink-tertiary">{format.format(new Date(entry.at))}</time>
            </div>
            {entry.detail && <p className="mt-0.5 text-[11px] text-ink-secondary">{entry.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Work that could not be finished automatically: every item says why, and offers what a person can do. */
export function QueueList({ items, empty, onAction }: {
  items: ReadonlyArray<{ id: string; title: string; reason: string; since?: string; tone?: "normal" | "warning" | "danger"; actions?: ReadonlyArray<{ id: string; label: string }> }>;
  empty?: string;
  onAction?(itemId: string, actionId: string): void;
}) {
  const format = useMemo(() => new Intl.DateTimeFormat(intlLocale(), { dateStyle: "short", timeStyle: "short" }), []);
  if (!items.length) return <p className="text-[12px] text-ink-secondary">{empty ?? t("platforms.board.queueEmpty")}</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => (
        <li key={item.id} className={cn("rounded-lg border px-2.5 py-2", item.tone === "danger" ? "border-danger/40 bg-danger/5" : item.tone === "warning" ? "border-warning/40 bg-warning/5" : "border-hairline/30 bg-app")}>
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{item.title}</p>
            {item.since && <time dateTime={item.since} className="shrink-0 text-[10px] tabular-nums text-ink-tertiary">{format.format(new Date(item.since))}</time>}
          </div>
          <p className="mt-0.5 text-[11px] text-ink-secondary">{item.reason}</p>
          {item.actions?.length && onAction && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {item.actions.map((action) => (
                <button key={action.id} type="button" onClick={() => onAction(item.id, action.id)} className="rounded-md border border-hairline/40 px-2 py-0.5 text-[11px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink">
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A board chart: a Vega-Lite spec the plugin supplied, drawn with the app's own theme. */
export function ChartPanel({ spec, empty }: { spec: Record<string, unknown>; empty?: string }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let view: { finalize(): void } | null = null;
    const draw = async () => {
      if (!host.current || !Object.keys(spec).length) return;
      try {
        const embed = (await import("vega-embed")).default;
        const { vegaConfig } = await import("../../../shared/vega-config");
        const dark = document.documentElement.dataset.skin !== "light";
        const result = await embed(host.current, spec as never, {
          actions: false,
          renderer: "svg",
          config: { background: "transparent", ...vegaConfig(dark ? "dark" : "light") },
          height: 180,
        });
        if (cancelled) result.view.finalize();
        else view = result.view;
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void draw();
    return () => {
      cancelled = true;
      view?.finalize();
    };
  }, [spec]);
  if (!Object.keys(spec).length || failed) {
    return <div className="flex h-[180px] items-center justify-center text-[12px] text-ink-secondary">{empty ?? t("platforms.board.chartEmpty")}</div>;
  }
  return <div ref={host} role="img" aria-label={t("platforms.board.chartLabel")} className="min-w-0" />;
}

export function CapabilityList({ items }: { items: readonly BoardCapability[] }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.id} className="flex min-w-0 items-start gap-2 text-[12px]">
          <span className={cn(
            "mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            item.state === "production" ? "bg-success/15 text-success" : item.state === "experimental" ? "bg-warning/15 text-warning" : "bg-raised text-ink-secondary",
          )}>
            {t(`platforms.capability.${item.state}`)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ink">{item.label}</span>
            {item.reason && <span className="block text-[11px] text-ink-secondary">{item.reason}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function LimitBars({ items }: { items: readonly BoardLimit[] }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => {
        const ratio = Math.min(1, item.used / item.cap);
        return (
          <li key={item.key} className="min-w-0">
            <div className="flex items-baseline gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-ink-secondary">{item.label}</span>
              <span className={cn("shrink-0 tabular-nums", ratio >= 1 ? "text-danger" : ratio >= 0.8 ? "text-warning" : "text-ink")}>{item.used} / {item.cap}</span>
              <span className="shrink-0 text-ink-tertiary">{item.window}</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
              <div className={cn("h-full rounded-full transition-[width] duration-300", ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : "bg-accent")} style={{ width: `${ratio * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** An action a person runs, or one that runs itself: both show their effect and whether they can run now. */
export function ActionRow({ action, busy, onRun }: { action: BoardAction; busy?: boolean; onRun(action: BoardAction): void }) {
  const destructive = action.effect === "delete" || action.effect === "financial";
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/30 bg-app px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-ink">{action.label}</span>
          <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", action.mode === "auto" ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary")}>
            {t(action.mode === "auto" ? "platforms.action.auto" : "platforms.action.manual")}
          </span>
        </div>
        {action.reason && <p className="mt-0.5 text-[11px] text-ink-secondary">{action.reason}</p>}
      </div>
      <button
        type="button"
        disabled={!action.available || busy}
        onClick={() => onRun(action)}
        className={cn(destructive ? "rounded-lg border border-danger/40 px-3 py-1.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-40" : QUIET_BUTTON)}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : t("platforms.action.run")}
      </button>
    </div>
  );
}

export function FormSection({ fields, submitLabel, busy, onSubmit }: {
  fields: ReadonlyArray<{ key: string; label: string; type: "text" | "number" | "boolean" | "select" | "secret"; value?: string | number | boolean; placeholder?: string; options?: ReadonlyArray<{ value: string; label: string }>; help?: string; secretSet?: boolean }>;
  submitLabel: string;
  busy?: boolean;
  onSubmit(values: Record<string, unknown>): void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const field of fields) if (field.type !== "secret") initial[field.key] = field.value ?? (field.type === "boolean" ? false : "");
    return initial;
  });
  const set = (key: string, value: unknown) => setValues((current) => ({ ...current, [key]: value }));
  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      {fields.map((field) => (
        <label key={field.key} className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] font-medium text-ink-secondary">{field.label}</span>
          {field.type === "boolean" ? (
            <input type="checkbox" checked={Boolean(values[field.key])} onChange={(event) => set(field.key, event.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          ) : field.type === "select" ? (
            <select className={BOARD_INPUT} value={String(values[field.key] ?? "")} onChange={(event) => set(field.key, event.target.value)}>
              {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ) : (
            <input
              className={BOARD_INPUT}
              type={field.type === "number" ? "number" : field.type === "secret" ? "password" : "text"}
              value={field.type === "secret" ? String(values[field.key] ?? "") : String(values[field.key] ?? "")}
              placeholder={field.type === "secret" && field.secretSet ? t("platforms.board.secretSet") : field.placeholder}
              onChange={(event) => set(field.key, field.type === "number" ? Number(event.target.value) : event.target.value)}
            />
          )}
          {field.help && <span className="text-[10px] text-ink-tertiary">{field.help}</span>}
        </label>
      ))}
      <button type="submit" disabled={busy} className={cn(PRIMARY_BUTTON, "self-start")}>{submitLabel}</button>
    </form>
  );
}

/** Renders one contract section. This is the only place a section kind turns into markup. */
export function BoardSectionView({ section, busyAction, onOpen, onQueueAction, onSubmitForm }: {
  section: BoardSection;
  busyAction?: string | null;
  onOpen?(id: string): void;
  onQueueAction?(itemId: string, actionId: string): void;
  onSubmitForm?(action: string, values: Record<string, unknown>): void;
}) {
  const body = (() => {
    switch (section.kind) {
      case "list": return <DataList items={section.items} empty={section.empty} onOpen={onOpen} />;
      case "timeline": return <Timeline entries={section.entries} empty={section.empty} />;
      case "table": return <DataTable columns={section.columns} rows={section.rows} empty={section.empty} onOpen={onOpen} />;
      case "queue": return <QueueList items={section.items} empty={section.empty} onAction={onQueueAction} />;
      case "chart": return <ChartPanel spec={section.spec} empty={section.empty} />;
      case "form": return <FormSection fields={section.fields} submitLabel={section.submitLabel} busy={busyAction === section.action} onSubmit={(values) => onSubmitForm?.(section.action, values)} />;
      case "notice": return <div className="flex flex-col gap-1.5">{section.notices.map((notice, index) => (
          <Notice key={`${notice.text}-${index}`} tone={notice.tone} text={notice.text} />
        ))}</div>;
    }
  })();
  return <SectionCard title={section.title} hint={section.hint}>{body}</SectionCard>;
}

/** The whole board below its header, in the order the plugin sent its sections. */
export function BoardBody({ sections, busyAction, onOpen, onQueueAction, onSubmitForm }: {
  sections: readonly BoardSection[];
  busyAction?: string | null;
  onOpen?(id: string): void;
  onQueueAction?(itemId: string, actionId: string): void;
  onSubmitForm?(action: string, values: Record<string, unknown>): void;
}) {
  if (!sections.length) return <EmptyCard title={t("platforms.board.empty")} />;
  return (
    <>
      {sections.map((section) => (
        <BoardSectionView
          key={section.id}
          section={section}
          busyAction={busyAction}
          onOpen={onOpen}
          onQueueAction={onQueueAction}
          onSubmitForm={onSubmitForm}
        />
      ))}
    </>
  );
}

/** Asks before a run that the plugin marked as needing a person's word. */
export function useActionConfirm(): {
  ask: { action: BoardAction; title: string; body: string } | null;
  request(action: BoardAction, run: () => void): void;
  cancel(): void;
  confirm(): void;
} {
  const pending = useRef<(() => void) | null>(null);
  const [ask, setAsk] = useState<{ action: BoardAction; title: string; body: string } | null>(null);
  const request = useCallback((action: BoardAction, run: () => void) => {
    if (!action.confirm) {
      run();
      return;
    }
    pending.current = run;
    setAsk({ action, title: action.label, body: action.reason ?? t("platforms.action.confirmBody", { label: action.label }) });
  }, []);
  const cancel = useCallback(() => {
    pending.current = null;
    setAsk(null);
  }, []);
  const confirm = useCallback(() => {
    const run = pending.current;
    pending.current = null;
    setAsk(null);
    run?.();
  }, []);
  return { ask, request, cancel, confirm };
}

export function ActionConfirmDialog({ ask, onCancel, onConfirm }: { ask: { title: string; body: string } | null; onCancel(): void; onConfirm(): void }) {
  if (!ask) return null;
  return (
    <ConfirmDialog
      open
      title={ask.title}
      body={ask.body}
      confirmLabel={t("platforms.action.run")}
      cancelLabel={t("common.cancel")}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** The board page's data lifecycle: one loader, one error, one busy flag, as the rest of the app does it. */
export function usePlatformBoard(platform: PlatformId) {
  const [board, setBoard] = useState<import("../../../shared/plugins/boards").PlatformBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const answer = await api<{ board: import("../../../shared/plugins/boards").PlatformBoard }>(`/api/platform-boards/${platform}${refresh ? "?refresh=1" : ""}`, { background: true });
      setBoard(answer.board);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (action: string, params?: unknown) => {
    setBusyAction(action);
    setNotice(null);
    try {
      const answer = await api<{ result: unknown }>(`/api/platform-boards/${platform}/operate`, {
        method: "POST",
        body: JSON.stringify({ action, params }),
        timeoutMs: 120_000,
      });
      const result = answer.result as { ok?: boolean; message?: string } | null;
      if (result && result.ok === false) setNotice(result.message ?? t("platforms.action.failed"));
      await load(true);
    } catch (reason) {
      setNotice(messageOf(reason));
    } finally {
      setBusyAction(null);
    }
  }, [load, platform]);

  return { board, error, loading, busyAction, notice, load, run, setNotice };
}

export function LoadingRow() {
  return (
    <div className="flex h-40 items-center justify-center text-ink-secondary">
      <Loader2 size={18} className="animate-spin" />
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: string; onRetry?(): void }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
      <span className="min-w-0 flex-1">{error}</span>
      {onRetry && <button type="button" onClick={onRetry} className="shrink-0 underline underline-offset-2">{t("connectors.action.retry")}</button>}
    </div>
  );
}

/** A plugin that runs is not an account that is connected: the two are said separately, as they differ. */
export function SummaryChip({ summary }: { summary: PlatformSummary }) {
  const connected = summary.account?.status === "connected";
  const label = summary.state !== "ready" ? t(`platforms.state.${summary.state}`)
    : connected ? t("platforms.state.ready")
    : t("platforms.state.noAccount");
  const tone = summary.state !== "ready"
    ? summary.state === "failed" ? "bg-danger/15 text-danger"
      : summary.state === "installed-disabled" ? "bg-warning/15 text-warning"
      : "bg-raised text-ink-secondary"
    : connected ? "bg-success/15 text-success"
    : "bg-raised text-ink-secondary";
  return <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", tone)}>{label}</span>;
}
