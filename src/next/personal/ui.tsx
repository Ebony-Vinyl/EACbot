/**
 * The four states every read can be in, rendered the same way everywhere.
 *
 * A screen never shows a blank pane while it waits, and never shows "empty"
 * when the answer was a refusal: the difference between "you have no tasks"
 * and "we could not ask" is exactly what a person needs to know.
 */
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { Loadable } from "./port.ts";

export function LoadingState({ label }: { readonly label: string }): ReactNode {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-ink-secondary">
      <Loader2 size={16} className="animate-spin" aria-hidden="true" />
      <p className="text-[12px]">{label}</p>
    </div>
  );
}

export function UnauthorizedState({ what }: { readonly what: string }): ReactNode {
  return (
    <EmptyPane
      title="这个设备还没有配对"
      description={`配对之后才能查看${what}。在运行 EACbot 的电脑上打开终端，按提示输入配对码。`}
    />
  );
}

export function ErrorState({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }): ReactNode {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 rounded-xl border border-hairline/40 bg-card/60 p-4">
      <p className="text-[12px] font-medium text-ink">没能读取数据</p>
      <p className="text-[11px] leading-relaxed text-ink-secondary">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

export function EmptyPane({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-[12px] font-medium text-ink">{title}</p>
      <p className="max-w-[34rem] text-[11px] leading-relaxed text-ink-secondary">{description}</p>
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Renders the one state a read is in, so no screen repeats the four branches. */
export function LoadableView<T>({
  state,
  label,
  what,
  children,
}: {
  readonly state: Loadable<T>;
  readonly label: string;
  readonly what: string;
  readonly children: (data: T, refresh: () => void) => ReactNode;
}): ReactNode {
  switch (state.status) {
    case "loading":
      return <LoadingState label={label} />;
    case "unauthorized":
      return <UnauthorizedState what={what} />;
    case "error":
      return <ErrorState message={state.message} onRetry={state.retry} />;
    case "ready":
      return children(state.data, state.refresh);
  }
}

/** A row of counts, each labelled, used above a filtered list. */
export function SummaryRow({ items }: { readonly items: ReadonlyArray<{ readonly label: string; readonly value: string }> }): ReactNode {
  return (
    <dl className="m-0 flex flex-wrap items-start gap-4">
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col">
          <dt className="text-[10px] uppercase tracking-wide text-ink-secondary">{item.label}</dt>
          <dd className={cn("m-0 text-[12px] font-medium text-ink")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
