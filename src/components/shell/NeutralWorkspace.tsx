import { useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  IconAffiliate, IconBuildingStore, IconCalendarEvent, IconChartLine, IconDeviceDesktop, IconDots, IconFolder, IconHeartbeat, IconHelpCircle, IconHome, IconInbox,
  IconKeyboard, IconListCheck, IconMenu2, IconMoon, IconMusic, IconPlug, IconRobot, IconServer,
  IconRoute, IconSearch, IconSettings, IconSun, IconTerminal2, IconUsersGroup, IconX,
} from "@tabler/icons-react";
import { useStore, type Action } from "@/state/store";
import { closeInbox, openInbox, useInboxPanel, useInboxSupport, useInboxView } from "@/state/inbox";
import { useTeamPeople } from "@/state/team-people";
import { inboxFixes, waitingCount } from "@/components/inbox/inbox-view";
import { openCommandPalette } from "@/components/CommandPalette";
import { ChromeRailToggle } from "@/components/ChromeRailToggle";
import { applySkinChoice } from "@/lib/skins";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

type Theme = "light" | "dark";
type Destination = { view: string; label: LocaleKey; icon: typeof IconRobot; action: Action; rail?: boolean; admin?: boolean; localOnly?: boolean };

const destinations: readonly { label: LocaleKey; items: readonly Destination[] }[] = [
  { label: "neutral.workspace", items: [
    { view: "chat", label: "neutral.chat", icon: IconRobot, action: { type: "showChat" }, rail: true },
    { view: "herdr", label: "sidebar.nav.herdr", icon: IconAffiliate, action: { type: "showNewPage", page: "herdr" }, rail: true },
    { view: "task-center", label: "neutral.board", icon: IconListCheck, action: { type: "showTaskCenter" }, rail: true, admin: true },
    { view: "missions", label: "neutral.executions", icon: IconListCheck, action: { type: "showNewPage", page: "missions" } },
    { view: "routines", label: "neutral.schedule", icon: IconCalendarEvent, action: { type: "showRoutines" } },
    { view: "usage", label: "settings.section.usage", icon: IconChartLine, action: { type: "toggleAppSettings", open: true, section: "usage" }, rail: true, admin: true, localOnly: true },
  ] },
  { label: "neutral.resources", items: [
    { view: "hermes", label: "sidebar.nav.hermes", icon: IconRobot, action: { type: "showNewPage", page: "hermes" } },
    { view: "agents", label: "sidebar.nav.agents", icon: IconUsersGroup, action: { type: "showNewPage", page: "agents" } },
    { view: "computers", label: "sidebar.nav.computers", icon: IconDeviceDesktop, action: { type: "showNewPage", page: "computers" } },
    { view: "terminals", label: "sidebar.nav.terminals", icon: IconTerminal2, action: { type: "showNewPage", page: "terminals" } },
    { view: "files", label: "neutral.files", icon: IconFolder, action: { type: "showFiles" }, rail: true },
    { view: "platforms", label: "neutral.platforms", icon: IconRoute, action: { type: "showPlatforms" } },
  ] },
  { label: "neutral.more", items: [
    { view: "team-map", label: "neutral.team", icon: IconUsersGroup, action: { type: "showTeamMap" } },
    { view: "health", label: "neutral.health", icon: IconHeartbeat, action: { type: "showHealth" } },
    { view: "home", label: "neutral.home", icon: IconHome, action: { type: "showHome" } },
    { view: "music", label: "neutral.music", icon: IconMusic, action: { type: "showMusic" } },
  ] },
];
const pages = destinations.flatMap(({ items }) => items);
const railPages = pages.filter((item) => item.rail);

function useDestinationAccess() {
  const admin = useOwnerOrAdmin() === true;
  const remote = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  return (item: Destination) => (!item.admin || admin) && (!item.localOnly || !remote);
}

function useDestination() {
  const { state, dispatch } = useStore();
  return {
    current: state.appSettingsOpen ? state.appSettingsSection === "usage" ? "usage" : "settings" : state.activeView,
    select(action: Action) {
      if (state.appSettingsOpen && action.type !== "toggleAppSettings" && action.type !== "togglePlugins" && action.type !== "toggleShortcuts") {
        dispatch({ type: "toggleAppSettings", open: false });
      }
      dispatch(action);
    },
  };
}

