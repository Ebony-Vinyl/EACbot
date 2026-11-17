// The left-hand surface: the list of bots, or the board. Both wear the same card, so swapping between them is one card
// changing what it holds rather than one pane replacing another.
//
// The motion is the shell's spring (src/lib/use-spring.ts, built on the Web Animations API): the incoming surface
// springs in from the edge, the outgoing one leaves the same way. WAAPI is what keeps it moving when the page is not
// being painted, which a requestAnimationFrame integrator cannot do.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { springTo } from "@/lib/use-spring";
import { useShellView } from "@/lib/shell-view";

/** How far a surface travels on its way in, out of. Small: the fade carries the change. */
const TRAVEL = 18;

export function SidebarSwap({ children }: { children: ReactNode }) {
  const view = useShellView();
  const [leaving, setLeaving] = useState<{ key: string; node: ReactNode } | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const outgoing = useRef<HTMLDivElement | null>(null);
  const shown = useRef<{ key: string; node: ReactNode }>({ key: view, node: children });

  // Keep what is on screen now, so the next change has something to play out.
  const before = shown.current;
  shown.current = { key: view, node: children };

  useEffect(() => {
    if (before.key === view) return;
    setLeaving(before);
    const timer = window.setTimeout(() => setLeaving(null), 380);
    return () => window.clearTimeout(timer);
    // `before` is the value captured on the render where the key changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // The incoming surface springs in from the edge.
  useEffect(() => {
    if (surface.current) springTo(surface.current, { x: -TRAVEL, opacity: 0 }, { x: 0, opacity: 1 });
  }, [view]);

  // The outgoing one leaves the same way.
  useEffect(() => {
    if (leaving && outgoing.current) springTo(outgoing.current, { x: 0, opacity: 1 }, { x: -TRAVEL, opacity: 0 }, true);
  }, [leaving]);

  return (
    <div data-shell-swap className="relative flex h-full shrink-0">
      {leaving && (
        <div
          key={`leaving:${leaving.key}`}
          ref={outgoing}
          aria-hidden="true"
          inert
          className="pointer-events-none absolute inset-y-0 left-0 z-10 flex h-full"
        >
          {leaving.node}
        </div>
      )}
      <div ref={surface} data-shell-surface={view} className="flex h-full shrink-0">
        {children}
      </div>
    </div>
  );
}
