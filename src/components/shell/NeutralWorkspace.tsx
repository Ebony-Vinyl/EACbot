import { useState } from "react";
import { Badge, Button, Drawer } from "@neutral-reference/ui";
import { AudioLines, Bot, CalendarDays, ChevronRight, Files, HeartPulse, House, LayoutGrid, ListTodo, Menu, MessageSquare, Monitor, Moon, Network, Plug, Search, Settings2, Sun, Terminal, Workflow } from "lucide-react";
import { useStore, type Action } from "@/state/store";
import { openCommandPalette } from "@/components/CommandPalette";
import { applySkinChoice } from "@/lib/skins";
import { t } from "@/lib/i18n";

const sections = [
  { label: "neutral.workspace", items: [
    { view: "herdr", label: "neutral.projects", icon: Terminal, action: { type: "showNewPage", page: "herdr" } },
    { view: "chat", label: "neutral.chat", icon: MessageSquare, action: { type: "showChat" } },
    { view: "hermes", label: "sidebar.nav.hermes", icon: AudioLines, action: { type: "showNewPage", page: "hermes" } },
    { view: "task-center", label: "neutral.board", icon: LayoutGrid, action: { type: "showTaskCenter" } },
    { view: "missions", label: "neutral.executions", icon: ListTodo, action: { type: "showNewPage", page: "missions" } },
    { view: "routines", label: "neutral.schedule", icon: CalendarDays, action: { type: "showRoutines" } },
  ] },
  { label: "neutral.resources", items: [
    { view: "agents", label: "sidebar.nav.agents", icon: Bot, action: { type: "showNewPage", page: "agents" } },
    { view: "computers", label: "sidebar.nav.computers", icon: Monitor, action: { type: "showNewPage", page: "computers" } },
    { view: "terminals", label: "sidebar.nav.terminals", icon: Terminal, action: { type: "showNewPage", page: "terminals" } },
    { view: "files", label: "neutral.files", icon: Files, action: { type: "showFiles" } },
    { view: "platforms", label: "neutral.platforms", icon: Workflow, action: { type: "showPlatforms" } },
  ] },
  { label: "neutral.more", items: [
    { view: "team-map", label: "neutral.team", icon: Network, action: { type: "showTeamMap" } },
    { view: "health", label: "neutral.health", icon: HeartPulse, action: { type: "showHealth" } },
    { view: "home", label: "neutral.home", icon: House, action: { type: "showHome" } },
  ] },
] as const satisfies readonly { label: string; items: readonly { view: string; label: string; icon: typeof Bot; action: Action }[] }[];

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { state, dispatch } = useStore();
  const act = (action: Action) => { dispatch(action); onNavigate?.(); };
  return <div className="neutral-navigation-content">
    <button type="button" className="neutral-brand" onClick={() => act({ type: "showChat" })} aria-label="EACbot">
      <span className="neutral-brand-mark"><AudioLines size={21} strokeWidth={1.6} /></span>
      <span>EACbot<small>{t("neutral.personalWorkspace")}</small></span>
    </button>
    <Button variant="ghost" className="neutral-search" onClick={() => { onNavigate?.(); openCommandPalette(); }}>
      <Search size={15} /><span>{t("neutral.search")}</span><kbd>⌘ K</kbd>
    </Button>
    <nav aria-label={t("neutral.navigation")} className="neutral-navigation-groups">
      <div className="neutral-navigation-group">
        {(["chat", "herdr", "task-center"] as const).map(view => {
          const item = sections[0].items.find(item => item.view === view)!;
          const active = view === "chat" ? ["chat", "hermes"].includes(state.activeView)
            : view === "task-center" ? ["task-center", "missions", "routines"].includes(state.activeView) : state.activeView === view;
          const Icon = item.icon;
          const children = view === "chat" ? ["hermes"] : view === "task-center" ? ["missions", "routines"] : [];
          return <div key={view}>
            <Button variant="ghost" className="neutral-nav-item" data-workspace-page={view}
              aria-current={state.activeView === view ? "page" : undefined} data-active={active || undefined}
              onClick={() => act(item.action)}><Icon size={18} strokeWidth={1.65} /><span>{t(view === "task-center" ? "neutral.tasks" : item.label)}</span></Button>
            {active && children.length > 0 && <div className="neutral-nav-children">
              {sections[0].items.filter(child => children.includes(child.view)).map(child => <Button
                key={child.view} variant="ghost" className="neutral-nav-item" data-workspace-page={child.view}
                aria-current={state.activeView === child.view ? "page" : undefined}
                onClick={() => act(child.action)}><child.icon size={15} /><span>{t(child.label)}</span></Button>)}
            </div>}
          </div>;
        })}
      </div>
      <details className="neutral-navigation-group neutral-nav-more" key={state.activeView}
        open={sections[2].items.some(item => item.view === state.activeView)}>
        <summary><Menu size={16} /><span>{t("neutral.more")}</span><ChevronRight size={14} /></summary>
        {sections[2].items.map(({ view, label, icon: Icon, action }) => <Button key={view}
          variant="ghost" className="neutral-nav-item" data-workspace-page={view}
          aria-current={state.activeView === view ? "page" : undefined} onClick={() => act(action)}>
          <Icon size={16} /><span>{t(label)}</span></Button>)}
        <Button variant="ghost" className="neutral-nav-item" onClick={() => act({ type: "togglePlugins", open: true })}>
          <Plug size={16} /><span>{t("neutral.extensions")}</span></Button>
      </details>
    </nav>
    <footer className="neutral-navigation-footer">
      <Button variant="ghost" className="neutral-nav-item" onClick={() => act({ type: "toggleAppSettings", open: true })}><Settings2 size={17} />{t("neutral.settings")}</Button>
      <div className="neutral-connection"><Badge dot tone={state.connected ? "success" : "warning"}>{t(state.connected ? "neutral.connected" : "neutral.connecting")}</Badge><span>v{__APP_VERSION__}</span></div>
    </footer>
  </div>;
}

export function WorkspaceNavigation() {
  return <aside className="neutral-navigation"><Navigation /></aside>;
}

export function WorkspaceHeader({ theme }: { theme: "light" | "dark" }) {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const current = sections.flatMap(section => [...section.items]).find(item => item.view === state.activeView);
  return <header className="neutral-workspace-header">
    <div className="neutral-mobile-navigation"><Drawer title={t("neutral.navigation")} side="left" open={open} onOpenChange={setOpen} trigger={<Button variant="ghost" size="icon" aria-label={t("neutral.navigation")}><Menu size={18} /></Button>}><Navigation onNavigate={() => setOpen(false)} /></Drawer></div>
    <span className="neutral-breadcrumb-root">{t("neutral.workspace")}</span><ChevronRight size={13} aria-hidden="true" /><span className="neutral-breadcrumb-current">{current ? t(current.label) : "EACbot"}</span>
    <div className="neutral-header-actions"><Button variant="ghost" size="icon" aria-label={t("neutral.search")} onClick={openCommandPalette}><Search size={17} /></Button><Button variant="ghost" size="icon" aria-label={t(theme === "dark" ? "neutral.light" : "neutral.dark")} onClick={() => applySkinChoice(theme === "dark" ? "daylight" : "midnight")}>{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</Button></div>
  </header>;
}
