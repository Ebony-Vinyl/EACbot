// @vitest-environment happy-dom
import { createElement as h, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopFrame, DesktopFullScreen, DesktopPreview, HandoffCard, type DesktopState } from "./DesktopEntry.tsx";

let host: HTMLDivElement;
let root: Root;

const render = (node: ReactNode) => flushSync(() => root.render(node));

const state = (overrides: Partial<DesktopState> = {}): DesktopState => ({ status: "running", lastFrameUrl: "data:image/png;base64,AA", ...overrides });

const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
const click = (node: Element | undefined) => {
  expect(node).toBeDefined();
  flushSync(() => (node as HTMLButtonElement).click());
};
const disabled = (node: Element | undefined) =>
  node instanceof HTMLButtonElement && (node.disabled || node.getAttribute("aria-disabled") === "true");

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("the handoff card", () => {
  it("offers take over, done and skip as three different answers", () => {
    const onDecide = vi.fn();
    render(h(HandoffCard, { state: state(), onDecide }));
    click(button("接手"));
    click(button("我做完了"));
    click(button("跳过这一步"));
    expect(onDecide.mock.calls.map((call) => call[0])).toEqual(["takeOver", "done", "skip"]);
  });

  it("says what skipping means, so it cannot be mistaken for finishing", () => {
    render(h(HandoffCard, { state: state(), onDecide: () => {} }));
    expect(host.textContent).toContain("Agent 会跳过它");
  });

  it("closes take over when the desktop is not available", () => {
    render(h(HandoffCard, { state: state({ status: "off", lastFrameUrl: undefined }), onDecide: () => {} }));
    expect(disabled(button("接手"))).toBe(true);
  });

  it("still allows finishing or skipping when the desktop is down", () => {
    render(h(HandoffCard, { state: state({ status: "error" }), onDecide: () => {} }));
    expect(disabled(button("我做完了"))).toBe(false);
    expect(disabled(button("跳过这一步"))).toBe(false);
  });
});

describe("the picture", () => {
  it("scales by its container rather than a transform, so pointer coordinates stay true", () => {
    render(h(DesktopFrame, { state: state() }));
    const img = host.querySelector("img")!;
    expect(img.className).toContain("object-contain");
    expect(img.className).not.toContain("scale-");
    expect(host.querySelector("[data-testid='desktop-frame']")?.className).toContain("aspect-video");
  });

  it("keeps the last frame on screen while reconnecting", () => {
    render(h(DesktopFrame, { state: state({ status: "reconnecting" }) }));
    expect(host.querySelector("img")).not.toBeNull();
    expect(host.querySelector("[data-testid='desktop-reconnecting']")).not.toBeNull();
    expect(host.textContent).toContain("正在重新连接");
  });

  it("says the picture has not arrived instead of showing a blank box as success", () => {
    render(h(DesktopFrame, { state: { status: "starting" } }));
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("正在连接这台电脑的画面");
  });

  it("gives the frame its own focus and an accessible name", () => {
    render(h(DesktopFrame, { state: state() }));
    const frame = host.querySelector("[data-testid='desktop-frame']")!;
    expect(frame.getAttribute("tabindex")).toBe("0");
    expect(frame.getAttribute("aria-label")).toContain("运行中");
  });
});

describe("the preview and the full-screen view share one state", () => {
  it("the preview reports a reconnect and offers a retry", () => {
    const onRetry = vi.fn();
    render(h(DesktopPreview, { state: state({ status: "reconnecting" }), onExpand: () => {}, onRetry }));
    expect(host.textContent).toContain("重连不会重放你的旧输入");
    const retries = [...host.querySelectorAll("button")].filter((node) => node.textContent?.trim() === "重试");
    flushSync(() => retries[retries.length - 1]!.click());
    expect(onRetry).toHaveBeenCalled();
  });

  it("the full-screen view shows the same frame and reports the same status", () => {
    render(h(DesktopFullScreen, { state: state({ status: "reconnecting" }), onExit: () => {}, onRetry: () => {}, onRelease: () => {} }));
    expect(host.querySelector("img")).not.toBeNull();
    expect(host.textContent).toContain("重连中");
  });

  it("offers to hand control back only while this client holds it", () => {
    render(h(DesktopFullScreen, { state: state({ controlling: false }), onExit: () => {}, onRetry: () => {}, onRelease: () => {} }));
    expect(disabled(button("交还控制"))).toBe(true);
    const held = h(DesktopFullScreen, { state: state({ controlling: true }), onExit: () => {}, onRetry: () => {}, onRelease: () => {} });
    flushSync(() => root.render(held));
    expect(disabled(button("交还控制"))).toBe(false);
  });

  it("keeps the controls outside the picture so keyboard focus is never trapped", () => {
    render(h(DesktopFullScreen, { state: state(), onExit: () => {}, onRetry: () => {}, onRelease: () => {} }));
    const frame = host.querySelector("[data-testid='desktop-frame']")!;
    expect(frame.contains(button("退出全屏")!)).toBe(false);
  });
});
