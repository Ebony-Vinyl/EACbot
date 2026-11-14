import { cn } from "@/lib/cn";

export const BOT_PANEL_ID = "bot-panel";

/**
 * A side panel's surface. From `md` up it is a card at the window's right edge, meeting its top, bottom and right sides;
 * its only gap and its only rounded corners are on the left, toward the conversation it sits beside. On a phone it is
 * the full-bleed sheet the phone already had. The spring that carries it in lives in `shell/PanelSlot.tsx`, not here.
 *
 * `overlay` no longer changes where the card sits — the panel never takes layout width from the conversation — but it
 * still decides whether the panel covers its neighbour, which the phone sheet and the focus handling read.
 */
export const sidePanelCls = (overlay: boolean, simple = false) => cn(
  // `inset-0` covers the phone's whole screen. From `md` the left edge is released too — otherwise the panel stretches
  // across the window and sits on top of the sidebar instead of beside the conversation.
  "animate-sheet-in md:animate-none absolute inset-0 z-40 flex h-full min-w-0 flex-col outline-none focus-visible:outline-none",
  "md:top-0 md:bottom-0 md:left-auto md:right-0 md:rounded-l-[16px]",
  // Colour only: the ground is already blurred, so a second blur here would leave the picture unreadable.
  "md:bg-[color-mix(in_srgb,var(--color-panel)_46%,transparent)]",
  simple ? "md:w-[320px]" : "md:w-[min(420px,42vw)]",
  overlay ? "md:z-40" : "md:z-30",
);
