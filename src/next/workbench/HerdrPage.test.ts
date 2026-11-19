// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ useStore: () => ({ dispatch: vi.fn() }) }));
const fixture = vi.hoisted(() => ({ requests: [] as { path: string; body?: unknown }[], sessions: [] as unknown[] }));
vi.mock("../foundation/api", () => ({ apiClient: () => ({ request: async (path: string, options?: { body?: unknown }) => {
  fixture.requests.push({ path, body: options?.body });
  if (options?.body && path === "/herdr/sessions") {
    const session = { id: "session-1", title: "修复问题", project: "/fixture/project", tool: "codex", terminalId: "terminal-1", createdAt: "2026-11-16", conversation: true };
    fixture.sessions.push(session); return { session };
  }
  return { sessions: fixture.sessions };
} }) }));
vi.mock("../personal/foundation", () => ({ useEnvironments: () => ({ status: "ready", data: [{ kind: "local", tools: [{ name: "codex", status: "installed" }] }] }) }));
vi.mock("./HerdrConversation", () => ({ HerdrConversation: ({ session, draft, onDraftChange }: { session: { id: string }; draft: string; onDraftChange(text: string): void }) => h("div", null, `conversation:${session.id}`, h("input", { "aria-label": "draft", value: draft, onChange: (event: { target: { value: string } }) => onDraftChange(event.target.value) })) }));
vi.mock("./terminal-registry", () => { const connection = { state: { kind: "failed", message: "fixture disconnected" }, onEvent: () => () => {} }; return ({ useTerminalRegistry: () => ({ bindings: { "terminal-1": { connection, lease: { kind: "observing" } } }, acquire: vi.fn(), release: vi.fn(), retry: vi.fn() }) }); });
vi.mock("./TerminalSurface", () => ({ TerminalSurface: () => h("div", null, "native-terminal") }));
const { HerdrPage } = await import("./HerdrPage");
let root: Root; let host: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); sessionStorage.clear(); });
it("dismisses the computer menu on an outside press and Escape", async () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(h(HerdrPage)));
  const menu = host.querySelector<HTMLDetailsElement>(".herdr-machine details")!;
  const open = async () => {
    await act(async () => menu.querySelector("summary")!.click());
    expect(menu.open).toBe(true);
  };
  await open();
  await act(async () => menu.querySelector("button")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(menu.open).toBe(true);
  await act(async () => host.querySelector("main")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(menu.open).toBe(false);
  await open();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  expect(menu.open).toBe(false);
  await open();
  await act(async () => menu.querySelector("summary")!.click());
  expect(menu.open).toBe(false);
});
it("creates one project session, switches views without restarting and restores the selection", async () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(h(HerdrPage)));
  const click = async (text: string) => { const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!; await act(async () => button.click()); };
  await click("新建会话");
  const project = host.querySelector<HTMLInputElement>('input[placeholder="/path/to/project"]')!;
  await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(project, "/fixture/project"); project.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await click("对话");
  expect(host.textContent).toContain("conversation:session-1");
  await act(async () => { const input = host.querySelector<HTMLInputElement>('[aria-label="draft"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "未发送的文字"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await click("终端"); expect(host.textContent).toContain("native-terminal");
  expect(host.textContent).toContain("连接失败：fixture disconnected");
  await click("对话"); expect(host.textContent).toContain("conversation:session-1");
  expect(host.querySelector<HTMLInputElement>('[aria-label="draft"]')!.value).toBe("未发送的文字");
  expect(fixture.requests.filter(item => item.path === "/herdr/sessions" && item.body)).toHaveLength(1);
  expect(localStorage.getItem("eac-herdr-session")).toBe("session-1");
  await act(async () => { root.unmount(); root = createRoot(host); root.render(h(HerdrPage)); });
  expect(host.textContent).toContain("conversation:session-1");
  await click("终端");
  await click("在此项目新建会话");
  expect(host.querySelector<HTMLInputElement>('input[placeholder="/path/to/project"]')!.value).toBe("/fixture/project");
});

it("tiles four existing sessions and requests delegation through the focused agent", async () => {
  fixture.sessions = Array.from({ length: 4 }, (_, i) => ({
    id: `s${i}`, title: `Agent ${i}`, project: "/fixture/project", tool: "codex",
    terminalId: `term${i}`, nativeAddress: `t${i + 1}`, createdAt: "2026-11-16", conversation: true,
  }));
  localStorage.setItem("eac-herdr-session", "s0");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(h(HerdrPage)));
  sessionStorage.setItem("eac-herdr-panes:/fixture/project", JSON.stringify(["s0"]));
  const button = host.querySelector<HTMLButtonElement>('nav[aria-label="分屏工作区"] button')!;
  await act(async () => button.click());
  const picker = host.querySelector<HTMLSelectElement>('[aria-label="添加已有会话"]')!;
  expect(host.querySelectorAll(".herdr-grid-pane")).toHaveLength(4);
  expect(picker.disabled).toBe(true);
  const sender = host.querySelector<HTMLSelectElement>('[aria-label="发送终端"]')!;
  await act(async () => { sender.value = "s1"; sender.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelector('[aria-label="协作目标"] option[value="s1"]')).toBeNull();
  const input = host.querySelector<HTMLInputElement>('[aria-label="协作任务"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "检查登录");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector(".herdr-delegate")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(fixture.requests.at(-1)).toMatchObject({path: "/herdr/sessions/s1/messages", body: {text: expect.stringMatching(/t1.*t2.*\n检查登录/s)}});
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="协作模式"] button')].find(b => b.textContent === "团队统筹")!.click());
  {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="主 Agent"]')!;
    await act(async () => { select.value = "s2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  }
  await act(async () => {
    const task = host.querySelector<HTMLInputElement>('[aria-label="总任务"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(task, "分工检查");
    task.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector(".herdr-delegate")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(fixture.requests.at(-1)).toMatchObject({ path: "/herdr/sessions/s2/messages", body: { text: expect.stringMatching(/主 Agent.*t3.*t1.*t2.*t4.*统一回复.*分工检查/s) } });
  expect(host.querySelectorAll(".herdr-projects > section .herdr-session")).toHaveLength(0);
  const toggle = host.querySelector<HTMLButtonElement>(".herdr-grid-nav-row [aria-expanded]")!;
  await act(async () => toggle.click());
  expect(host.querySelector(".herdr-grid-members")).toBeNull();
  await act(async () => toggle.click());
  await act(async () => host.querySelectorAll<HTMLButtonElement>(".herdr-grid-members button")[3].click());
  expect(host.querySelectorAll(".herdr-grid-pane")).toHaveLength(0);
  await act(async () => button.click());
  expect([...host.querySelectorAll(".herdr-grid-pane > header strong")].map(el => el.textContent)).toEqual(["Agent 0", "Agent 1", "Agent 2", "Agent 3"]);
  expect(host.querySelector('.herdr-grid-pane[data-active="true"] strong')?.textContent).toBe("Agent 3");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="移除面板：Agent 3"]')!.click());
  expect(host.querySelectorAll(".herdr-grid-pane")).toHaveLength(3);
  expect(host.querySelector<HTMLSelectElement>('[aria-label="添加已有会话"]')!.disabled).toBe(false);
});
