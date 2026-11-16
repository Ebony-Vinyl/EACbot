// The field and the toolbar chips two data pages share. Inputs are one component so a date field and a
// search field line up, and a chip row is one component so two filters never drift apart.
import { Search } from "lucide-react";
import { EmptyState as NeutralEmptyState, Input as NeutralInput } from "@neutral-reference/ui";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";

export const inputClass =
  "eac-input rounded-lg px-2.5 py-2 text-[13px]";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <NeutralInput className={cn(inputClass, className)} {...props} />;
}

export function SearchInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <label className="relative block">
      <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-secondary" />
      <NeutralInput className={cn(inputClass, "pl-6", className)} {...props} />
    </label>
  );
}

export function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-[12px] font-medium text-ink-secondary">{label}</span>
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
    <NeutralEmptyState title={title} description={body} action={action} />
  );
}

/** A page's title bar: the heading, an optional subtitle, and the controls that act on the whole page. */
export function PageHeader({ title, subtitle, children, className }: { title: string; subtitle?: string; children?: ReactNode; className?: string }) {
  return (
    <header className={cn("neutral-page-header flex shrink-0 items-center gap-3 border-b border-hairline/30 px-6 py-5", className)}>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-ink-secondary">{subtitle}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </header>
  );
}
