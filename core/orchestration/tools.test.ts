import { afterEach, describe, expect, it } from "vitest";

import { capabilitiesFor } from "../missions/capabilities.ts";
import { adapterOf, createToolFixture, toolMission, type Fixture } from "./fixture.ts";

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture(options: Parameters<typeof createToolFixture>[0] = {}): Fixture {
  const created = createToolFixture(options);
  open.push(created);
  return created;
}

function runIdOf(f: Fixture, missionId: string): string {
  return f.missions.runtime.store.requireMission(missionId).activeRunId!;
}

function revisionOf(f: Fixture, missionId: string): number {
  return f.missions.runtime.store.requireMission(missionId).revision;
}

describe("list_agents exposes only real capability", () => {
  it("reports each engine's own capabilities, install state and model state", async () => {
    const f = fixture({
      installStatus: (agent) => ({ state: "installed", version: `0.0.${agent.length}` }),
      probeModels: async (agent) => ({ state: "reported", models: [{ model: `${agent}-model` }] }),
    });
    const outcome = await f.tools.call("list_agents", { probeModels: true }, f.claims());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { agents: { agent: string; capabilities: { steer: { kind: string } }; models: { state: string }; installStatus: { state: string } }[] };
    expect(data.agents.length).toBeGreaterThan(0);
    for (const agent of data.agents) {
      expect(agent.capabilities.steer.kind).toBe(capabilitiesFor(agent.agent as never).steer.kind);
      expect(agent.installStatus.state).toBe("installed");
    }
    const hermes = data.agents.find((agent) => agent.agent === "hermes");
    expect(hermes?.capabilities.steer.kind).toBe("next-boundary");
  });

  it("says a model catalog is unprobed rather than showing an empty list", async () => {
    const f = fixture();
    const outcome = await f.tools.call("list_agents", { agents: ["codex"] }, f.claims());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { agents: { models: { state: string } }[] };
    expect(data.agents[0]!.models.state).toBe("unprobed");
  });

  it("reports `none` for an engine with no catalog surface", async () => {
    const f = fixture();
    const outcome = await f.tools.call("list_agents", { agents: ["claudeCode"], probeModels: true }, f.claims());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { agents: { models: { state: string } }[] };
    expect(data.agents[0]!.models.state).toBe("none");
  });

  it("reports install state as unknown rather than claiming an install", async () => {
    const f = fixture();
    const outcome = await f.tools.call("list_agents", { agents: ["pi"] }, f.claims());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { agents: { installStatus: { state: string } }[] };
    expect(data.agents[0]!.installStatus.state).toBe("unknown");
  });
});

describe("create_mission", () => {
  it("assigns the named agent, model and environment", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, {
      commandId: "c1",
      agent: "codex",
      model: { agent: "codex", model: "gpt-5", effort: "high" },
      environment: { id: "env-2", label: "laptop", kind: "local", authMode: "local" },
    });
    const mission = f.missions.runtime.store.requireMission(missionId);
    expect(mission.agent).toBe("codex");
    expect(mission.model).toEqual({ agent: "codex", model: "gpt-5", effort: "high" });
    expect(mission.environment.id).toBe("env-2");
  });

  it("refuses a model that names a different agent", async () => {
    const f = fixture();
    const outcome = await f.tools.call(
      "create_mission",
      {
        agent: "hermes",
        model: { agent: "codex", model: "gpt-5" },
        environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
        brief: { objective: "x", doneWhen: ["y"], permissionLevel: "read-only", source: { kind: "owner" } },
      },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("invalid_arguments");
  });

  it("refuses an apiKey environment with no credential reference", async () => {
    const f = fixture();
    const outcome = await f.tools.call(
      "create_mission",
      {
        agent: "hermes",
        environment: { id: "env", label: "pc", kind: "local", authMode: "apiKey" },
        brief: { objective: "x", doneWhen: ["y"], permissionLevel: "read-only", source: { kind: "owner" } },
      },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("invalid_arguments");
  });
});

