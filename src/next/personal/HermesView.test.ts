// @vitest-environment happy-dom
import { createElement as h, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Mission, MissionTreeNode } from "../../../packages/agent-protocol/mission.ts";
import type { MissionLogEntry } from "../../../packages/agent-protocol/events.ts";
import type { CommandResult } from "../../../packages/agent-protocol/commands.ts";
import type { MissionActions } from "./port.ts";

const wire = vi.hoisted(() => ({
  mission: { status: "ready", data: undefined } as Fake<Mission>,
  history: { status: "ready", data: { events: [], nextSeq: 0 } } as Fake<{ events: MissionLogEntry[]; nextSeq: number }>,
  tree: { status: "ready", data: undefined } as Fake<MissionTreeNode>,
}));

vi.mock("./foundation.ts", () => ({
  useMission: () => wire.mission,
  useMissionHistory: () => wire.history,
  useMissionTree: () => wire.tree,
  actionFailureMessage: (error: unknown) => (error instanceof Error ? error.message : "请求失败"),
}));

vi.mock("../shared/status.ts", () => ({
  missionStatusTone: () => "accent",
  statusLabel: (status: string) => status,
}));

const { HermesView } = await import("./HermesView.tsx");

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

const mission = (overrides: Partial<Mission> = {}): Mission => ({
  protocolVersion: 1,
  id: "m-1",
  rootMissionId: "m-1",
  depth: 0,
  title: "Sort the inbox",
  prompt: "Sort it",
  agent: "hermes",
  environment: { id: "env-1", label: "box", kind: "ssh", authMode: "subscription" },
  status: "running",
  revision: 7,
  createdAt: "2026-11-15T09:00:00Z",
  updatedAt: "2026-11-15T09:05:00Z",
  acceptedAt: "2026-11-15T09:00:00Z",
  runIds: ["r-1"],
  childIds: [],
  artifactIds: [],
  approvalIds: [],
  wakeGeneration: 0,
  ...overrides,
});

const entry = (type: string, payload: Record<string, unknown>, at = "2026-11-15T10:00:00Z"): MissionLogEntry => ({
  seq: 1,
  eventId: `e-${type}`,
  missionId: "m-1",
  runId: "r-1",
  at,
  source: "adapter",
  type,
  payload,
});

const accepted = (result: Partial<CommandResult> = {}): CommandResult => ({
  commandId: "c",
  type: "run.steer",
  missionId: "m-1",
  appliedAt: "2026-11-15T10:00:00Z",
  missionRevision: 8,
  replayed: false,
  ...result,
});

/** Each method is a mock, so a test reads what it was called with. */
type Mocked = { [K in keyof MissionActions]: ReturnType<typeof vi.fn> };

function actions(): Mocked {
  return {
    create: vi.fn(),
    steer: vi.fn().mockResolvedValue(accepted()),
    interrupt: vi.fn().mockResolvedValue(accepted()),
    resume: vi.fn().mockResolvedValue(accepted()),
    cancel: vi.fn().mockResolvedValue(accepted()),
    submitInput: vi.fn().mockResolvedValue(accepted()),
    resolve: vi.fn().mockResolvedValue(accepted()),
    reconcile: vi.fn().mockResolvedValue(accepted()),
  };
}

