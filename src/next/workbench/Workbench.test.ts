// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDescriptor } from "../../../packages/agent-protocol/agents.ts";
import type { Mission } from "../../../packages/agent-protocol/mission.ts";
import type { TerminalRef } from "../../../packages/agent-protocol/terminal.ts";

const fixture = vi.hoisted(() => ({
  missions: [] as Mission[],
  computers: [] as { id: string; label: string }[],
  terminals: [] as TerminalRef[],
  agents: [] as AgentDescriptor[],
  missionsFails: false,
  liveStatus: "open" as "open" | "closed" | "retrying" | "connecting",
  steer: vi.fn(async () => ({})),
  interrupt: vi.fn(async () => ({})),
  resume: vi.fn(async () => ({})),
  cancel: vi.fn(async () => ({})),
  history: vi.fn(async () => ({ events: [], nextSeq: 0 })),
  startTerminal: vi.fn(async () => ({ id: "t-new", kind: "nativeTui", missionId: "m1", runId: "r1", createdAt: "2026-01-01T00:00:00.000Z" })),
}));

vi.mock("./start-terminal.ts", () => ({
  startTerminal: (...args: unknown[]) => fixture.startTerminal(...(args as [])),
  toolForAgent: (agent: string) => (agent === "hermes" ? "hermes" : null),
  isTerminalTool: (value: string) => ["hermes", "claude", "codex", "opencode", "pi", "omp"].includes(value),
  TERMINAL_TOOLS: ["hermes", "claude", "codex", "opencode", "pi", "omp"],
}));

vi.mock("../foundation/api.ts", () => ({
  apiClient: () => ({
    request: async (path: string) => {
      if (path !== "/environments") throw new Error(`unexpected read: ${path}`);
      return { environments: fixture.computers };
    },
  }),
  getMissions: async () => {
    if (fixture.missionsFails) throw new Error("the server is not answering");
    return fixture.missions;
  },
  getTerminals: async () => fixture.terminals,
  getAgents: async () => fixture.agents,
  getMissionHistory: () => fixture.history(),
  steerMission: (...args: unknown[]) => fixture.steer(...(args as [])),
  interruptMission: (...args: unknown[]) => fixture.interrupt(...(args as [])),
  resumeMission: (...args: unknown[]) => fixture.resume(...(args as [])),
  cancelMission: (...args: unknown[]) => fixture.cancel(...(args as [])),
  useLiveEvents: () => ({ status: fixture.liveStatus, version: 0, lastEvent: null, lastCursor: null }),
  connectTerminal: () => ({
    sendInput: () => {},
    sendResize: () => {},
    sendCredit: () => {},
    close: () => {},
    isOpen: () => false,
  }),
}));

const { Workbench: WorkbenchComponent } = await import("./Workbench.tsx");
const Workbench = WorkbenchComponent as unknown as (props: { storage?: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } }) => React.ReactElement;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const storage = (): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; values: Map<string, string> } => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
};

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    protocolVersion: 1,
    id: "m1",
    rootMissionId: "m1",
    depth: 0,
    title: "Ship the workbench",
    prompt: "Build it",
    agent: "hermes",
    environment: { id: "env-1", label: "Ada's computer", kind: "ssh", authMode: "subscription", host: "box.local", user: "ada" },
    status: "running",
    revision: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    acceptedAt: "2026-01-01T00:00:00.000Z",
    runIds: [],
    childIds: [],
    artifactIds: [],
    approvalIds: [],
    wakeGeneration: 0,
    ...overrides,
  };
}

const terminal = (id = "t1"): TerminalRef => ({ id, kind: "pty", missionId: "m1", runId: "r1", createdAt: "2026-01-01T00:00:00.000Z" });

