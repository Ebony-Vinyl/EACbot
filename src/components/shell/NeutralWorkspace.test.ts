// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: { activeView: "chat", connected: true, appSettingsOpen: false, appSettingsSection: "general", bots: [] }, dispatch: vi.fn() }));
const owner = vi.hoisted(() => ({ allowed: true }));
const inbox = vi.hoisted(() => ({ openInbox: vi.fn(), useInboxSupport: () => "yes", useInboxPanel: () => ({ open: false }), useInboxView: () => null }));
vi.mock("@/state/store", () => ({ useStore: () => store }));
vi.mock("@/state/inbox", () => inbox);
vi.mock("@/state/team-people", () => ({ useTeamPeople: () => null }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => owner.allowed }));
vi.mock("@/components/CommandPalette", () => ({ openCommandPalette: vi.fn() }));
const { WorkspaceHeader, WorkspaceNavigation } = await import("./NeutralWorkspace");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
function mount(node: ReturnType<typeof h>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(node));
  return container;
}
async function openDrawer() {
  const trigger = container.querySelector<HTMLButtonElement>('[title="More"]') ?? container.querySelector<HTMLButtonElement>('[aria-label="Workspace navigation"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  return dialog!;
}

beforeEach(() => {
  store.state = { activeView: "chat", connected: true, appSettingsOpen: false, appSettingsSection: "general", bots: [] };
  owner.allowed = true;
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

const destinations = [
  ["chat", { type: "showChat" }],
  ["herdr", { type: "showNewPage", page: "herdr" }],
  ["hermes", { type: "showNewPage", page: "hermes" }],
  ["task-center", { type: "showTaskCenter" }],
  ["missions", { type: "showNewPage", page: "missions" }],
  ["routines", { type: "showRoutines" }],
  ["usage", { type: "toggleAppSettings", open: true, section: "usage" }],
  ["agents", { type: "showNewPage", page: "agents" }],
  ["computers", { type: "showNewPage", page: "computers" }],
  ["terminals", { type: "showNewPage", page: "terminals" }],
  ["files", { type: "showFiles" }],
  ["platforms", { type: "showPlatforms" }],
  ["team-map", { type: "showTeamMap" }],
  ["health", { type: "showHealth" }],
  ["home", { type: "showHome" }],
  ["music", { type: "showMusic" }],
] as const;

describe("workspace navigation", () => {
  it.each(destinations)("opens the real %s destination through its own action", async (view, action) => {
    mount(h(WorkspaceNavigation, { theme: "dark" }));
    const drawer = await openDrawer();
    const button = drawer.querySelector<HTMLButtonElement>(`[data-workspace-page="${view}"]`);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(store.dispatch).toHaveBeenCalledExactlyOnceWith(action);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps tasks, executions and schedule separate without false page highlights", async () => {
    store.state.activeView = "missions";
    mount(h(WorkspaceNavigation, { theme: "dark" }));
    const drawer = await openDrawer();
    expect(drawer.querySelector('[data-workspace-page="missions"]')?.getAttribute("aria-current")).toBe("page");
    expect(drawer.querySelector('[data-workspace-page="task-center"]')?.hasAttribute("aria-current")).toBe(false);
    expect(drawer.querySelector('[data-workspace-page="routines"]')?.hasAttribute("aria-current")).toBe(false);
  });

  it("does not expose administrative destinations to a member", async () => {
    owner.allowed = false;
    const selector = '[data-workspace-page="task-center"], [data-workspace-page="usage"]';
    expect(mount(h(WorkspaceNavigation, { theme: "dark" })).querySelector(selector)).toBeNull();
    expect((await openDrawer()).querySelector(selector)).toBeNull();
  });

  it("distinguishes the platform detail parent from an exact current page", async () => {
    store.state.activeView = "platform";
    mount(h(WorkspaceNavigation, { theme: "dark" }));
    const drawer = await openDrawer();
    const platforms = drawer.querySelector('[data-workspace-page="platforms"]')!;
    expect(platforms.hasAttribute("data-parent-active")).toBe(true);
    expect(platforms.hasAttribute("aria-current")).toBe(false);
  });

  it("keeps settings reachable without a selected conversation", () => {
    const dom = mount(h(WorkspaceNavigation, { theme: "dark" }));
    act(() => dom.querySelector<HTMLButtonElement>("[data-workspace-settings]")!.click());
    expect(store.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleAppSettings", open: true });
  });

  it("closes settings then navigates, without altering a bot selection", () => {
    store.state.appSettingsOpen = true;
    const dom = mount(h(WorkspaceNavigation, { theme: "dark" }));
    expect(dom.querySelector('[data-workspace-settings]')?.getAttribute("aria-current")).toBe("page");
    act(() => dom.querySelector<HTMLButtonElement>('[data-workspace-page="files"]')!.click());
    expect(store.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "toggleAppSettings", open: false }, { type: "showFiles" },
    ]);
  });

  it("highlights Usage exactly and Settings as its parent", async () => {
    store.state.appSettingsOpen = true;
    store.state.appSettingsSection = "usage";
    const dom = mount(h(WorkspaceNavigation, { theme: "dark" }));
    const drawer = await openDrawer();
    expect(drawer.querySelector('[data-workspace-page="usage"]')?.getAttribute("aria-current")).toBe("page");
    expect(dom.querySelector('[data-workspace-settings]')?.hasAttribute("aria-current")).toBe(false);
    expect(dom.querySelector('[data-workspace-settings]')?.hasAttribute("data-parent-active")).toBe(true);
  });

  it("opens the real Inbox from More after returning to chat", async () => {
    store.state.activeView = "music";
    mount(h(WorkspaceNavigation, { theme: "dark" }));
    const drawer = await openDrawer();
    await act(async () => drawer.querySelector<HTMLButtonElement>("[data-workspace-inbox]")!.click());
    expect(store.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "showChat" });
    expect(inbox.openInbox).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens real extensions and shortcuts from the drawer", async () => {
    mount(h(WorkspaceNavigation, { theme: "dark" }));
    let drawer = await openDrawer();
    await act(async () => [...drawer.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Extensions")!.click());
    expect(store.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true });
    drawer = await openDrawer();
    await act(async () => [...drawer.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Keyboard Shortcuts")!.click());
    expect(store.dispatch).toHaveBeenLastCalledWith({ type: "toggleShortcuts", open: true });
  });

  it("only offers server settings when the desktop environment bridge is available", async () => {
    const servers = (dialog: HTMLElement) => [...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Servers");
    mount(h(WorkspaceNavigation, { theme: "dark" }));
    expect(servers(await openDrawer())).toBeUndefined();
    await act(async () => document.querySelector<HTMLButtonElement>('.workspace-drawer [aria-label="Close settings"]')?.click());
    vi.stubGlobal("ogb", { environments: {} });
    try {
      const drawer = await openDrawer();
      const button = servers(drawer);
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(store.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleAppSettings", open: true, section: "desktopWorkspaces" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the existing persisted skin system from the drawer", async () => {
    mount(h(WorkspaceHeader, { theme: "dark" }));
    const drawer = await openDrawer();
    await act(async () => [...drawer.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Switch to light theme")!.click());
    expect(localStorage.getItem("omb-skin")).toBe("daylight");
    expect(document.documentElement.dataset.mpTheme).toBe("light");
  });
});