const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
const click = (node: Element | undefined) => {
  expect(node).toBeDefined();
  flushSync(() => (node as HTMLButtonElement).click());
};
async function settle() {
  for (let tick = 0; tick < 4; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}
function typeIntoComposer(value: string) {
  const field = host.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
}

beforeEach(() => {
  wire.mission = { status: "ready", data: mission() };
  wire.history = { status: "ready", data: { events: [], nextSeq: 0 } };
  wire.tree = { status: "ready", data: { mission: mission(), children: [] } };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("choosing a mission", () => {
  it("shows an idle pane when nothing is selected", () => {
    render(h(HermesView, { missionId: null }));
    expect(host.textContent).toContain("还没有选中的任务");
  });

  it("shows the mission's title, status, agent and model", () => {
    wire.mission = { status: "ready", data: mission({ model: { agent: "hermes", model: "hermes-4", label: "Hermes 4" } }) };
    render(h(HermesView, { missionId: "m-1" }));
    expect(host.textContent).toContain("Sort the inbox");
    expect(host.textContent).toContain("Hermes 4");
    expect(host.textContent).toContain("box");
  });
});

describe("the conversation", () => {
  it("shows the prompt, then the assistant's output", () => {
    wire.history = {
      status: "ready",
      data: { events: [entry("run.output", { text: "On it.", stream: "assistant" })], nextSeq: 1 },
    };
    render(h(HermesView, { missionId: "m-1" }));
    expect(host.textContent).toContain("Sort it");
    expect(host.textContent).toContain("On it.");
  });

  it("renders a tool call with its tool name", () => {
    wire.history = {
      status: "ready",
      data: {
        events: [
          entry("run.tool_call", { callId: "c1", tool: "bash", input: { command: "ls" } }),
          entry("run.tool_result", { callId: "c1", tool: "bash", ok: true, output: "a.txt" }),
        ],
        nextSeq: 2,
      },
    };
    render(h(HermesView, { missionId: "m-1" }));
    expect(host.querySelector("[data-testid='tool-row-c1']")).not.toBeNull();
    expect(host.textContent).toContain("bash");
  });

  it("renders an artifact row with its size", () => {
    wire.history = {
      status: "ready",
      data: { events: [entry("run.artifact", { artifactId: "f1", path: "out/report.md", bytes: 2048, mediaType: "text/markdown" })], nextSeq: 1 },
    };
    render(h(HermesView, { missionId: "m-1" }));
    expect(host.textContent).toContain("out/report.md");
    expect(host.textContent).toContain("2.0 kB");
  });

  it("summarizes child agents above the feed", () => {
    const child = mission({ id: "m-2", parentMissionId: "m-1", depth: 1, title: "Check tests", status: "failed" });
    wire.tree = { status: "ready", data: { mission: mission(), children: [{ mission: child, children: [] }] } };
    render(h(HermesView, { missionId: "m-1" }));
    expect(host.querySelector("[data-testid='child-summary']")).not.toBeNull();
    expect(host.textContent).toContain("失败 1");
  });

  it("lets a person jump to a child mission", () => {
    const child = mission({ id: "m-2", parentMissionId: "m-1", depth: 1, title: "Check tests", status: "running" });
    wire.tree = { status: "ready", data: { mission: mission(), children: [{ mission: child, children: [] }] } };
    const onSelectMission = vi.fn();
    render(h(HermesView, { missionId: "m-1", onSelectMission }));
    click(button("Check tests"));
    expect(onSelectMission).toHaveBeenCalledWith("m-2");
  });
});

describe("the four states of each read", () => {
  it("shows a loading state for the mission", () => {
    wire.mission = { status: "loading" };
    render(h(HermesView, { missionId: "m-1" }));
    expect(host.textContent).toContain("正在读取任务");
  });

  it("shows the mission's failure with a retry", () => {
    const retry = vi.fn();
    wire.mission = { status: "error", message: "服务器没有响应", retry };
    render(h(HermesView, { missionId: "m-1" }));
    expect(host.textContent).toContain("服务器没有响应");
    click(button("重试"));
    expect(retry).toHaveBeenCalled();
  });

  it("shows the pairing message when the device is not authorised", () => {
    wire.mission = { status: "unauthorized" };
    render(h(HermesView, { missionId: "m-1" }));
    expect(host.textContent).toContain("这个设备还没有配对");
  });

  it("keeps the mission header while the history page fails, and retries it separately", () => {
    const retry = vi.fn();
    wire.history = { status: "error", message: "对话记录读取失败", retry };
    render(h(HermesView, { missionId: "m-1" }));
    expect(host.textContent).toContain("Sort the inbox");
    expect(host.textContent).toContain("对话记录读取失败");
    click(button("重试"));
    expect(retry).toHaveBeenCalled();
  });

  it("shows an empty conversation without pretending the mission has no history", () => {
    render(h(HermesView, { missionId: "m-1" }));
    expect(host.textContent).toContain("Sort it");
  });
});

describe("acting on a mission", () => {
  it("steers with the revision the person saw", async () => {
    const api = actions();
    render(h(HermesView, { missionId: "m-1", actions: api as unknown as MissionActions }));
    typeIntoComposer("  also check the tests  ");
    click(button("发送"));
    await settle();
    expect(api.steer).toHaveBeenCalledTimes(1);
    const [missionId, input, command] = api.steer.mock.calls[0]!;
    expect(missionId).toBe("m-1");
    expect(input).toBe("also check the tests");
    expect(command.expectedRevision).toBe(7);
    expect(typeof command.commandId).toBe("string");
    expect(command.commandId.length).toBeGreaterThan(0);
  });

  it("interrupts with the revision and a command id", async () => {
    const api = actions();
    render(h(HermesView, { missionId: "m-1", actions: api as unknown as MissionActions }));
    click(button("中断"));
    await settle();
    const [, command] = api.interrupt.mock.calls[0]!;
    expect(command.expectedRevision).toBe(7);
    expect(command.commandId.length).toBeGreaterThan(0);
  });

  it("cancels the whole tree by default, and says so", async () => {
    const api = actions();
    render(h(HermesView, { missionId: "m-1", actions: api as unknown as MissionActions }));
    click(button("取消任务"));
    await settle();
    const [missionId, command, options] = api.cancel.mock.calls[0]!;
    expect(missionId).toBe("m-1");
    expect(command.expectedRevision).toBe(7);
    expect(options).toEqual({ cascade: true });
  });

  it("offers resume only when the mission is interrupted", () => {
    wire.mission = { status: "ready", data: mission({ status: "interrupted" }) };
    render(h(HermesView, { missionId: "m-1", actions: actions() as unknown as MissionActions }));
    expect(button("恢复")).toBeDefined();
    expect(button("中断")).toBeUndefined();
  });

  it("refuses to steer a finished mission and says why", () => {
    wire.mission = { status: "ready", data: mission({ status: "succeeded" }) };
    render(h(HermesView, { missionId: "m-1", actions: actions() as unknown as MissionActions }));
    expect(host.textContent).toContain("该任务已结束");
    expect(host.querySelector("textarea")?.hasAttribute("disabled")).toBe(true);
    expect(button("取消任务")).toBeUndefined();
  });

  it("keeps the composer open while a run is live", () => {
    render(h(HermesView, { missionId: "m-1", actions: actions() as unknown as MissionActions }));
    expect(host.querySelector("textarea")?.hasAttribute("disabled")).toBe(false);
  });

  it("says a stale revision means reloading, not retrying blind", async () => {
    const api = actions();
    api.steer = vi.fn().mockRejectedValue(new Error("这个任务已被其他地方修改，请重新载入后再试。"));
    render(h(HermesView, { missionId: "m-1", actions: api as unknown as MissionActions }));
    typeIntoComposer("go");
    click(button("发送"));
    await settle();
    expect(host.textContent).toContain("请重新载入");
  });
});

describe("approvals and questions", () => {
  it("sends allow with the approval id and the revision", async () => {
    const api = actions();
    wire.history = {
      status: "ready",
      data: { events: [entry("run.approval_requested", { approvalId: "ap-1", action: "write file", detail: "/etc/hosts" })], nextSeq: 1 },
    };
    render(h(HermesView, { missionId: "m-1", actions: api as unknown as MissionActions }));
    click(button("允许"));
    await settle();
    const [input] = api.resolve.mock.calls[0]!;
    expect(input).toMatchObject({ missionId: "m-1", approvalId: "ap-1", decision: "allow", expectedRevision: 7 });
    expect(input.commandId.length).toBeGreaterThan(0);
    expect(input).not.toHaveProperty("answer");
  });

  it("sends deny without an answer", async () => {
    const api = actions();
    wire.history = {
      status: "ready",
      data: { events: [entry("run.approval_requested", { approvalId: "ap-1", action: "write file", detail: "/etc/hosts" })], nextSeq: 1 },
    };
    render(h(HermesView, { missionId: "m-1", actions: api as unknown as MissionActions }));
    click(button("拒绝"));
    await settle();
    expect(api.resolve.mock.calls[0]![0]).toMatchObject({ decision: "deny" });
    expect(api.resolve.mock.calls[0]![0]).not.toHaveProperty("answer");
  });

  it("sends an answer when the person answers the approval", async () => {
    const api = actions();
    wire.history = {
      status: "ready",
      data: { events: [entry("run.approval_requested", { approvalId: "ap-1", action: "choose a branch", detail: "" })], nextSeq: 1 },
    };
    render(h(HermesView, { missionId: "m-1", actions: api as unknown as MissionActions }));
    click(button("改为回答"));
    const field = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "use staging");
    flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
    click(button("发送回答"));
    await settle();
    expect(api.resolve.mock.calls[0]![0]).toMatchObject({ decision: "answer", answer: "use staging" });
  });

  it("submits an answer to the question the run is blocked on", async () => {
    const api = actions();
    wire.history = {
      status: "ready",
      data: { events: [entry("run.waiting_input", { question: "Which branch?" })], nextSeq: 1 },
    };
    render(h(HermesView, { missionId: "m-1", actions: api as unknown as MissionActions }));
    const field = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "main");
    flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
    click(button("发送回答"));
    await settle();
    const [missionId, input, command] = api.submitInput.mock.calls[0]!;
    expect(missionId).toBe("m-1");
    expect(input).toBe("main");
    expect(command.expectedRevision).toBe(7);
  });

  it("shows a decided approval as decided and offers nothing", () => {
    wire.history = {
      status: "ready",
      data: {
        events: [
          entry("run.approval_requested", { approvalId: "ap-1", action: "write file", detail: "/etc/hosts" }),
          entry("run.approval_resolved", { approvalId: "ap-1", decision: "deny" }),
        ],
        nextSeq: 2,
      },
    };
    render(h(HermesView, { missionId: "m-1", actions: actions() as unknown as MissionActions }));
    expect(host.textContent).toContain("已拒绝");
    expect(button("允许")).toBeUndefined();
  });
});