function DestinationButton({ item, current, onPick, rail = false }: {
  item: Destination;
  current: string;
  onPick: (action: Action) => void;
  rail?: boolean;
}) {
  const label = t(item.label);
  return (
    <button type="button" className={rail ? "workspace-icon-button" : "workspace-drawer-item"}
      data-workspace-page={item.view} aria-current={item.view === current ? "page" : undefined}
      data-parent-active={(item.view === "platforms" && current === "platform") || (item.view === "chat" && current === "web-panel") ? "" : undefined}
      aria-label={rail ? label : undefined} title={rail ? label : undefined} onClick={() => onPick(item.action)}>
      <item.icon size={18} stroke={1.65} aria-hidden="true" />
      {!rail && <span>{label}</span>}
    </button>
  );
}

function WorkspaceDrawer({ trigger, theme, onOpen }: { trigger: ReactNode; theme: Theme; onOpen?: () => void }) {
  const { state } = useStore();
  const inboxSupported = useInboxSupport() !== "no";
  const destinationAllowed = useDestinationAccess();
  const { current, select } = useDestination();
  const [open, setOpen] = useState(false);
  const navigate = (action: Action) => {
    setOpen(false);
    select(action);
  };
  const ThemeIcon = theme === "dark" ? IconSun : IconMoon;
  const themeLabel = theme === "dark" ? "neutral.light" : "neutral.dark";
  return (
    <Dialog.Root open={open} onOpenChange={(next) => {
      if (next) onOpen?.();
      setOpen(next);
    }}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="workspace-drawer-scrim" data-native-view-overlay />
        <Dialog.Content className="workspace-drawer" aria-describedby={undefined}>
          <header className="workspace-drawer-head">
            <Dialog.Title>{t("neutral.workspace")}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="workspace-icon-button" aria-label={t("settings.close")}>
                <IconX size={18} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </header>
          <div className="workspace-drawer-scroll">
            <button type="button" className="workspace-drawer-item" onClick={() => { setOpen(false); openCommandPalette(); }}>
              <IconSearch size={18} aria-hidden="true" /> {t("neutral.search")}
            </button>
            {destinations.map((group) => (
              <section key={group.label} className="workspace-drawer-group" aria-label={t(group.label)}>
                <h3>{t(group.label)}</h3>
                {group.items.filter(destinationAllowed).map((item) => <DestinationButton key={item.view} item={item} current={current} onPick={navigate} />)}
              </section>
            ))}
            <div className="workspace-drawer-group">
              {inboxSupported && <button type="button" className="workspace-drawer-item" data-workspace-inbox onClick={() => {
                setOpen(false);
                select({ type: "showChat" });
                openInbox();
              }}><IconInbox size={18} aria-hidden="true" />{t("inbox.panel.title")}</button>}
              <button type="button" className="workspace-drawer-item" onClick={() => navigate({ type: "togglePlugins", open: true })}>
                <IconPlug size={18} aria-hidden="true" /> {t("neutral.extensions")}
              </button>
              <button type="button" className="workspace-drawer-item" onClick={() => navigate({ type: "toggleShortcuts", open: true })}>
                <IconKeyboard size={18} aria-hidden="true" /> {t("shortcuts.title")}
              </button>
              {typeof window !== "undefined" && window.ogb?.environments && <button type="button" className="workspace-drawer-item"
                onClick={() => navigate({ type: "toggleAppSettings", open: true, section: "desktopWorkspaces" })}>
                <IconServer size={18} aria-hidden="true" /> {t("settings.section.desktopWorkspaces")}
              </button>}
              <button type="button" className="workspace-drawer-item" aria-current={current === "settings" ? "page" : undefined}
                onClick={() => navigate({ type: "toggleAppSettings", open: true })}>
                <IconSettings size={18} aria-hidden="true" /> {t("neutral.settings")}
              </button>
              <button type="button" className="workspace-drawer-item" onClick={() => applySkinChoice(theme === "dark" ? "daylight" : "midnight")}>
                <ThemeIcon size={18} aria-hidden="true" /> {t(themeLabel)}
              </button>
            </div>
          </div>
          <footer className="workspace-drawer-status">
            <span data-connected={state.connected || undefined} aria-hidden="true" />
            {t(state.connected ? "neutral.connected" : "neutral.connecting")}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function WorkspaceNavigation({ theme, framed = false }: { theme: Theme; framed?: boolean }) {
  const { state, dispatch } = useStore();
  const { current, select } = useDestination();
  const destinationAllowed = useDestinationAccess();
  const inboxSupported = useInboxSupport() !== "no";
  const { open: inboxOpen } = useInboxPanel();
  const inbox = useInboxView();
  const team = useTeamPeople();
  const count = waitingCount(inbox) + inboxFixes(team?.needsYou, inbox).length;
  const inboxLabel = count > 0 ? t("inbox.row.count", { count }) : t("inbox.panel.title");
  return (
    <nav className="workspace-rail" aria-label={t("neutral.navigation")}>
      <div className="workspace-rail-pages">
        {railPages.filter(destinationAllowed).map((item) => <DestinationButton key={item.view} item={item} current={current} onPick={select} rail />)}
        {inboxSupported && <button type="button" className="workspace-icon-button" data-sidebar-inbox={count}
          aria-label={inboxLabel} title={inboxLabel} aria-pressed={inboxOpen} onClick={() => {
            if (inboxOpen && !state.appSettingsOpen && state.activeView !== "task-center") closeInbox();
            else {
              if (state.appSettingsOpen || state.activeView === "task-center") select({ type: "showChat" });
              openInbox();
            }
          }}>
          <IconInbox size={18} stroke={1.65} aria-hidden="true" />
          {count > 0 && <span className="workspace-rail-count" aria-hidden="true">{count > 9 ? "9+" : count}</span>}
          {state.bots.some((bot) => !bot.hidden && bot.busy) && <span className="workspace-rail-running" aria-hidden="true" />}
        </button>}
        <WorkspaceDrawer theme={theme} trigger={
          <button type="button" className="workspace-icon-button" title={t("neutral.more")} aria-label={t("neutral.more")}>
            <IconDots size={18} aria-hidden="true" />
          </button>
        } />
      </div>
      <div className="workspace-rail-tools">
        <button type="button" className="workspace-icon-button" data-tour="nav-apps" data-sidebar-nav="apps"
          aria-pressed={state.pluginsOpen} title={t("neutral.extensions")} aria-label={t("neutral.extensions")}
          onClick={() => select({ type: "togglePlugins", open: true })}>
          <IconBuildingStore size={18} stroke={1.65} aria-hidden="true" />
        </button>
        <button type="button" className="workspace-icon-button" title={t("shortcuts.title")} aria-label={t("shortcuts.title")}
          onClick={() => select({ type: "toggleShortcuts", open: true })}>
          <IconHelpCircle size={18} stroke={1.65} aria-hidden="true" />
        </button>
        <button type="button" className="workspace-icon-button" data-workspace-settings aria-current={current === "settings" ? "page" : undefined}
          data-parent-active={current === "usage" ? "" : undefined} title={t("neutral.settings")}
          aria-label={t("neutral.settings")}
          onClick={() => dispatch({ type: "toggleAppSettings", open: true })}>
          <IconSettings size={18} stroke={1.65} aria-hidden="true" />
        </button>
        {window.ogb?.environments && <button type="button" className="workspace-icon-button" data-workspace-servers
          aria-label={t("settings.section.desktopWorkspaces")} title={t("settings.section.desktopWorkspaces")}
          onClick={() => select({ type: "toggleAppSettings", open: true, section: "desktopWorkspaces" })}>
          <IconServer size={18} stroke={1.65} aria-hidden="true" />
        </button>}
        {!framed && <ChromeRailToggle bar="workspace-icon-button" />}
      </div>
    </nav>
  );
}

export function WorkspaceHeader({ theme, conversations, children, onOpenNavigation }: { theme: Theme; conversations?: ReactNode; children?: ReactNode; onOpenNavigation?: () => void }) {
  const { current } = useDestination();
  const page = pages.find((item) => item.view === (current === "platform" ? "platforms" : current));
  return (
    <header className="workspace-mobile-bar">
      <WorkspaceDrawer theme={theme} onOpen={onOpenNavigation} trigger={
        <button type="button" className="workspace-icon-button" aria-label={t("neutral.navigation")}>
          <IconMenu2 size={21} aria-hidden="true" />
        </button>
      } />
      {children || <span className="workspace-mobile-title">{current === "settings" ? t("neutral.settings") : page ? t(page.label) : "EACbot"}</span>}
      {conversations}
    </header>
  );
}
