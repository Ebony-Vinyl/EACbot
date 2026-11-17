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
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); });
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
