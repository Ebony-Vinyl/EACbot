import { Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";

export const inputClass =
  "eac-input w-full min-w-0 rounded-lg border border-hairline bg-inset px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(inputClass, className)} {...props} />;
}

export function SearchInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <span className="eac-search-field relative block">
      <Search aria-hidden="true" size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-secondary" />
      <Input className={cn("eac-search-input pl-6", className)} {...props} />
    </span>
  );
}

export function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn("eac-field flex flex-col gap-1", className)}>
      <span className="eac-field-label text-[12px] font-medium text-ink-secondary">{label}</span>
      {children}
    </label>
  );
}

export function ChipRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("eac-chip-row flex flex-wrap items-center gap-1.5", className)}>{children}</div>;
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "eac-chip cursor-pointer rounded-full px-2.5 py-1 text-[11px] transition-colors",
        active ? "bg-accent/15 text-accent" : "bg-inset text-ink-secondary hover:bg-raised hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

export function Notice({ tone, onDismiss, children }: { tone: "ok" | "warn" | "bad"; onDismiss?: () => void; children: ReactNode }) {
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      className={cn(
        "eac-notice flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px]",
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
    <div className="eac-empty-state flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <h3 className="eac-empty-state-title text-[13px] font-medium text-ink">{title}</h3>
      <p className="eac-empty-state-body max-w-sm text-[12px] leading-relaxed text-ink-secondary">{body}</p>
      {action != null && <div className="eac-empty-state-action mt-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, children, className }: { title: string; subtitle?: string; children?: ReactNode; className?: string }) {
  return (
    <header className={cn("eac-page-header neutral-page-header flex shrink-0 items-center gap-3 border-b border-hairline/30 px-6 py-5", className)}>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-ink-secondary">{subtitle}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </header>
  );
}
