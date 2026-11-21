import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

const button = cva(
  "eac-button inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
  {
    variants: {
      variant: {
        primary: "eac-button-primary bg-accent text-[color:var(--color-accent-ink)] enabled:hover:opacity-90",
        secondary: "eac-button-secondary bg-raised text-ink enabled:hover:bg-raised-hover",
        outline: "eac-button-outline border-hairline bg-transparent text-ink enabled:hover:bg-raised",
        ghost: "eac-button-ghost bg-transparent text-ink-secondary enabled:hover:bg-raised enabled:hover:text-ink",
        danger: "eac-button-danger bg-danger text-[color:var(--color-danger-ink)] enabled:hover:opacity-90",
        warning: "eac-button-warning bg-warning/15 text-warning enabled:hover:bg-warning/25",
      },
      size: {
        sm: "h-7 px-2.5 text-[11px]",
        md: "h-8 px-3 text-[12px]",
        lg: "h-10 px-4 text-[13px]",
        icon: "size-7 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof button>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(button({ variant: variant ?? "secondary", size: size ?? "md" }), className)} {...props} />;
}

export { button as buttonVariants };
