// The command-centre pages, as one row group under Inbox: the personal agent,
// the task list, the computers, the agents and the terminals. It sits beside
// Inbox because that row is the one place the sidebar shows on every plan and
// in both densities, and these pages are where a person does the work Inbox
// tells them about.
import { Bot, LayoutGrid, ListTree, MonitorSmartphone, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { NEW_PAGES, useStore, type NewPage } from "@/state/store";

const PAGE_ICONS: Readonly<Record<NewPage, typeof Bot>> = {
  herdr: TerminalSquare,
  hermes: Bot,
  missions: ListTree,
  computers: MonitorSmartphone,
  agents: LayoutGrid,
  terminals: TerminalSquare,
};

export function SidebarCommandPages({ icons, large }: {
  /** The avatars-only density: one square per page, no words. */
  icons: boolean;
  /** Simple's rows, sized as its bots' rows are. */
  large: boolean;
}) {
  const { state, dispatch } = useStore();
  return (
    <nav data-sidebar-command-pages="" aria-label={t("sidebar.nav.hermes")} className={icons ? "flex flex-col items-center" : "px-2 pb-1"}>
      {NEW_PAGES.map((page) => {
        const Icon = PAGE_ICONS[page];
        const active = state.activeView === page;
        const label = t(`sidebar.nav.${page}`);
        const onClick = () => dispatch({ type: "showNewPage", page });
        if (icons) {
          return (
            <button
              key={page}
              type="button"
              data-sidebar-page={page}
              aria-label={label}
              title={label}
              aria-current={active ? "page" : undefined}
              onClick={onClick}
              className={cn(
                "mx-auto mb-1 flex size-[46px] shrink-0 items-center justify-center rounded-xl text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                active && "bg-raised text-ink",
              )}
            >
              <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
            </button>
          );
        }
        return (
          <button
            key={page}
            type="button"
            data-sidebar-page={page}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onClick={onClick}
            className={cn(
              "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-accent/60",
              active && "bg-raised",
            )}
          >
            <span className={cn("grid shrink-0 place-items-center rounded-full bg-raised text-ink-secondary", large ? "size-9" : "size-8")}>
              <Icon size={large ? 18 : 16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span className={cn("min-w-0 flex-1 truncate text-ink", large ? "text-[14px] font-medium leading-5" : "text-[15px] font-semibold leading-5")}>
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