describe("steer_run has exactly three answers", () => {
  it("answers accepted and next-boundary for Hermes", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call(
      "steer_run",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId), input: "also check the tests" },
      f.claims(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { outcome: string; delivery: string };
    expect(data.outcome).toBe("accepted");
    expect(data.delivery).toBe("next-boundary");
  });

  it("answers native for an engine that folds text into the turn", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1", agent: "codex" });
    const outcome = await f.tools.call(
      "steer_run",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId), input: "go on" },
      f.claims(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.data as { delivery: string }).delivery).toBe("native");
  });

  it("refuses to steer an engine with no mid-turn channel", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1", agent: "custom" });
    const outcome = await f.tools.call(
      "steer_run",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId), input: "go on" },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("unsupported");
  });

  it("refuses to steer a settled mission", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    adapterOf(f).finish(runIdOf(f, missionId));
    const outcome = await f.tools.call(
      "steer_run",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId), input: "go on" },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("already_settled");
  });
});

describe("interrupt and resume", () => {
  it("interrupts to a resumable mission, then resumes it", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });

    const interrupted = await f.tools.call(
      "interrupt_run",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId), reason: "pause" },
      f.claims(),
    );
    expect(interrupted.ok).toBe(true);
    expect(f.missions.runtime.store.requireMission(missionId).status).toBe("interrupted");

    const resumed = await f.tools.call(
      "resume_mission",
      { commandId: "c3", missionId, expectedRevision: revisionOf(f, missionId) },
      f.claims(),
    );
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect((resumed.data as { revision: number }).revision).toBeGreaterThan(0);
    const mission = f.missions.runtime.store.requireMission(missionId);
    expect(mission.runIds.length).toBe(2);
    expect(mission.status === "resuming" || mission.status === "running").toBe(true);
  });

  it("refuses to resume a mission that is not interrupted", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call(
      "resume_mission",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId) },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("not_resumable");
  });

  it("refuses to resume an interrupted run that kept no native session", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const runId = runIdOf(f, missionId);
    f.missions.runtime.store.updateRun(runId, { status: "interrupted", nativeSessionId: undefined });
    f.missions.runtime.store.applyAuthorityStatus(missionId, "interrupted", f.missions.clock.now());

    const outcome = await f.tools.call(
      "resume_mission",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId) },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("not_resumable");
  });

  it("refuses an interrupt on a settled mission", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    adapterOf(f).finish(runIdOf(f, missionId));
    const outcome = await f.tools.call(
      "interrupt_run",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId) },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("already_settled");
  });
});

describe("cancel_mission", () => {
  it("cancels the tree and names the runs it settled", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call(
      "cancel_mission",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId), reason: "not needed" },
      f.claims(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { affectedMissionIds?: string[]; affectedRunIds?: string[] };
    expect(data.affectedMissionIds).toContain(missionId);
    expect(data.affectedRunIds?.length).toBe(1);
    expect(f.missions.runtime.store.requireMission(missionId).status).toBe("cancelled");
  });

  it("refuses a second cancel", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    await f.tools.call("cancel_mission", { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId) }, f.claims());
    const again = await f.tools.call(
      "cancel_mission",
      { commandId: "c3", missionId, expectedRevision: revisionOf(f, missionId) },
      f.claims(),
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("already_settled");
  });
});

