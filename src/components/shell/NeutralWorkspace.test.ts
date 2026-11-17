// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: { activeView: "agents", connected: true }, dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => store }));
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
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

describe("workspace navigation", () => {
  it("keeps task board and core missions on their own existing routes", () => {
    const dom = mount(h(WorkspaceNavigation));
    for (const view of ["task-center", "missions", "chat"]) {
      act(() => dom.querySelector<HTMLButtonElement>(`[data-workspace-page="${view}"]`)!.click());
    }
    expect(store.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "showTaskCenter" }, { type: "showNewPage", page: "missions" },
      { type: "showChat" },
    ]);
    for (const view of ["agents", "computers", "terminals", "files", "platforms"]) expect(dom.querySelector(`[data-workspace-page="${view}"]`)).toBeNull();
  });

  it("keeps settings and extensions reachable without a selected conversation", () => {
    const dom = mount(h(WorkspaceNavigation));
    const buttons = dom.querySelectorAll<HTMLButtonElement>("footer button");
    act(() => { buttons[0]!.click(); buttons[1]!.click(); });
    expect(store.dispatch).toHaveBeenNthCalledWith(1, { type: "togglePlugins", open: true });
    expect(store.dispatch).toHaveBeenNthCalledWith(2, { type: "toggleAppSettings", open: true });
  });

  it("persists the header theme choice through the existing skin system", () => {
    const dom = mount(h(WorkspaceHeader, { theme: "dark" }));
    const toggle = dom.querySelector<HTMLButtonElement>(".neutral-header-actions button:last-child")!;
    act(() => toggle.click());
    expect(localStorage.getItem("omb-skin")).toBe("daylight");
    expect(document.documentElement.dataset.mpTheme).toBe("light");
  });
});
