import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

const badge = cva(
  "eac-badge inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
  {
    variants: {
      tone: {
        neutral: "eac-badge-neutral bg-raised text-ink-secondary",
        accent: "eac-badge-accent bg-accent/15 text-accent",
        success: "eac-badge-success bg-accent/15 text-accent",
        warning: "eac-badge-warning bg-warning/15 text-warning",
        danger: "eac-badge-danger bg-danger/15 text-danger",
        outline: "eac-badge-outline border border-hairline/40 text-ink-secondary",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badge>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
