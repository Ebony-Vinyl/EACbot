// The field and the toolbar chips two data pages share. Inputs are one component so a date field and a
// search field line up, and a chip row is one component so two filters never drift apart.
import { Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";

export const inputClass =
  "rounded-lg border border-hairline/40 bg-app px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent/60 [color-scheme:dark]";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(inputClass, className)} {...props} />;
}

export function SearchInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <label className="relative block">
      <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-secondary" />
      <input className={cn(inputClass, "pl-6", className)} {...props} />
    </label>
  );
}

export function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-[10px] uppercase tracking-wide text-ink-secondary">{label}</span>
      {children}
    </label>
  );
}

/** A row of mutually exclusive filters. `aria-pressed` carries the choice, so a screen reader hears it. */
export function ChipRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-wrap items-center gap-1.5", className)}>{children}</div>;
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "cursor-pointer rounded-full px-2.5 py-1 text-[11px] transition-colors",
        active ? "bg-accent/15 text-accent" : "bg-inset text-ink-secondary hover:bg-raised hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/** A one-line message above the content: a failure, a confirmation, or a warning a person must read. */
export function Notice({ tone, onDismiss, children }: { tone: "ok" | "warn" | "bad"; onDismiss?: () => void; children: ReactNode }) {
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px]",
        tone === "ok" ? "border-accent/40 bg-accent/10 text-ink"
          : tone === "warn" ? "border-warning/40 bg-warning/10 text-ink"
            : "border-danger/40 bg-danger/10 text-danger",
      )}
    >
      <span className="min-w-0 flex-1 leading-relaxed">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 cursor-pointer text-ink-secondary hover:text-ink">
          ×
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-hairline/30 bg-inset p-6 text-center">
      <p className="text-[14px] font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-ink-secondary">{body}</p>
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

/** A page's title bar: the heading, an optional subtitle, and the controls that act on the whole page. */
export function PageHeader({ title, subtitle, children, className }: { title: string; subtitle?: string; children?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex shrink-0 items-center gap-3 border-b border-hairline/30 px-5 py-3", className)}>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[15px] font-semibold text-ink">{title}</h1>
        {subtitle && <p className="truncate text-[11px] text-ink-secondary">{subtitle}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </header>
  );
}
