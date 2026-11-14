// The project's own shadcn-style button: one place that decides a variant's look, so a new surface picks a
// variant instead of rebuilding padding and colour. Built on a plain button; Radix is not needed for this one.
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

const button = cva(
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40",
  {
    variants: {
      variant: {
        primary: "bg-accent text-[color:var(--color-accent-ink)] enabled:hover:bg-accent/85",
        secondary: "bg-raised text-ink enabled:hover:bg-hairline/40",
        outline: "border border-hairline/40 text-ink enabled:hover:bg-raised",
        ghost: "text-ink-secondary enabled:hover:bg-raised enabled:hover:text-ink",
        danger: "bg-danger text-[color:var(--color-accent-ink)] enabled:hover:bg-danger/85",
        warning: "bg-warning text-[color:var(--color-accent-ink)] enabled:hover:bg-warning/85",
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
  return <button type={type} className={cn(button({ variant, size }), className)} {...props} />;
}

export { button as buttonVariants };
