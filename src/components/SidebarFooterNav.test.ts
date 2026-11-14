import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarDensity, SidebarToolsLayout } from "@/lib/sidebar-preferences";

const fixture = vi.hoisted(() => ({
  advanced: false,
  dispatch: vi.fn(),
  state: {} as Record<string, unknown>,
  toolsLayout: "rows" as SidebarToolsLayout,
  panels: [] as { id: string; name: string; url: string }[],
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarToolsLayout: () => fixture.toolsLayout,
}));
vi.mock("@/lib/web-panel-preferences", () => ({ useWebPanels: () => fixture.panels }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));
import { SidebarAppsButton, SidebarBottomButtons, SidebarFooterNav } from "./SidebarFooterNav";

type Props = { children?: ReactNode; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as ReactElement<Props>;
    return [node, ...nodes(node.props.children)];
  });
}
function render(density: SidebarDensity, { toolsLayout = "rows", ...extra }: { collapsed?: boolean; onToggleCollapsed?: () => void; toolsLayout?: SidebarToolsLayout } = {}) {
  fixture.toolsLayout = toolsLayout;
  let tree!: ReturnType<typeof SidebarFooterNav>;
  function Capture() { tree = SidebarFooterNav({ density, onToggleCollapsed: () => {}, ...extra }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

beforeEach(() => {
  fixture.advanced = false;
  fixture.dispatch.mockReset();
  fixture.state = { activeView: "chat", routines: [{ id: "daily", name: "Daily", botId: "scout", enabled: true }], webhooks: [], bots: [{ id: "scout" }], routineRuns: [], pluginsOpen: false };
  fixture.toolsLayout = "rows";
  fixture.panels = [];
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("sidebar footer places", () => {
  it("leaves the places to the account menu: the sidebar carries Files and pinned panels only", () => {
    fixture.advanced = true;
    const { html } = render("comfortable");
    for (const id of ["automations", "team-map", "health", "home", "platforms"]) {
      expect(html).not.toContain(`data-sidebar-nav="${id}"`);
    }
  });

  it("leaves no places in Simple mode's sidebar while Files is off", () => {
    expect(render("comfortable").html).toBe("");
  });

  it.each([false, true])("puts only Apps on the avatars-only density (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    const html = render("icons").html;
    expect(html).toContain('data-sidebar-nav="apps"');
    expect(html).not.toContain('data-sidebar-nav="automations"');
    expect(html).not.toContain('data-sidebar-nav="team-map"');
  });

  it("keeps only Apps on Simple mode's rail", () => {
    const html = renderToStaticMarkup(createElement(() => SidebarFooterNav({ density: "icons", rail: true })));
    expect(html).toContain('aria-label="Apps" title="Apps"');
    expect(html).toContain('data-tour="tools"');
    expect(html).not.toContain('data-sidebar-nav="automations"');
    expect(html).not.toContain('data-sidebar-nav="team-map"');
  });

  it("adds a row per pinned web panel after Team map, in Advanced mode only", () => {
    fixture.panels = [{ id: "panel-1", name: "Fleet board", url: "http://127.0.0.1:7841/" }];
    fixture.state = { ...fixture.state, activeView: "web-panel", webPanelId: "panel-1" };
    expect(render("comfortable").html).toBe("");
    fixture.advanced = true;
    const { html, nodes: tree } = render("comfortable");
    expect(html.indexOf('data-sidebar-nav="web-panel-panel-1"')).toBeGreaterThan(html.indexOf('data-sidebar-nav="team-map"'));
    expect(html).toContain(">Fleet board</span>");
    expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*Fleet board/);
    const row = tree.find((node) => node.props.id === "web-panel-panel-1" && typeof node.props.onClick === "function")!;
    (row.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showWebPanel", id: "panel-1" });
  });

  it("shows a pinned panel as an icon with its name as the label in the toolbar layout", () => {
    fixture.advanced = true;
    fixture.panels = [{ id: "panel-1", name: "Fleet board", url: "http://127.0.0.1:7841/" }];
    const { html } = render("comfortable", { toolsLayout: "toolbar" });
    expect(html).toContain('data-sidebar-nav="web-panel-panel-1"');
    expect(html).not.toContain(">Fleet board</span>");
    expect(html).toContain('aria-label="Fleet board"');
  });

  it("keeps the guided tour's tools anchor on the section", () => {
    fixture.advanced = true;
    expect(render("comfortable").html).toContain('data-tour="tools"');
  });




});

describe("Tools header", () => {

  it("keeps the Tools label and hides the rows when collapsed", () => {
    fixture.advanced = true;
    const { html } = render("comfortable", { collapsed: true });
    expect(html).toContain(">Tools<");
    expect(html).toContain('aria-expanded="false"');
    for (const id of ["automations", "team-map", "health", "home", "platforms"]) expect(html).not.toContain(`data-sidebar-nav="${id}"`);
  });

  it("toggles through the header", () => {
    fixture.advanced = true;
    const onToggleCollapsed = vi.fn();
    const { nodes: tree } = render("comfortable", { onToggleCollapsed });
    const header = tree.find((node) => typeof node.props.onToggle === "function")!;
    (header.props.onToggle as () => void)();
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });


  it("shows no dot on a collapsed header when nothing needs you", () => {
    fixture.advanced = true;
    expect(render("comfortable", { collapsed: true }).html).not.toContain('data-testid="section-alert"');
  });

  it("draws no Tools header in the avatars-only density or in Simple mode", () => {
    fixture.advanced = true;
    expect(render("icons").html).not.toContain(">Tools<");
    fixture.advanced = false;
    expect(render("comfortable").html).not.toContain(">Tools<");
  });

  it("keeps the guided tour's tools anchor on the header and rows together", () => {
    fixture.advanced = true;
    expect(render("comfortable").html).toContain('data-tour="tools"');
    expect(render("comfortable", { collapsed: true }).html).toContain('data-tour="tools"');
  });
});

function renderBottom() {
  let tree!: ReturnType<typeof SidebarBottomButtons>;
  function Capture() { tree = SidebarBottomButtons(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
describe("the bottom bar beside the profile", () => {
  it.each([false, true])("carries Apps alone: Automations and Team map are Tools rows in Advanced and account menu items in Simple (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    const { html } = renderBottom();
    expect(html).not.toContain('data-sidebar-nav="automations"');
    expect(html).not.toContain('data-sidebar-nav="team-map"');
    expect(html).toContain('data-sidebar-nav="apps"');
  });
});

describe("Apps beside the profile", () => {
  it.each([false, true])("is one icon button that opens Apps and carries the tour's Apps anchor (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    let tree!: ReturnType<typeof SidebarAppsButton>;
    function Capture() { tree = SidebarAppsButton(); return tree; }
    const html = renderToStaticMarkup(createElement(Capture));
    expect(html).toMatch(/data-tour="nav-apps" data-sidebar-nav="apps"/);
    expect(html).toContain('aria-label="Apps"');
    (tree.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true });
  });
});

describe("toolbar tools layout", () => {
  it("toolbar lays the remaining places out in one row", () => {
    fixture.advanced = true;
    const { html } = render("comfortable", { toolsLayout: "toolbar" });
    expect(html).toContain('class="flex flex-row gap-1"');
    expect(html).not.toContain("flex-col");
  });

  it("toolbar keeps the tour anchor", () => {
    fixture.advanced = true;
    expect(render("comfortable", { toolsLayout: "toolbar" }).html).toContain('data-tour="tools"');
  });



  it("icons density ignores the tools layout", () => {
    fixture.advanced = true;
    const rows = render("icons").html;
    expect(render("icons", { toolsLayout: "toolbar" }).html).toBe(rows);
    expect(rows).toContain('class="flex flex-col items-center gap-1"');
  });

  it("rows layout renders as before", () => {
    fixture.advanced = true;
    const unset = render("comfortable").html;
    expect(render("comfortable", { toolsLayout: "rows" }).html).toBe(unset);
    expect(unset).toContain('<div data-tour="tools">');
    expect(unset).toContain('<nav aria-label="Tools" class="flex flex-col gap-0.5">');
    expect(unset).not.toContain("flex-row");
  });
});