describe("approvals can only answer a request that exists", () => {
  it("lists a pending approval and answers it", async () => {
    const f = fixture();
    const adapter = adapterOf(f);
    adapter.script({ approval: { action: "push branch", detail: "origin/main" } });
    const { missionId } = await toolMission(f, { commandId: "c1" });
    adapter.finish(runIdOf(f, missionId));

    const listed = await f.tools.call("list_approvals", { missionId }, f.claims());
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const approvals = (listed.data as { approvals: { id: string; status: string }[] }).approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.status).toBe("pending");

    const answered = await f.tools.call(
      "answer_approval",
      {
        commandId: "c2",
        missionId,
        expectedRevision: revisionOf(f, missionId),
        approvalId: approvals[0]!.id,
        decision: "allow",
      },
      f.claims(),
    );
    expect(answered.ok).toBe(true);
    if (answered.ok) expect((answered.data as { approval: { status: string } }).approval.status).toBe("allowed");
  });

  it("refuses an approval id that does not exist", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call(
      "answer_approval",
      {
        commandId: "c2",
        missionId,
        expectedRevision: revisionOf(f, missionId),
        approvalId: "approval-invented",
        decision: "allow",
      },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("not_found");
  });

  it("refuses an approval that belongs to another mission", async () => {
    const f = fixture();
    const adapter = adapterOf(f);
    adapter.script({ approval: { action: "push", detail: "main" } });
    const first = await toolMission(f, { commandId: "c1" });
    const second = await toolMission(f, { commandId: "c2" });
    adapter.finish(runIdOf(f, first.missionId));

    const listed = await f.tools.call("list_approvals", { missionId: first.missionId }, f.claims());
    if (!listed.ok) throw new Error("list failed");
    const approvalId = (listed.data as { approvals: { id: string }[] }).approvals[0]!.id;

    const outcome = await f.tools.call(
      "answer_approval",
      {
        commandId: "c3",
        missionId: second.missionId,
        expectedRevision: revisionOf(f, second.missionId),
        approvalId,
        decision: "allow",
      },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("not_found");
  });

  it("refuses to answer an already resolved approval", async () => {
    const f = fixture();
    const adapter = adapterOf(f);
    adapter.script({ approval: { action: "push", detail: "main" } });
    const { missionId } = await toolMission(f, { commandId: "c1" });
    adapter.finish(runIdOf(f, missionId));
    const listed = await f.tools.call("list_approvals", { missionId }, f.claims());
    if (!listed.ok) throw new Error("list failed");
    const approvalId = (listed.data as { approvals: { id: string }[] }).approvals[0]!.id;

    await f.tools.call(
      "answer_approval",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId), approvalId, decision: "deny" },
      f.claims(),
    );
    const again = await f.tools.call(
      "answer_approval",
      { commandId: "c3", missionId, expectedRevision: revisionOf(f, missionId), approvalId, decision: "allow" },
      f.claims(),
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("already_settled");
  });

  it("refuses an `answer` decision with no answer text", async () => {
    const f = fixture();
    const adapter = adapterOf(f);
    adapter.script({ approval: { action: "choose", detail: "a or b" } });
    const { missionId } = await toolMission(f, { commandId: "c1" });
    adapter.finish(runIdOf(f, missionId));
    const listed = await f.tools.call("list_approvals", { missionId }, f.claims());
    if (!listed.ok) throw new Error("list failed");
    const approvalId = (listed.data as { approvals: { id: string }[] }).approvals[0]!.id;

    const outcome = await f.tools.call(
      "answer_approval",
      { commandId: "c2", missionId, expectedRevision: revisionOf(f, missionId), approvalId, decision: "answer" },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("invalid_arguments");
  });
});

describe("mission_status", () => {
  it("reports what the mission's state permits", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call("mission_status", { missionId, eventLimit: 3 }, f.claims());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as {
      mission: { allowed: { steer: string; cancel: boolean } };
      latestRun: { id: string };
      recentEvents: unknown[];
    };
    expect(data.mission.allowed.steer).toBe("next-boundary");
    expect(data.mission.allowed.cancel).toBe(true);
    expect(data.latestRun.id).toBe(runIdOf(f, missionId));
    expect(data.recentEvents.length).toBeLessThanOrEqual(3);
  });

  it("refuses an unknown mission", async () => {
    const f = fixture();
    const outcome = await f.tools.call("mission_status", { missionId: "nope" }, f.claims());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("not_found");
  });
});
