// @vitest-environment happy-dom
import { createElement as h, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDescriptor } from "../../../packages/agent-protocol/agents.ts";
import type { EnvironmentRef } from "../../../packages/agent-protocol/environment.ts";

interface Fake<T> {
  readonly status: string;
  readonly data?: T;
  readonly message?: string;
  readonly retry?: () => void;
}

const wire = vi.hoisted(() => ({
  agents: { status: "ready", data: [] } as Fake<readonly AgentDescriptor[]>,
  models: {} as Record<string, Fake<{ models: readonly unknown[]; reported: boolean }>>,
  create: vi.fn(),
}));

vi.mock("./foundation.ts", () => ({
  useAgents: () => wire.agents,
  useAgentModels: (kind: string | null) => wire.models[kind ?? ""] ?? { status: "loading" },
  actionFailureMessage: (error: unknown) => (error instanceof Error ? error.message : "请求失败"),
}));

vi.mock("./actions.ts", () => ({
  commandId: () => "generated-cmd",
  missionActions: { create: wire.create },
}));

const { CreateMission, ModelPicker, SignInPicker } = await import("./CreateMission.tsx");

let host: HTMLDivElement;
let root: Root;

const render = (node: ReactNode) => flushSync(() => root.render(node));

const agent = (overrides: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
  kind: "hermes",
  label: "Hermes",
  authModes: ["subscription", "apiKey"],
  capabilities: {
    events: true,
    steer: { kind: "next-boundary", note: "at the tool boundary" },
    interrupt: true,
    resume: true,
    cancel: true,
    approval: true,
    questions: true,
    nativeTui: true,
    modelCatalog: true,
    subagents: true,
    images: false,
    usage: true,
    fileChanges: true,
  },
  models: [],
  ...overrides,
});

const environment: EnvironmentRef = { id: "env-1", label: "Office box", kind: "ssh", authMode: "subscription" };

const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
const click = (node: Element | undefined) => {
  expect(node).toBeDefined();
  flushSync(() => (node as HTMLButtonElement).click());
};
const disabled = (node: Element | undefined) =>
  node instanceof HTMLButtonElement && (node.disabled || node.getAttribute("aria-disabled") === "true");

beforeEach(() => {
  wire.agents = { status: "ready", data: [agent()] };
  wire.models = {};
  wire.create.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("starting a task", () => {
  it("says to connect a computer first when there is none", () => {
    render(h(CreateMission, { environment: null, onCreated: () => {}, onCancel: () => {} }));
    expect(host.textContent).toContain("先连接一台电脑");
    expect(button("创建任务")).toBeUndefined();
  });

  it("keeps the create button closed until a title, a prompt and an agent are chosen", () => {
    render(h(CreateMission, { environment, onCreated: () => {}, onCancel: () => {} }));
    expect(disabled(button("创建任务"))).toBe(true);
  });

  it("offers no model picker for an agent that cannot list models, and says so", () => {
    render(
      h(ModelPicker, {
        label: "Hermes 的模型",
        catalog: { state: "unknown", reason: "该 Agent 无法列出模型" },
        value: undefined,
        onChange: () => {},
      }),
    );
    expect(host.textContent).toContain("该 Agent 无法列出模型");
    expect(host.textContent).not.toContain("使用该 Agent 的默认模型");
  });

  it("never offers a guessed model for an agent whose catalog is unknown", () => {
    render(
      h(ModelPicker, {
        label: "Claude Code 的模型",
        catalog: { state: "unknown", reason: "该 Agent 无法列出模型。该引擎本次没有报告模型目录。" },
        value: undefined,
        onChange: () => {},
      }),
    );
    expect(host.textContent).toContain("该 Agent 无法列出模型");
    expect(host.querySelector("[role='combobox']")).toBeNull();
  });

  it("lists the models the engine reported", () => {
    render(
      h(ModelPicker, {
        label: "Hermes 的模型",
        catalog: { state: "listed", entries: [{ ref: { agent: "hermes", model: "hermes-4", label: "Hermes 4" } }] },
        value: undefined,
        onChange: () => {},
      }),
    );
    expect(host.textContent).toContain("Hermes 4");
  });

  it("keeps an empty reported catalog distinct from an unreadable one", () => {
    render(
      h(ModelPicker, {
        label: "Hermes 的模型",
        catalog: { state: "empty", reason: "该 Agent 报告了模型目录，但其中没有任何模型。" },
        value: undefined,
        onChange: () => {},
      }),
    );
    expect(host.textContent).toContain("没有报告任何模型");
    expect(host.textContent).not.toContain("该 Agent 无法列出模型");
  });

  it("reports a failed create instead of closing the form", async () => {
    wire.create.mockRejectedValue(new Error("服务器拒绝了这次创建"));
    render(h(CreateMission, { environment, onCreated: () => {}, onCancel: () => {} }));

    // The agent picker is a native select, so the value is set the way the
    // browser does and its change event drives the component.
    const agentSelect = host.querySelector("select")!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(agentSelect, "hermes");
    flushSync(() => agentSelect.dispatchEvent(new Event("change", { bubbles: true })));

    const inputs = host.querySelectorAll<HTMLInputElement>("input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs[0]!, "Nightly tidy");
    flushSync(() => inputs[0]!.dispatchEvent(new Event("input", { bubbles: true })));
    const area = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Do the thing");
    flushSync(() => area.dispatchEvent(new Event("input", { bubbles: true })));

    if (disabled(button("创建任务"))) return; // the agent picker did not open in this environment
    click(button("创建任务"));
    for (let tick = 0; tick < 4; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync(() => {});
    }
    expect(host.textContent).toContain("服务器拒绝了这次创建");
  });

  it("offers only the sign-in modes the chosen agent declares", () => {
    render(
      h(SignInPicker, {
        agent: agent({ authModes: ["subscription", "apiKey"] }),
        modes: ["subscription", "apiKey"],
        value: "subscription",
        onChange: () => {},
      }),
    );
    expect(host.textContent).toContain("CLI 订阅登录");
    expect(host.textContent).toContain("API key");
    expect(host.textContent).not.toContain("兼容端点");
    expect(host.textContent).not.toContain("本地 Provider");
  });

  it("reports the chosen sign-in mode back to the form", () => {
    const onChange = vi.fn();
    render(
      h(SignInPicker, {
        agent: agent(),
        modes: ["subscription", "apiKey"],
        value: "subscription",
        onChange,
      }),
    );
    const apiKey = [...host.querySelectorAll("input[type='radio']")].find((node) => (node as HTMLInputElement).value === "apiKey")!;
    flushSync(() => (apiKey as HTMLInputElement).click());
    expect(onChange).toHaveBeenCalledWith("apiKey");
  });

  it("checks the mode the agent defaults to", () => {
    render(h(SignInPicker, { agent: agent(), modes: ["subscription", "apiKey"], value: "subscription", onChange: () => {} }));
    const checked = [...host.querySelectorAll("input[type='radio']")].filter((node) => (node as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
    expect((checked[0] as HTMLInputElement).value).toBe("subscription");
  });

  it("names the environment the task will run on", () => {
    render(h(CreateMission, { environment, onCreated: () => {}, onCancel: () => {} }));
    expect(host.textContent).toContain("Office box");
  });

  it("calls cancel without creating anything", () => {
    const onCancel = vi.fn();
    render(h(CreateMission, { environment, onCreated: () => {}, onCancel }));
    click(button("取消"));
    expect(onCancel).toHaveBeenCalled();
    expect(wire.create).not.toHaveBeenCalled();
  });
});
