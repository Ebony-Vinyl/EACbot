import { Button as NeutralButton } from "@neutral-reference/ui";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

const button = cva(
  "eac-button inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary: "",
        secondary: "",
        outline: "eac-button-outline",
        ghost: "",
        danger: "",
        warning: "eac-button-warning",
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
  return <NeutralButton type={type} variant={variant === "outline" || variant === "warning" ? "secondary" : variant ?? "secondary"} size={size === "icon" ? "icon" : size === "sm" ? "small" : "normal"} className={cn(button({ variant, size }), className)} {...props} />;
}

export { button as buttonVariants };
