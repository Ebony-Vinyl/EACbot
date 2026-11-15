import { beforeEach, describe, expect, it, vi } from "vitest";

const wire = vi.hoisted(() => ({
  createMission: vi.fn(),
  steerMission: vi.fn(),
  interruptMission: vi.fn(),
  resumeMission: vi.fn(),
  cancelMission: vi.fn(),
  submitMissionInput: vi.fn(),
  resolveApproval: vi.fn(),
  newCommandId: vi.fn(() => "generated-1"),
}));

vi.mock("../foundation/api.ts", () => wire);

const request = vi.hoisted(() => vi.fn());
vi.mock("../foundation/http.ts", () => ({ apiClient: () => ({ request }) }));

const { missionActions } = await import("./actions.ts");

beforeEach(() => {
  for (const fn of Object.values(wire)) fn.mockClear();
  request.mockClear();
  wire.newCommandId.mockReturnValue("generated-1");
});

describe("a mission command names its id and the revision the person saw", () => {
  it("steers with both, and nothing derived from a response", async () => {
    await missionActions.steer("m-1", "keep going", { commandId: "cmd-a", expectedRevision: 7 });
    expect(wire.steerMission).toHaveBeenCalledWith("m-1", 7, "keep going", { commandId: "cmd-a" });
  });

  it("sends the caller's command id rather than a fresh one on every path", async () => {
    await missionActions.steer("m-1", "x", { commandId: "retry-1", expectedRevision: 3 });
    await missionActions.steer("m-1", "x", { commandId: "retry-1", expectedRevision: 3 });
    expect(wire.steerMission).toHaveBeenNthCalledWith(1, "m-1", 3, "x", { commandId: "retry-1" });
    expect(wire.steerMission).toHaveBeenNthCalledWith(2, "m-1", 3, "x", { commandId: "retry-1" });
    expect(wire.newCommandId).not.toHaveBeenCalled();
  });

  it("passes the revision to every operation that takes one", async () => {
    const command = { commandId: "c", expectedRevision: 12 };
    await missionActions.interrupt("m-1", command);
    await missionActions.resume("m-1", command);
    await missionActions.cancel("m-1", command);
    await missionActions.submitInput("m-1", "answer", command);
    await missionActions.resolve({ missionId: "m-1", approvalId: "ap-1", decision: "allow", ...command });
    expect(wire.interruptMission).toHaveBeenCalledWith("m-1", 12, { commandId: "c" });
    expect(wire.resumeMission).toHaveBeenCalledWith("m-1", 12, { commandId: "c" });
    expect(wire.cancelMission).toHaveBeenCalledWith("m-1", 12, { commandId: "c" });
    expect(wire.submitMissionInput).toHaveBeenCalledWith("m-1", 12, "answer", { commandId: "c" });
    expect(wire.resolveApproval).toHaveBeenCalledWith("m-1", "ap-1", 12, "allow", { commandId: "c" });
  });

  it("creates a mission without a revision, because none exists yet", async () => {
    await missionActions.create({
      commandId: "new-1",
      title: "Nightly",
      prompt: "Do it",
      agent: "hermes",
      environment: { id: "env-1", label: "box", kind: "ssh", authMode: "subscription" },
    });
    expect(wire.createMission).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Nightly", agent: "hermes" }),
      { commandId: "new-1" },
    );
  });

  it("carries a parent mission id when the task is a child", async () => {
    await missionActions.create({
      commandId: "child-1",
      title: "Child",
      prompt: "Do it",
      agent: "codex",
      environment: { id: "env-1", label: "box", kind: "ssh", authMode: "apiKey" },
      parentMissionId: "m-1",
    });
    expect(wire.createMission).toHaveBeenCalledWith(expect.objectContaining({ parentMissionId: "m-1" }), { commandId: "child-1" });
  });

  it("omits an empty reason instead of sending a blank one", async () => {
    await missionActions.interrupt("m-1", { commandId: "c", expectedRevision: 1 }, "");
    expect(wire.interruptMission).toHaveBeenCalledWith("m-1", 1, { commandId: "c" });
    await missionActions.interrupt("m-1", { commandId: "c", expectedRevision: 1 }, "user stopped it");
    expect(wire.interruptMission).toHaveBeenLastCalledWith("m-1", 1, { commandId: "c", reason: "user stopped it" });
  });

  it("passes cascade only when the caller decided it", async () => {
    await missionActions.cancel("m-1", { commandId: "c", expectedRevision: 1 });
    expect(wire.cancelMission).toHaveBeenCalledWith("m-1", 1, { commandId: "c" });
    await missionActions.cancel("m-1", { commandId: "c2", expectedRevision: 1 }, { cascade: false });
    expect(wire.cancelMission).toHaveBeenLastCalledWith("m-1", 1, { commandId: "c2", cascade: false });
  });
});

describe("an approval decision", () => {
  it("sends allow with no answer field at all", async () => {
    await missionActions.resolve({ missionId: "m-1", approvalId: "ap-1", decision: "allow", commandId: "c", expectedRevision: 4 });
    expect(wire.resolveApproval).toHaveBeenCalledWith("m-1", "ap-1", 4, "allow", { commandId: "c" });
    expect(wire.resolveApproval.mock.calls[0]?.[4]).not.toHaveProperty("answer");
  });

  it("sends deny with no answer field", async () => {
    await missionActions.resolve({ missionId: "m-1", approvalId: "ap-1", decision: "deny", commandId: "c", expectedRevision: 4, answer: "ignored" });
    expect(wire.resolveApproval).toHaveBeenCalledWith("m-1", "ap-1", 4, "deny", { commandId: "c" });
  });

  it("sends the answer when the decision is an answer", async () => {
    await missionActions.resolve({
      missionId: "m-1", approvalId: "ap-1", decision: "answer", answer: "use staging", commandId: "c", expectedRevision: 4,
    });
    expect(wire.resolveApproval).toHaveBeenCalledWith("m-1", "ap-1", 4, "answer", { commandId: "c", answer: "use staging" });
  });

  it("keeps the approval id in the path argument, not in a body the caller writes", async () => {
    await missionActions.resolve({ missionId: "m-1", approvalId: "ap-9", decision: "allow", commandId: "c", expectedRevision: 4 });
    expect(wire.resolveApproval.mock.calls[0]?.slice(0, 2)).toEqual(["m-1", "ap-9"]);
  });
});

describe("reconciling a run a restart left in limbo", () => {
  it("posts the run, the action and the revision to the reconcile route", async () => {
    await missionActions.reconcile("m-1", { runId: "r-9", action: "abandon", reason: "host rebooted", commandId: "c", expectedRevision: 5 });
    expect(request).toHaveBeenCalledWith("/missions/m-1/reconcile", {
      method: "POST",
      body: { commandId: "c", expectedRevision: 5, runId: "r-9", action: "abandon", reason: "host rebooted" },
    });
  });

  it("omits an empty reason", async () => {
    await missionActions.reconcile("m-1", { runId: "r-9", action: "cancel", commandId: "c", expectedRevision: 5 });
    expect(request).toHaveBeenCalledWith("/missions/m-1/reconcile", {
      method: "POST",
      body: { commandId: "c", expectedRevision: 5, runId: "r-9", action: "cancel" },
    });
  });

  it("escapes the mission id so a slash cannot become a path segment", async () => {
    await missionActions.reconcile("a/b", { runId: "r", action: "start", commandId: "c", expectedRevision: 1 });
    expect(request.mock.calls[0]?.[0]).toBe("/missions/a%2Fb/reconcile");
  });
});
