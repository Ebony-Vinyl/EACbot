// The segmented switch between the list of bots and the board. It sits at the top of the sidebar card, because the two
// surfaces it swaps are that same card.
//
// The highlight is one element that slides between the segments with the hand-written spring, rather than each segment
// fading its own background in: a single moving piece is what makes the two read as one control.

import { useEffect, useRef } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { setShellView, useShellView, type ShellView } from "@/lib/shell-view";
import { springTo } from "@/lib/use-spring";
import type { LocaleKey } from "@/locales";

const SEGMENTS: readonly { id: ShellView; label: LocaleKey }[] = [
  { id: "board", label: "board.segment.board" },
  { id: "sidebar", label: "board.segment.chat" },
];

export function ShellViewSwitch({ className }: { className?: string }) {
  const view = useShellView();
  const track = useRef<HTMLDivElement | null>(null);
  const pill = useRef<HTMLSpanElement | null>(null);
  const previousLeft = useRef<number | null>(null);

  useEffect(() => {
    const trackEl = track.current;
    const pillEl = pill.current;
    if (!trackEl || !pillEl) return;
    const active = [...trackEl.querySelectorAll<HTMLElement>("[data-segment]")].find((button) => button.dataset.segment === view);
    if (!active) return;
    const left = active.offsetLeft;
    const width = active.offsetWidth;
    pillEl.style.width = `${width}px`;

    const from = previousLeft.current;
    previousLeft.current = left;
    if (from === null) {
      // First paint: place it without moving.
      pillEl.style.transform = `translate3d(${left}px, 0, 0)`;
      pillEl.style.opacity = "1";
      return;
    }
    if (from === left) return;
    // Slide from where it was to where it belongs. The spring easing overshoots slightly, so the highlight has weight.
    springTo(pillEl, { x: from, opacity: 1 }, { x: left, opacity: 1 });
  }, [view]);

  return (
    <div
      ref={track}
      role="tablist"
      aria-label={t("board.segment.label")}
      className={cn(
        "pointer-events-auto relative flex items-center rounded-full p-1",
        // A recessed track, one step below the surface the pill sits on.
        "bg-[color-mix(in_srgb,var(--color-app)_52%,transparent)] border border-white/10",
        className,
      )}
    >
      <span
        ref={pill}
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-1 left-0 rounded-full bg-[color-mix(in_srgb,var(--color-raised)_88%,transparent)]"
        style={{ width: 0, opacity: 0 }}
      />
      {SEGMENTS.map((segment) => {
        const active = view === segment.id;
        return (
          <button
            key={segment.id}
            type="button"
            role="tab"
            data-segment={segment.id}
            aria-selected={active}
            onClick={() => setShellView(segment.id)}
            className={cn(
              "relative z-10 rounded-full px-4 py-1.5 text-[13px] transition-colors duration-150",
              active ? "text-ink" : "text-ink-secondary hover:text-ink",
            )}
          >
            {t(segment.label)}
          </button>
        );
      })}
    </div>
  );
}
