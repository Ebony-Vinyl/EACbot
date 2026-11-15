// @vitest-environment happy-dom
import { createElement as h, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Mission } from "../../../packages/agent-protocol/mission.ts";

interface Fake<T> {
  readonly status: string;
  readonly data?: T;
  readonly message?: string;
  readonly retry?: () => void;
  readonly refresh?: () => void;
}

const wire = vi.hoisted(() => ({
  environments: { status: "ready", data: [], refresh: vi.fn() } as Fake<readonly unknown[]>,
  tree: { status: "ready", data: null } as Fake<unknown>,
  notification: null as ((event: { kind: string; missionId?: string }) => void) | null,
  resume: vi.fn(),
  cancel: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("./foundation.ts", () => ({
  useEnvironments: () => wire.environments,
  useMissionTree: () => wire.tree,
  useNotifications: (handler: (event: { kind: string; missionId?: string }) => void) => {
    wire.notification = handler;
    return { status: "open" };
  },
  actionFailureMessage: (error: unknown) => (error instanceof Error ? error.message : "请求失败"),
}));

vi.mock("./actions.ts", () => ({
  commandId: () => "generated-cmd",
  missionActions: { resume: wire.resume, cancel: wire.cancel, reconcile: wire.reconcile },
}));

vi.mock("./HermesView.tsx", () => ({ HermesView: () => h("div", { "data-testid": "hermes-stub" }, "conversation") }));
vi.mock("./MissionCenter.tsx", () => ({
  MissionCenter: () => h("div", { "data-testid": "center-stub" }, "tree"),
  MissionDetail: ({ onReconcile }: { onReconcile: () => void }) =>
    h("div", { "data-testid": "detail-stub" }, h("button", { type: "button", onClick: onReconcile }, "对账运行")),
}));
vi.mock("./CreateMission.tsx", () => ({ CreateMission: () => h("div", { "data-testid": "create-stub" }, "create") }));

const { PersonalAgentPage, ReconcileDialog } = await import("./PersonalAgentPage.tsx");

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
  status: "interrupted",
  revision: 7,
  createdAt: "2026-11-15T09:00:00Z",
  updatedAt: "2026-11-15T09:05:00Z",
  acceptedAt: "2026-11-15T09:00:00Z",
  activeRunId: "r-1",
  runIds: ["r-1"],
  childIds: [],
  artifactIds: [],
  approvalIds: [],
  wakeGeneration: 0,
  ...overrides,
});

/** A dialog is rendered into a portal on the document body, so a query for its
 * contents has to look past the mount point. */
const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);

beforeEach(() => {
  wire.environments = { status: "ready", data: [], refresh: vi.fn() };
  wire.tree = { status: "ready", data: { mission: mission(), children: [] } };
  wire.notification = null;
  for (const fn of [wire.resume, wire.cancel, wire.reconcile]) fn.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("the personal agent page", () => {
  it("shows the tree, the conversation and the detail", () => {
    render(h(PersonalAgentPage));
    expect(host.querySelector("[data-testid='center-stub']")).not.toBeNull();
    expect(host.querySelector("[data-testid='hermes-stub']")).not.toBeNull();
  });

  it("gives a phone one place at a time instead of three columns", () => {
    render(h(PersonalAgentPage));
    const treeColumn = host.querySelector("[data-testid='center-stub']")!.parentElement!;
    expect(treeColumn.className).toContain("hidden");
    expect(treeColumn.className).toContain("md:flex");
    expect(host.textContent).toContain("任务");
    expect(host.textContent).toContain("对话");
  });

  it("re-reads when a notification names the selected mission or a resync arrives", () => {
    render(h(PersonalAgentPage));
    const page = () => host.querySelector("[data-testid='personal-agent-page']")!;
    const before = page().getAttribute("data-version");
    flushSync(() => wire.notification?.({ kind: "stream.resync" }));
    expect(page().getAttribute("data-version")).not.toBe(before);
  });

  it("opens the reconcile dialog from the detail pane", () => {
    render(h(PersonalAgentPage));
    flushSync(() => button("对账运行")!.click());
    expect(document.querySelector("[data-testid='reconcile-dialog']")).not.toBeNull();
  });
});

describe("the reconcile dialog", () => {
  it("names the run it will settle and offers each action", () => {
    render(h(ReconcileDialog, { mission: mission(), onClose: () => {}, onSubmit: () => {} }));
    expect(document.body.textContent).toContain("r-1");
    expect(document.body.textContent).toContain("对账这个运行");
  });

  it("refuses to act when the mission has no run to reconcile", () => {
    render(h(ReconcileDialog, { mission: mission({ runIds: [], activeRunId: undefined }), onClose: () => {}, onSubmit: () => {} }));
    const submit = button("执行");
    expect(submit instanceof HTMLButtonElement && (submit.disabled || submit.getAttribute("aria-disabled") === "true")).toBe(true);
  });

  it("sends the run id and the chosen action, and nothing when cancelled", () => {
    const onSubmit = vi.fn();
    render(h(ReconcileDialog, { mission: mission(), onClose: () => {}, onSubmit }));
    flushSync(() => button("执行")!.click());
    expect(onSubmit).toHaveBeenCalledWith({ runId: "r-1", action: "cancel" });
  });
});
