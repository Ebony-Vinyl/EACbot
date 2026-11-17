// The board in the sidebar's place: the same card, holding the board instead of the list of bots. The swap itself is
// animated by SidebarSwap around it, so this is only the surface.

import { t } from "@/lib/i18n";
import { ShellViewSwitch } from "@/components/shell/ShellViewSwitch";
import { TaskBoard } from "./TaskBoard";

export function TaskBoardCard() {
  return (
    <aside
      data-board-card
      aria-label={t("board.title")}
      className={[
        "relative flex h-full shrink-0 flex-col",
        // The same card as the sidebar: at the window's top, bottom and left edges, rounded only where it faces the
        // conversation, so swapping the two reads as one surface changing its contents.
        "md:w-[min(440px,38vw)] md:rounded-r-[16px]",
        "md:bg-[color-mix(in_srgb,var(--color-panel)_46%,transparent)]",
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full max-md:bg-app",
      ].join(" ")}
    >
      {/* The switch belongs to the card, not to one of its faces: it stays put while the contents swap beneath it. */}
      <div data-board-view-switch className="flex shrink-0 justify-center px-3 pt-2">
        <ShellViewSwitch />
      </div>
      <div className="min-h-0 flex-1">
        <TaskBoard />
      </div>
    </aside>
  );
}