beforeEach(() => {
  fixture.missions = [];
  fixture.terminals = [];
  fixture.agents = [];
  fixture.missionsFails = false;
  fixture.liveStatus = "open";
  fixture.steer.mockClear();
  fixture.history.mockClear();
  fixture.startTerminal.mockClear();
  fixture.computers = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

async function render(store = storage()): Promise<void> {
  await act(async () => root.render(h(Workbench, { storage: store })));
  await flush();
  await flush();
}

const text = (): string => host.textContent ?? "";
const click = async (label: string): Promise<void> => {
  const button = [...host.querySelectorAll("button")].find((candidate) => (candidate.textContent ?? "").includes(label));
  if (!button) throw new Error(`no button labelled ${label}`);
  await act(async () => button.click());
  await flush();
};

describe("the workbench shell", () => {
  it("shows the machines, agents and missions it was given", async () => {
    fixture.missions = [mission()];
    fixture.terminals = [terminal()];
    fixture.agents = [{ kind: "hermes", label: "Hermes", authModes: ["subscription"], capabilities: {} as AgentDescriptor["capabilities"], models: [] }];
    await render();
    expect(text()).toContain("Ada's computer");
    expect(text()).toContain("Hermes");
    expect(text()).toContain("Ship the workbench");
  });

  it("says so when the snapshot could not be read, and offers a retry", async () => {
    fixture.missionsFails = true;
    await render();
    expect(text()).toContain("the server is not answering");
    expect(text()).toContain("Try again");
    fixture.missionsFails = false;
    await click("Try again");
    expect(text()).not.toContain("the server is not answering");
  });

  it("pins a mission that needs a person above the tabs", async () => {
    fixture.missions = [mission({ status: "waiting_input" })];
    await render();
    expect(text()).toContain("Needs you");
    expect(text()).toContain("Needs input");
  });

  it("shows the live stream's own state", async () => {
    fixture.missions = [mission()];
    await render();
    expect(text()).toContain("Live");
    fixture.liveStatus = "retrying";
    await render();
    expect(text()).toContain("Reconnecting");
  });

  it("opens a mission in a tab and shows its commands", async () => {
    fixture.missions = [mission()];
    await render();
    await click("Ship the workbench");
    expect(text()).toContain("Interrupt");
    expect(text()).toContain("Cancel");
    expect(text()).toContain("Revision");
  });

  it("sends a steer with the revision it read", async () => {
    fixture.missions = [mission()];
    await render();
    await click("Ship the workbench");
    const area = host.querySelector("textarea");
    expect(area).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "keep going");
      area!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Send");
    expect(fixture.steer).toHaveBeenCalledWith("m1", 3, "keep going");
  });

  it("offers no command when the live stream is offline", async () => {
    fixture.liveStatus = "closed";
    fixture.missions = [mission()];
    await render();
    await click("Ship the workbench");
    expect(text()).toContain("may watch but not send commands");
    const send = [...host.querySelectorAll("button")].find((button) => (button.textContent ?? "") === "Send");
    expect(send).toBeUndefined();
  });

  it("keeps the layout it was given across a reload", async () => {
    const store = storage();
    fixture.missions = [mission()];
    fixture.terminals = [terminal()];
    await render(store);
    await click("Ship the workbench");
    expect(store.values.size).toBeGreaterThan(0);
    await act(() => root.unmount());
    root = createRoot(host);
    await render(store);
    expect(text()).toContain("Ship the workbench");
  });

  it("splits a pane and shows the new one", async () => {
    fixture.missions = [mission()];
    fixture.terminals = [terminal()];
    await render();
    const before = host.querySelectorAll('[data-testid^="pane-"]').length;
    await click("⇥");
    const after = host.querySelectorAll('[data-testid^="pane-"]').length;
    expect(after).toBe(before + 1);
  });

  it("starts an agent terminal on the mission's computer with its agent's tool, then refreshes", async () => {
    fixture.missions = [mission()];
    await render();
    await click("Ship the workbench");
    await click("Open agent terminal");
    expect(fixture.startTerminal).toHaveBeenCalledWith({ environmentId: "env-1", tool: "hermes", missionId: "m1" });
  });

  it("asks for a computer and a tool when no mission is selected", async () => {
    fixture.missions = [];
    await render();
    await click("Open agent terminal");
    expect(text()).toContain("Open an agent terminal");
    expect(fixture.startTerminal).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("offers the computers the environment layer reports, not the placeholders missions name", async () => {
    // A fixture mission names `env-visual`, which no server accepts; the picker
    // must offer the real record instead, or every start is refused.
    fixture.missions = [mission({ environment: { id: "env-visual", label: "Placeholder", kind: "ssh" } } as Partial<Mission>)];
    fixture.computers = [{ id: "env-real", label: "Instabox" }];
    await render();
    await click("Open agent terminal");

    const select = host.querySelector<HTMLSelectElement>('[role="dialog"] select')!;
    const offered = [...select.options].map((option) => option.value);
    expect(offered).toEqual(["env-real"]);
    expect(text()).not.toContain("env-visual");
  });

  it("shows an empty history rather than a blank panel", async () => {
    fixture.missions = [mission()];
    await render();
    await click("Ship the workbench");
    expect(text()).toContain("Nothing has happened in this mission yet.");
  });
});
