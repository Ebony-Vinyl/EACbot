// @vitest-environment happy-dom
import { createElement as h, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalFeedItem, QuestionFeedItem } from "./feed.ts";
import { ApprovalCard, QuestionCard } from "./cards.tsx";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const render = (child: ReactNode) => flushSync(() => root.render(child));

const approval = (overrides: Partial<ApprovalFeedItem> = {}): ApprovalFeedItem => ({
  kind: "approval",
  id: "e1",
  at: "2026-11-15T10:00:00Z",
  approvalId: "ap-1",
  action: "write /etc/hosts",
  detail: "The agent wants to edit a system file.",
  status: "pending",
  ...overrides,
});

const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
/** A disabled control may use the native attribute or `aria-disabled`; both
 * keep it out of reach, so a test accepts either. */
const isDisabled = (node: Element | undefined) =>
  node instanceof HTMLButtonElement && (node.disabled || node.getAttribute("aria-disabled") === "true");
const click = (node: Element | undefined) => {
  expect(node).toBeDefined();
  flushSync(() => (node as HTMLButtonElement).click());
};

describe("an approval card", () => {
  it("offers allow, deny and answer while it is pending", () => {
    render(h(ApprovalCard, { approval: approval(), onDecide: () => {} }));
    expect(button("允许")).toBeDefined();
    expect(button("拒绝")).toBeDefined();
    expect(button("改为回答")).toBeDefined();
  });

  it("sends allow from the allow button", () => {
    const onDecide = vi.fn();
    render(h(ApprovalCard, { approval: approval(), onDecide }));
    click(button("允许"));
    expect(onDecide).toHaveBeenCalledWith("allow");
  });

  it("sends deny from the deny button", () => {
    const onDecide = vi.fn();
    render(h(ApprovalCard, { approval: approval(), onDecide }));
    click(button("拒绝"));
    expect(onDecide).toHaveBeenCalledWith("deny");
  });

  it("opens the answer field and keeps the send button closed until there is text", () => {
    const onDecide = vi.fn();
    render(h(ApprovalCard, { approval: approval(), onDecide }));
    click(button("改为回答"));
    const send = button("发送回答");
    expect(send).toBeDefined();
    expect(isDisabled(send)).toBe(true);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("sends the answer text once it is typed", () => {
    const onDecide = vi.fn();
    render(h(ApprovalCard, { approval: approval(), onDecide }));
    click(button("改为回答"));
    const field = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "  use staging  ");
    flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
    click(button("发送回答"));
    expect(onDecide).toHaveBeenCalledWith("answer", "use staging");
  });

  it("offers nothing once the approval is decided", () => {
    render(h(ApprovalCard, { approval: approval({ status: "allowed" }), onDecide: () => {} }));
    expect(button("允许")).toBeUndefined();
    expect(host.textContent).toContain("已允许");
  });

  it("shows the decision the authority recorded, including an answer", () => {
    render(h(ApprovalCard, { approval: approval({ status: "answered", answer: "use staging" }) }));
    expect(host.textContent).toContain("已回答");
    expect(host.textContent).toContain("use staging");
  });

  it("offers nothing when the screen passed no handler, even while pending", () => {
    render(h(ApprovalCard, { approval: approval() }));
    expect(button("允许")).toBeUndefined();
    expect(host.textContent).toContain("等你决定");
  });

  it("does not fire a second decision while one is in flight", () => {
    const onDecide = vi.fn();
    render(h(ApprovalCard, { approval: approval(), onDecide, isBusy: true }));
    expect(isDisabled(button("允许"))).toBe(true);
    expect(isDisabled(button("拒绝"))).toBe(true);
    expect(isDisabled(button("改为回答"))).toBe(true);
  });
});

describe("a question card", () => {
  const question = (overrides: Partial<QuestionFeedItem> = {}): QuestionFeedItem => ({
    kind: "question",
    id: "q1",
    at: "2026-11-15T10:00:00Z",
    question: "Which branch should I use?",
    ...overrides,
  });

  it("sends a typed answer", () => {
    const onAnswer = vi.fn();
    render(h(QuestionCard, { question: question(), onAnswer }));
    const field = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "main");
    flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
    click(button("发送回答"));
    expect(onAnswer).toHaveBeenCalledWith("main");
  });

  it("keeps the send button closed with only whitespace", () => {
    render(h(QuestionCard, { question: question(), onAnswer: () => {} }));
    const field = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "   ");
    flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
    expect(isDisabled(button("发送回答"))).toBe(true);
  });

  it("shows the answer once the run received one", () => {
    render(h(QuestionCard, { question: question({ answer: "main" }) }));
    expect(host.textContent).toContain("main");
    expect(button("发送回答")).toBeUndefined();
  });

  it("offers no input when the screen passed no handler", () => {
    render(h(QuestionCard, { question: question() }));
    expect(host.querySelector("textarea")).toBeNull();
  });
});
