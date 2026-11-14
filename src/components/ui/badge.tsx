// A small label for a state or a count. `tone` is the only thing a caller chooses, so a "on" chip reads the
// same on every page.
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

const badge = cva(
  "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
  {
    variants: {
      tone: {
        neutral: "bg-raised text-ink-secondary",
        accent: "bg-accent/15 text-accent",
        success: "bg-accent/15 text-accent",
        warning: "bg-warning/15 text-warning",
        danger: "bg-danger/15 text-danger",
        outline: "border border-hairline/40 text-ink-secondary",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badge>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
