import { PLATFORM_LABELS } from "@/lib/platforms";
import type { PlatformId } from "../../shared/plugins/accounts.ts";

/** A small pill naming the platform a bot answers, next to its name in the sidebar. */
export function PlatformBadge({ platform, className = "" }: { platform: PlatformId; className?: string }) {
  const label = PLATFORM_LABELS[platform];
  return (
    <span
      data-testid="platform-badge"
      title={label}
      className={`shrink-0 rounded-full bg-raised px-1.5 py-0.5 text-[10px] font-semibold leading-none text-ink-secondary ${className}`}
    >
      {label}
    </span>
  );
}
