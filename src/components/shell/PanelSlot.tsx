// Keeps a side panel mounted long enough to animate out, and springs it in and out.
//
// The shell used to mount panels with `{flag && <Panel/>}`, which unmounts the instant the flag drops — a panel could
// arrive but never leave, so every close was a cut. This wrapper holds the last rendered children while their exit
// runs.
//
// The motion is the shell's spring (src/lib/use-spring.ts, built on WAAPI): a panel caught mid-arrival turns around
// smoothly when it is closed, and it keeps its timing even when the page is not being painted.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { springTo } from "@/lib/use-spring";

/** How far a panel travels on its way in, in px. */
const TRAVEL = 20;
/** Long enough for the exit to finish, so the node is dropped only once the panel has landed out of sight. */
const SETTLE_MS = 260;

export function PanelSlot({ open, side, children }: { open: boolean; side: "left" | "right"; children: ReactNode }) {
  const element = useRef<HTMLDivElement | null>(null);
  const animation = useRef<Animation | null>(null);
  const wasOpen = useRef(false);
  // Stays true for one settle after closing, so the exit has a node to play on.
  const [mounted, setMounted] = useState(open);

  useEffect(() => () => animation.current?.cancel(), []);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!element.current || !mounted) return;
    const offset = side === "left" ? -TRAVEL : TRAVEL;
    if (open) {
      animation.current = springTo(element.current, wasOpen.current ? { x: 0, opacity: 0.4 } : { x: offset, opacity: 0 }, { x: 0, opacity: 1 });
    } else {
      animation.current = springTo(element.current, { x: 0, opacity: 1 }, { x: offset, opacity: 0 }, true);
    }
    wasOpen.current = open;
  }, [open, side, mounted]);

  if (!mounted) return null;

  return (
    <div
      ref={element}
      data-panel-slot={side}
      aria-hidden={!open}
      inert={!open}
      className={cn("pointer-events-none absolute inset-y-0 z-30", side === "right" ? "right-0" : "left-0")}
    >
      <div className={cn("h-full", open && "pointer-events-auto")}>{children}</div>
    </div>
  );
}
