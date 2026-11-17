/** The status mark, on the skin's own tones so a light skin never shows a
 * dark-theme dot. */

import { cn } from "@/lib/cn";
import type { StatusTone } from "./status.ts";

const TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  accent: "bg-accent",
  neutral: "bg-ink-tertiary",
};

export function StatusDot({ tone, label }: { readonly tone: StatusTone; readonly label?: string }) {
  return (
    <span
      aria-hidden="true"
      title={label ?? tone}
      className={cn("size-1.5 shrink-0 rounded-full", TONE_CLASS[tone])}
    />
  );
}
