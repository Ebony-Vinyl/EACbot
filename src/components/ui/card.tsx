import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("eac-card rounded-xl border border-hairline bg-card text-ink", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("eac-card-header flex items-start gap-2 px-3 pt-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("eac-card-title min-w-0 flex-1 text-[12px] font-medium text-ink", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("eac-card-description text-[11px] leading-relaxed text-ink-secondary", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("eac-card-content p-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("eac-card-footer flex items-center justify-end gap-2 px-3 pb-3", className)} {...props} />;
}
