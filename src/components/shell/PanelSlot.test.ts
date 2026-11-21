// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PanelSlot } from "./PanelSlot";

type FakeAnimation = Animation & { cancel: ReturnType<typeof vi.fn> };
let host: HTMLDivElement;
let root: Root;
let created: FakeAnimation[];
let originalAnimate: PropertyDescriptor | undefined;

beforeEach(() => {
  created = [];
  originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: () => {
      const instance = {
        oncancel: null as Animation["oncancel"],
        onfinish: null as Animation["onfinish"],
        cancel: vi.fn(() => instance.oncancel?.(new Event("cancel") as AnimationPlaybackEvent)),
      } as unknown as FakeAnimation;
      created.push(instance);
      return instance;
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  vi.restoreAllMocks();
});

const render = (open: boolean) => act(() => root.render(createElement(PanelSlot, { open, side: "right", children: createElement("button", null, "Panel action") })));

describe("PanelSlot motion", () => {
  it("makes closing content hidden and inert on the first closed render", () => {
    render(true);
    const slot = host.querySelector<HTMLElement>("[data-panel-slot]")!;
    const inner = slot.firstElementChild as HTMLElement;

    render(false);

    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(slot.inert).toBe(true);
    expect(inner.classList.contains("pointer-events-auto")).toBe(false);
  });

  it("cancels its active animation when unmounted", () => {
    render(true);
    const active = created[0];
    expect(active).toBeDefined();

    act(() => root.unmount());

    expect(active.cancel).toHaveBeenCalledOnce();
  });
});
