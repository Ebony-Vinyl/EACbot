// @vitest-environment happy-dom
import { createElement as h, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDescriptor } from "../../../packages/agent-protocol/agents.ts";


const wire = vi.hoisted(() => ({
  agents: { status: "ready", data: [] } as Fake<readonly AgentDescriptor[]>,
  models: {} as Record<string, Fake<{ models: readonly unknown[]; reported: boolean }>>,
}));

vi.mock("../personal/foundation.ts", () => ({
  useAgents: () => wire.agents,
  useAgentModels: (kind: string | null) => wire.models[kind ?? ""] ?? { status: "loading" },
}));

const { AgentSettings } = await import("./AgentSettings.tsx");

/** The mocked hooks return these; a test sets the state it wants to exercise
 * without building the transport. */
interface Fake<T> {
  readonly status: string;
  readonly data?: T;
  readonly message?: string;
  readonly retry?: () => void;
  readonly refresh?: () => void;
}

let host: HTMLDivElement;
let root: Root;

const render = (node: ReactNode) => flushSync(() => root.render(node));

beforeEach(() => {
  wire.agents = { status: "ready", data: [] };
  wire.models = {};
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

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

describe("agent rows", () => {
  it("shows the agent's name and kind", () => {
    wire.agents = { status: "ready", data: [agent()] };
    render(h(AgentSettings));
    expect(host.textContent).toContain("Hermes");
    expect(host.textContent).toContain("hermes");
  });

  it("claims nothing about installation until the computer is probed", () => {
    wire.agents = { status: "ready", data: [agent()] };
    render(h(AgentSettings));
    expect(host.textContent).toContain("未检查");
    expect(host.textContent).toContain("还没有在这台电脑上检查安装状态");
    expect(host.textContent).not.toContain("已安装");
  });

  it("shows the version the probe reported", () => {
    wire.agents = { status: "ready", data: [agent()] };
    render(h(AgentSettings, { tools: [{ name: "hermes", status: "installed", path: "/usr/local/bin/hermes", version: "0.9.1" }] }));
    expect(host.textContent).toContain("已安装");
    expect(host.textContent).toContain("0.9.1");
  });

  it("says the executable is missing instead of offering to use it", () => {
    wire.agents = { status: "ready", data: [agent()] };
    render(h(AgentSettings, { tools: [{ name: "hermes", status: "missing", path: null, version: null }] }));
    expect(host.textContent).toContain("未安装");
    expect(host.textContent).toContain("还没有安装");
  });

  it("reports a probe failure with its reason", () => {
    wire.agents = { status: "ready", data: [agent()] };
    render(h(AgentSettings, { tools: [{ name: "hermes", status: "probeFailed", path: null, version: null, detail: "timed out" }] }));
    expect(host.textContent).toContain("没能确认安装状态");
    expect(host.textContent).toContain("timed out");
  });

  it("lists only the sign-in modes the agent declares, naming each one", () => {
    wire.agents = { status: "ready", data: [agent({ authModes: ["subscription", "apiKey"] })] };
    render(h(AgentSettings));
    expect(host.textContent).toContain("CLI 订阅登录");
    expect(host.textContent).toContain("API key");
    expect(host.textContent).not.toContain("兼容端点");
  });

  it("explains that a subscription is not billed by EACbot and a key belongs to that agent", () => {
    wire.agents = { status: "ready", data: [agent()] };
    render(h(AgentSettings));
    expect(host.textContent).toContain("不经过 EACbot 计费");
    expect(host.textContent).toContain("key 属于这个 Agent 实例");
  });

  it("offers no purchase, plan or upgrade entry anywhere", () => {
    wire.agents = { status: "ready", data: [agent()] };
    render(h(AgentSettings));
    for (const word of ["购买", "套餐", "升级", "订阅套餐", "计费方案", "云电脑供应商"]) {
      expect(host.textContent).not.toContain(word);
    }
  });
});

describe("the model list", () => {
  it("says the agent cannot list models when the response reports none", () => {
    wire.agents = { status: "ready", data: [agent({ capabilities: { ...agent().capabilities, modelCatalog: false } })] };
    wire.models.hermes = { status: "ready", data: { models: [], reported: false } };
    render(h(AgentSettings));
    expect(host.textContent).toContain("该 Agent 无法列出模型");
    expect(host.textContent).not.toContain("选择模型");
  });

  it("says it cannot list models even before asking, for an agent that never can", () => {
    wire.agents = { status: "ready", data: [agent({ capabilities: { ...agent().capabilities, modelCatalog: false } })] };
    render(h(AgentSettings));
    expect(host.textContent).toContain("该 Agent 无法列出模型");
  });

  it("shows a loading state while the catalog is being read", () => {
    wire.agents = { status: "ready", data: [agent()] };
    render(h(AgentSettings));
    expect(host.textContent).toContain("正在读取模型目录");
  });

  it("lists the models the engine reported", () => {
    wire.agents = { status: "ready", data: [agent()] };
    wire.models.hermes = {
      status: "ready",
      data: { models: [{ ref: { agent: "hermes", model: "hermes-4", label: "Hermes 4" } }], reported: true },
    };
    render(h(AgentSettings));
    expect(host.textContent).toContain("Hermes 4");
    expect(host.textContent).not.toContain("该 Agent 无法列出模型");
  });

  it("keeps an empty reported catalog distinct from an unreadable one", () => {
    wire.agents = { status: "ready", data: [agent()] };
    wire.models.hermes = { status: "ready", data: { models: [], reported: true } };
    render(h(AgentSettings));
    expect(host.textContent).toContain("没有报告任何模型");
    expect(host.textContent).not.toContain("该 Agent 无法列出模型");
  });

  it("never invents a model for an agent whose catalog could not be read", () => {
    wire.agents = { status: "ready", data: [agent({ capabilities: { ...agent().capabilities, modelCatalog: false } })] };
    wire.models.hermes = { status: "ready", data: { models: [], reported: false } };
    render(h(AgentSettings));
    expect(host.querySelector("[data-testid='model-unavailable-hermes']")).not.toBeNull();
  });
});

describe("the four states", () => {
  it("shows a loading state while the list is being read", () => {
    wire.agents = { status: "loading" };
    render(h(AgentSettings));
    expect(host.textContent).toContain("正在读取 Agent 列表");
  });

  it("shows the pairing message when the device is not authorised", () => {
    wire.agents = { status: "unauthorized" };
    render(h(AgentSettings));
    expect(host.textContent).toContain("这个设备还没有配对");
  });

  it("shows the failure and a retry when the read failed", () => {
    const retry = vi.fn();
    wire.agents = { status: "error", message: "服务器没有响应", retry };
    render(h(AgentSettings));
    expect(host.textContent).toContain("服务器没有响应");
    flushSync(() => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === "重试")!.click());
    expect(retry).toHaveBeenCalled();
  });

  it("says the server reported no agents rather than showing a broken list", () => {
    wire.agents = { status: "ready", data: [] };
    render(h(AgentSettings));
    expect(host.textContent).toContain("服务器没有报告任何 Agent");
  });
});
