// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setShellView } from "@/lib/shell-view";
import { ShellViewSwitch } from "./ShellViewSwitch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  setShellView("sidebar");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("keeps named native tabs when collapsed to icon controls", () => {
  act(() => root.render(h(ShellViewSwitch, { compact: true })));
  const board = host.querySelector<HTMLButtonElement>('[data-segment="board"]')!;
  expect(board.getAttribute("aria-label")).toBe("Projects");
  expect(board.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(board.textContent).toBe("");
  act(() => board.click());
  expect(board.getAttribute("aria-selected")).toBe("true");
  expect(localStorage.getItem("eacbot.shellView")).toBe("board");
});

it("retains text labels in the normal-width sidebar", () => {
  act(() => root.render(h(ShellViewSwitch, {})));
  expect(host.querySelector('[data-segment="board"]')?.textContent).toBe("Projects");
  expect(host.querySelector('[data-segment="sidebar"]')?.textContent).toBe("Chat");
});
