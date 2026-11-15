import { afterEach, describe, expect, it } from "vitest";

import { adapterOf, createToolFixture, toolMission, type Fixture } from "./fixture.ts";

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture(): Fixture {
  const created = createToolFixture();
  open.push(created);
  return created;
}

function revisionOf(f: Fixture, missionId: string): number {
  return f.missions.runtime.store.requireMission(missionId).revision;
}

describe("idempotent commands", () => {
  it("returns the original mission for a replayed create", async () => {
    const f = fixture();
    const args = {
      commandId: "same-create",
      agent: "hermes",
      environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
      brief: { objective: "one task", doneWhen: ["done"], permissionLevel: "read-only", source: { kind: "owner" } },
    };
    const first = await f.tools.call("create_mission", args, f.claims());
    const second = await f.tools.call("create_mission", args, f.claims());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.replayed).toBe(true);
    expect((second.data as { missionId: string }).missionId).toBe((first.data as { missionId: string }).missionId);
    expect(f.missions.runtime.store.listMissions()).toHaveLength(1);
  });

  it("carries the command id back on both the fresh and replayed answer", async () => {
    const f = fixture();
    const args = {
      commandId: "echo-me",
      agent: "hermes",
      environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
      brief: { objective: "one task", doneWhen: ["done"], permissionLevel: "read-only", source: { kind: "owner" } },
    };
    const first = await f.tools.call("create_mission", args, f.claims());
    const second = await f.tools.call("create_mission", args, f.claims());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.commandId).toBe("echo-me");
    expect(second.commandId).toBe("echo-me");
    expect(first.replayed).toBe(false);
  });

  it("refuses a reused command id with different arguments", async () => {
    const f = fixture();
    const base = {
      commandId: "collide",
      agent: "hermes",
      environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
      brief: { objective: "one task", doneWhen: ["done"], permissionLevel: "read-only", source: { kind: "owner" } },
    };
    await f.tools.call("create_mission", base, f.claims());
    const changed = await f.tools.call(
      "create_mission",
      { ...base, brief: { ...base.brief, objective: "a different task" } },
      f.claims(),
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("command_conflict");
  });

  it("generates a command id when the caller omits one", async () => {
    const f = fixture();
    const outcome = await f.tools.call(
      "create_mission",
      {
        agent: "hermes",
        environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
        brief: { objective: "one task", doneWhen: ["done"], permissionLevel: "read-only", source: { kind: "owner" } },
      },
      f.claims(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.commandId).toMatch(/^tool-/u);
    const mission = f.missions.runtime.store.requireMission((outcome.data as { missionId: string }).missionId);
    expect(mission.id).toBeTruthy();
    expect(f.missions.runtime.registry.get(outcome.commandId!)).toBeDefined();
  });

  it("applies a concurrent duplicate exactly once", async () => {
    const f = fixture();
    const args = {
      commandId: "racing",
      agent: "hermes",
      environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
      brief: { objective: "one task", doneWhen: ["done"], permissionLevel: "read-only", source: { kind: "owner" } },
    };
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => f.tools.call("create_mission", args, f.claims())));
    const ok = outcomes.filter((outcome) => outcome.ok);
    expect(ok.length).toBe(6);
    const ids = new Set(ok.map((outcome) => (outcome.data as { missionId: string }).missionId));
    expect(ids.size).toBe(1);
    expect(f.missions.runtime.store.listMissions()).toHaveLength(1);
    expect(f.missions.runtime.registry.count()).toBe(1);
  });

  it("applies a concurrent duplicate steer exactly once", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const args = {
      commandId: "steer-once",
      missionId,
      expectedRevision: revisionOf(f, missionId),
      input: "go",
    };
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => f.tools.call("steer_run", args, f.claims())));
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(adapterOf(f).steers).toHaveLength(1);
  });

  it("refuses a stale revision and names the current one", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const stale = revisionOf(f, missionId);
    await f.tools.call(
      "interrupt_run",
      { commandId: "c2", missionId, expectedRevision: stale },
      f.claims(),
    );
    const outcome = await f.tools.call(
      "interrupt_run",
      { commandId: "c3", missionId, expectedRevision: stale },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code === "revision_conflict" || outcome.error.code === "already_settled").toBe(true);
      if (outcome.error.code === "revision_conflict") {
        expect(outcome.error.details?.currentRevision).toBeGreaterThan(stale);
        expect(outcome.error.retryable).toBe(true);
      }
    }
  });
});

describe("tool results agree with the event log", () => {
  it("reports the same run the log recorded for a create", async () => {
    const f = fixture();
    const { missionId, runId } = await toolMission(f, { commandId: "c1" });
    const events = f.missions.runtime.log.events(missionId);
    const accepted = events.find((entry) => entry.type === "run.accepted");
    expect(accepted?.payload.runId).toBe(runId);
  });

  it("reports the same run a steer reached", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call(
      "steer_run",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId), input: "go" },
      f.claims(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const reportedRunId = (outcome.data as { runId: string }).runId;
    const requested = f.missions.runtime.log.events(missionId).find((entry) => entry.type === "run.steer_requested");
    expect(requested?.runId).toBe(reportedRunId);
    expect(adapterOf(f).steers[0]!.runId).toBe(reportedRunId);
  });

  it("reports a cancel whose run ids the log also names", async () => {
    const f = fixture();
    const { missionId, runId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call(
      "cancel_mission",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId) },
      f.claims(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.data as { affectedRunIds: string[] }).affectedRunIds).toEqual([runId]);
    const cancelled = f.missions.runtime.log.events(missionId).find((entry) => entry.type === "mission.cancelled");
    expect(cancelled).toBeDefined();
    expect(adapterOf(f).cancelled).toEqual([runId]);
  });

  it("reports a resolved approval the log recorded with the caller as decider", async () => {
    const f = fixture();
    const adapter = adapterOf(f);
    adapter.script({ approval: { action: "push", detail: "main" } });
    const { missionId } = await toolMission(f, { commandId: "c1" });
    adapter.finish(f.missions.runtime.store.requireMission(missionId).activeRunId!);
    const listed = await f.tools.call("list_approvals", { missionId }, f.claims());
    if (!listed.ok) throw new Error("list failed");
    const approvalId = (listed.data as { approvals: { id: string }[] }).approvals[0]!.id;

    const answered = await f.tools.call(
      "answer_approval",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId), approvalId, decision: "answer", answer: "yes, main" },
      f.claims(),
    );
    expect(answered.ok).toBe(true);
    const resolved = f.missions.runtime.log.events(missionId).find((entry) => entry.type === "approval.resolved");
    expect(resolved?.payload.approvalId).toBe(approvalId);
    expect(resolved?.payload.answer).toBe("yes, main");
    if (answered.ok) expect((answered.data as { approval: { decidedBy?: string } }).approval.decidedBy).toBe("owner-1");
  });

  it("never reports a mission state the store disagrees with", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call("mission_status", { missionId }, f.claims());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const reported = (outcome.data as { mission: { status: string; revision: number } }).mission;
    const stored = f.missions.runtime.store.requireMission(missionId);
    expect(reported.status).toBe(stored.status);
    expect(reported.revision).toBe(stored.revision);
  });
});
