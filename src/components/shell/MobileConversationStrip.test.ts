// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: {
    activeView: "chat", selectedId: "pepper",
    bots: [{ id: "pepper", name: "Pepper", unread: 2 }, { id: "private", name: "Hidden", hidden: true }],
    groups: [{ id: "launch", name: "Launch", unread: true }],
  },
  dispatch: vi.fn(), openBotRow: vi.fn(),
}));
vi.mock("@/state/store", () => ({ useStore: () => mocks }));
vi.mock("@/state/thread-navigation", () => ({ openBotRow: mocks.openBotRow }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => h("span", { "data-avatar": "" }) }));
const { MobileConversationStrip } = await import("./MobileConversationStrip");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  mocks.state.activeView = "chat";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); });

it("keeps hidden bots out and labels the current conversation", () => {
  act(() => root.render(h(MobileConversationStrip)));
  expect(host.querySelector('[data-mobile-conversation="private"]')).toBeNull();
  const selected = host.querySelector('[data-mobile-conversation="pepper"]')!;
  expect(selected.getAttribute("aria-current")).toBe("true");
  expect(selected.textContent).toBe("Pepper");
});

it("opens bots through the existing activity-aware thread routing", () => {
  const closeDrawer = vi.fn();
  act(() => root.render(h(MobileConversationStrip, { onSelect: closeDrawer })));
  act(() => host.querySelector<HTMLButtonElement>('[data-mobile-conversation="pepper"]')!.click());
  expect(mocks.openBotRow).toHaveBeenCalledExactlyOnceWith(mocks.dispatch, mocks.state.bots[0], true, true);
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(closeDrawer).toHaveBeenCalledExactlyOnceWith();
});

it("selects a group without rewriting its thread selection", () => {
  const closeDrawer = vi.fn();
  act(() => root.render(h(MobileConversationStrip, { onSelect: closeDrawer })));
  const group = host.querySelector<HTMLButtonElement>('[data-mobile-conversation="launch"]')!;
  expect(group.hasAttribute("data-unread")).toBe(true);
  act(() => group.click());
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: "launch" });
  expect(closeDrawer).toHaveBeenCalledExactlyOnceWith();
});

it("does not label the old selection current on a different page", () => {
  mocks.state.activeView = "music";
  act(() => root.render(h(MobileConversationStrip)));
  expect(host.querySelector("[aria-current]")).toBeNull();
});
