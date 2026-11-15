// @vitest-environment happy-dom
import { createElement as h, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Mission } from "../../../packages/agent-protocol/mission.ts";


const wire = vi.hoisted(() => ({
  missions: { status: "ready", data: [] } as Fake<readonly Mission[]>,
}));

vi.mock("./foundation.ts", () => ({ useMissions: () => wire.missions }));
vi.mock("../shared/status.ts", () => ({
  missionStatusTone: () => "accent",
  statusLabel: (status: string) => status,
}));

const { MissionCenter, MissionDetail, buildForest } = await import("./MissionCenter.tsx");

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

const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
const click = (node: Element | undefined) => {
  expect(node).toBeDefined();
  flushSync(() => (node as HTMLButtonElement).click());
};

beforeEach(() => {
  wire.missions = { status: "ready", data: [] };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("building the forest", () => {
  it("nests a child under its parent", () => {
    const forest = buildForest([mission(), mission({ id: "m-2", parentMissionId: "m-1", depth: 1 })]);
    expect(forest).toHaveLength(1);
    expect(forest[0]!.children.map((node) => node.mission.id)).toEqual(["m-2"]);
  });

  it("keeps a mission whose parent is missing as its own root rather than hiding it", () => {
    const forest = buildForest([mission({ id: "orphan", parentMissionId: "gone", depth: 2 })]);
    expect(forest.map((node) => node.mission.id)).toEqual(["orphan"]);
  });

  it("keeps parallel children of one parent, in list order", () => {
    const forest = buildForest([
      mission(),
      mission({ id: "m-2", parentMissionId: "m-1", depth: 1, title: "A" }),
      mission({ id: "m-3", parentMissionId: "m-1", depth: 1, title: "B" }),
    ]);
    expect(forest[0]!.children.map((node) => node.mission.id)).toEqual(["m-2", "m-3"]);
  });

  it("breaks a cycle instead of following it", () => {
    const forest = buildForest([
      mission({ id: "a", parentMissionId: "b" }),
      mission({ id: "b", parentMissionId: "a" }),
    ]);
    expect(forest.length).toBeGreaterThan(0);
    expect(forest.length).toBeLessThanOrEqual(2);
  });
});

describe("the mission centre", () => {
  it("shows an empty state when there are no missions", () => {
    render(h(MissionCenter, { selectedId: null, onSelect: () => {} }));
    expect(host.textContent).toContain("还没有任务");
  });

  it("shows a loading state while reading", () => {
    wire.missions = { status: "loading" };
    render(h(MissionCenter, { selectedId: null, onSelect: () => {} }));
    expect(host.textContent).toContain("正在读取任务");
  });

  it("shows the pairing message when the device is not authorised", () => {
    wire.missions = { status: "unauthorized" };
    render(h(MissionCenter, { selectedId: null, onSelect: () => {} }));
    expect(host.textContent).toContain("这个设备还没有配对");
  });

  it("shows the failure and a retry", () => {
    const retry = vi.fn();
    wire.missions = { status: "error", message: "服务器没有响应", retry };
    render(h(MissionCenter, { selectedId: null, onSelect: () => {} }));
    expect(host.textContent).toContain("服务器没有响应");
    click(button("重试"));
    expect(retry).toHaveBeenCalled();
  });

  it("lists a root and its parallel children", () => {
    wire.missions = {
      status: "ready",
      data: [
        mission({ title: "Root task" }),
        mission({ id: "m-2", parentMissionId: "m-1", depth: 1, title: "Child A" }),
        mission({ id: "m-3", parentMissionId: "m-1", depth: 1, title: "Child B" }),
      ],
    };
    render(h(MissionCenter, { selectedId: null, onSelect: () => {} }));
    expect(host.textContent).toContain("Root task");
    expect(host.textContent).toContain("Child A");
    expect(host.textContent).toContain("Child B");
  });

  it("opens a mission when its row is pressed", () => {
    wire.missions = { status: "ready", data: [mission()] };
    const onSelect = vi.fn();
    render(h(MissionCenter, { selectedId: null, onSelect }));
    click(host.querySelector("[data-testid='mission-row-m-1']")!);
    expect(onSelect).toHaveBeenCalledWith("m-1");
  });

  it("filters by status and says when a filter is empty", () => {
    wire.missions = { status: "ready", data: [mission({ status: "succeeded" })] };
    render(h(MissionCenter, { selectedId: null, onSelect: () => {} }));
    // The default filter is "active", and a succeeded mission is not in it.
    expect(host.textContent).toContain("这个筛选下没有任务");
    expect(host.textContent).toContain("切换到“全部”");
  });

  it("shows a finished mission under the finished filter", () => {
    wire.missions = { status: "ready", data: [mission({ status: "failed" })] };
    render(h(MissionCenter, { selectedId: null, onSelect: () => {} }));
    click([...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === "已结束"));
    expect(host.textContent).toContain("Sort the inbox");
  });

  it("keeps a parent visible when only its child matches", () => {
    wire.missions = {
      status: "ready",
      data: [
        mission({ status: "succeeded", title: "Parent done" }),
        mission({ id: "m-2", parentMissionId: "m-1", depth: 1, title: "Child running", status: "running" }),
      ],
    };
    render(h(MissionCenter, { selectedId: null, onSelect: () => {} }));
    // Default filter is "active": the child matches, so its parent stays as context.
    expect(host.textContent).toContain("Child running");
    expect(host.textContent).toContain("Parent done");
  });

  it("marks a mission that needs a reconcile", () => {
    wire.missions = { status: "ready", data: [mission({ status: "interrupted" })] };
    render(h(MissionCenter, { selectedId: null, onSelect: () => {} }));
    click([...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === "等待中"));
    expect(host.textContent).toContain("需对账");
  });

  it("marks the selected row as current", () => {
    wire.missions = { status: "ready", data: [mission()] };
    render(h(MissionCenter, { selectedId: "m-1", onSelect: () => {} }));
    expect(host.querySelector("[data-testid='mission-row-m-1']")?.getAttribute("aria-current")).toBe("true");
  });

  it("offers to create a mission when the screen can", () => {
    wire.missions = { status: "ready", data: [mission()] };
    const onCreate = vi.fn();
    render(h(MissionCenter, { selectedId: null, onSelect: () => {}, onCreate }));
    click(button("新建任务"));
    expect(onCreate).toHaveBeenCalled();
  });
});

describe("the mission detail", () => {
  const summary = { total: 2, running: 1, waiting: 1, succeeded: 0, failed: 0, cancelled: 0 };

  it("says to pick a mission when none is selected", () => {
    render(h(MissionDetail, { mission: null, childSummary: summary, onResume: () => {}, onCancel: () => {}, onReconcile: () => {}, busy: false }));
    expect(host.textContent).toContain("选一个任务看详情");
  });

  it("shows the environment, revision and child counts", () => {
    render(
      h(MissionDetail, {
        mission: mission(),
        childSummary: summary,
        onResume: () => {},
        onCancel: () => {},
        onReconcile: () => {},
        busy: false,
      }),
    );
    expect(host.textContent).toContain("box");
    expect(host.textContent).toContain("7");
    expect(host.textContent).toContain("2 个");
  });

  it("offers resume and reconcile for an interrupted mission", () => {
    render(
      h(MissionDetail, {
        mission: mission({ status: "interrupted" }),
        childSummary: summary,
        onResume: () => {},
        onCancel: () => {},
        onReconcile: () => {},
        busy: false,
      }),
    );
    expect(button("恢复")).toBeDefined();
    expect(button("对账运行")).toBeDefined();
  });

  it("offers no operation at all for a finished mission", () => {
    render(
      h(MissionDetail, {
        mission: mission({ status: "succeeded" }),
        childSummary: summary,
        onResume: () => {},
        onCancel: () => {},
        onReconcile: () => {},
        busy: false,
      }),
    );
    expect(button("取消任务")).toBeUndefined();
    expect(button("恢复")).toBeUndefined();
  });

  it("shows the engine's error message when the mission failed", () => {
    render(
      h(MissionDetail, {
        mission: mission({ status: "failed", error: { code: "native_start_failed", message: "the engine refused to start" } }),
        childSummary: summary,
        onResume: () => {},
        onCancel: () => {},
        onReconcile: () => {},
        busy: false,
      }),
    );
    expect(host.textContent).toContain("the engine refused to start");
  });
});
