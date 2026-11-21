// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationSidebar } from "./ConversationSidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("isolates only the closed mobile sidebar", () => {
  act(() => root.render(h(ConversationSidebar, { mobile: true, open: false, onClose: vi.fn(), children: h("button", {}, "Board item") })));
  const panel = host.firstElementChild!;
  expect(panel.hasAttribute("inert")).toBe(true);
  expect(panel.getAttribute("aria-hidden")).toBe("true");
  act(() => root.render(h(ConversationSidebar, { mobile: false, open: false, onClose: vi.fn(), children: h("button", {}, "Board item") })));
  expect(panel.hasAttribute("inert")).toBe(false);
  expect(panel.hasAttribute("aria-hidden")).toBe(false);
});

it("closes the mobile drawer on Escape from a board descendant", () => {
  const onClose = vi.fn();
  act(() => root.render(h(ConversationSidebar, { mobile: true, open: true, onClose, children: h("button", {}, "Board item") })));
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => { host.querySelector("button")!.dispatchEvent(event); });
  expect(onClose).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
});

it("leaves Escape with the nested menu until that menu closes", () => {
  const onClose = vi.fn();
  act(() => root.render(h(ConversationSidebar, { mobile: true, open: true, onClose, children: h("div", {},
    h("button", {}, "Board item"), h("div", { role: "menu" }, h("button", { role: "menuitem" }, "Edit")),
  ) })));
  act(() => { host.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(onClose).not.toHaveBeenCalled();
});

it("keeps focus out of a visible inert outgoing sidebar", () => {
  const rect = new DOMRect(0, 0, 20, 20);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(Object.assign([rect], { item: () => rect }));
  act(() => root.render(h(ConversationSidebar, { mobile: true, open: true, onClose: vi.fn(), children: h("div", {},
    h("div", { inert: true, "aria-hidden": true }, h("button", {}, "Leaving")),
    h("button", {}, "Current"),
  ) })));
  const current = [...host.querySelectorAll("button")].find((button) => button.textContent === "Current")!;
  expect(document.activeElement).toBe(current);
  act(() => { current.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(document.activeElement).toBe(current);
});
