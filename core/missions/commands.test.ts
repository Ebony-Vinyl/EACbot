import { afterEach, describe, expect, it } from "vitest";

import { CommandError } from "../../packages/agent-protocol/commands.ts";
import { requestHash, stableStringify } from "./command-registry.ts";
import { commandId, createFixture, createMission, environment, type Fixture } from "./fixture.ts";

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture(): Fixture {
  const created = createFixture();
  open.push(created);
  return created;
}

async function started(f: Fixture, agent: "hermes" | "custom" = "hermes") {
  const missionId = await createMission(f, { agent });
  const mission = f.runtime.store.requireMission(missionId);
  return { missionId, revision: mission.revision, runId: mission.activeRunId!, adapter: f.adapters.adapter(agent) };
}

describe("commands are idempotent and revisioned", () => {
  it("hashes the same request identically whatever its field order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(requestHash("run.steer", { input: "x", missionId: "m" })).toBe(requestHash("run.steer", { missionId: "m", input: "x" }));
    expect(requestHash("run.steer", { input: "x" })).not.toBe(requestHash("mission.cancel", { input: "x" }));
  });

  it("returns the original result when a command id is replayed", async () => {
    const f = fixture();
    const command = {
      type: "mission.create" as const,
      commandId: "once",
      title: "replay",
      prompt: "go",
      agent: "hermes" as const,
      environment: environment(),
    };
    const first = await f.runtime.execute(command);
    const second = await f.runtime.execute(command);
    expect(second.missionId).toBe(first.missionId);
    expect(second.replayed).toBe(true);
    expect(f.runtime.store.listMissions()).toHaveLength(1);
    expect(f.runtime.registry.count()).toBe(1);
  });

  it("refuses a reused command id with a different body", async () => {
    const f = fixture();
    await createMission(f, { commandId: "shared", title: "one" });
    await expect(createMission(f, { commandId: "shared", title: "two" })).rejects.toThrow(/different request/);
  });

  it("rejects a stale expected revision and names the current one", async () => {
    const f = fixture();
    const { missionId } = await started(f);
    const stale = f.runtime.store.requireMission(missionId).revision;
    await f.runtime.execute({
      type: "run.steer",
      commandId: commandId("bump"),
      missionId,
      expectedRevision: stale,
      input: "bump the revision",
    });
    expect(f.runtime.store.requireMission(missionId).revision).toBeGreaterThan(stale);

    await expect(
      f.runtime.execute({
        type: "run.interrupt",
        commandId: commandId("stale"),
        missionId,
        expectedRevision: stale,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("steers a live run and records the request", async () => {
    const f = fixture();
    const { missionId, adapter } = await started(f);
    const revision = f.runtime.store.requireMission(missionId).revision;
    const result = await f.runtime.execute({
      type: "run.steer",
      commandId: commandId("steer"),
      missionId,
      expectedRevision: revision,
      input: "also add tests",
    });
    expect(result.runId).toBeDefined();
    expect(adapter.steers.map((steer) => steer.input)).toEqual(["also add tests"]);
    expect(f.runtime.log.events(missionId).some((entry) => entry.type === "run.steer_requested")).toBe(true);
  });

  it("refuses steer on an agent without the capability", async () => {
    const f = fixture();
    const { missionId } = await started(f, "custom");
    const revision = f.runtime.store.requireMission(missionId).revision;
    await expect(
      f.runtime.execute({ type: "run.steer", commandId: commandId(), missionId, expectedRevision: revision, input: "x" }),
    ).rejects.toMatchObject({ code: "capability_missing" });
  });

  it("refuses steer once the run settled", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);
    adapter.emitRaw(runId, 2, "run.completed", { outcome: "succeeded" });
    const revision = f.runtime.store.requireMission(missionId).revision;
    await expect(
      f.runtime.execute({ type: "run.steer", commandId: commandId(), missionId, expectedRevision: revision, input: "x" }),
    ).rejects.toMatchObject({ code: "already_settled" });
  });

  it("rejects a command for a mission that does not exist", async () => {
    const f = fixture();
    await expect(
      f.runtime.execute({ type: "run.interrupt", commandId: commandId(), missionId: "missing", expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("turns a waiting-for-input mission back to running on submit", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);
    adapter.script({ waitingForInput: true });
    adapter.emitRaw(runId, 2, "run.waiting_input", { question: "which branch?" });
    expect(f.runtime.store.requireMission(missionId).status).toBe("waiting_input");

    await f.runtime.execute({
      type: "run.submit_input",
      commandId: commandId("input"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
      input: "main",
    });
    expect(f.runtime.store.requireMission(missionId).status).toBe("running");
    expect(f.runtime.store.requireRun(runId).status).toBe("running");
  });

  it("refuses submit when the mission is not waiting for input", async () => {
    const f = fixture();
    const { missionId } = await started(f);
    await expect(
      f.runtime.execute({
        type: "run.submit_input",
        commandId: commandId(),
        missionId,
        expectedRevision: f.runtime.store.requireMission(missionId).revision,
        input: "x",
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("records an approval request and resolves it once", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);
    adapter.emitRaw(runId, 2, "run.approval_requested", {
      approvalId: "appr-1",
      action: "write file",
      detail: "src/app.ts",
    });
    const approvals = f.runtime.records.approvalsFor(missionId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.status).toBe("pending");

    const revision = f.runtime.store.requireMission(missionId).revision;
    await f.runtime.execute({
      type: "approval.resolve",
      commandId: commandId("approve"),
      missionId,
      approvalId: "appr-1",
      expectedRevision: revision,
      decision: "allow",
      by: "tester",
    });
    const resolved = f.runtime.records.requireApproval("appr-1");
    expect(resolved.status).toBe("allowed");
    expect(resolved.decidedBy).toBe("tester");

    await expect(
      f.runtime.execute({
        type: "approval.resolve",
        commandId: commandId("again"),
        missionId,
        approvalId: "appr-1",
        expectedRevision: f.runtime.store.requireMission(missionId).revision,
        decision: "deny",
      }),
    ).rejects.toMatchObject({ code: "already_settled" });
  });

  it("records an artifact reference without storing its bytes", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);
    adapter.emitRaw(runId, 2, "run.artifact", {
      artifactId: "art-1",
      path: "/tmp/out.diff",
      bytes: 42,
      mediaType: "text/x-diff",
    });
    const artifacts = f.runtime.records.artifactsFor(missionId);
    expect(artifacts).toEqual([
      {
        id: "art-1",
        missionId,
        runId,
        kind: "file",
        path: "/tmp/out.diff",
        mediaType: "text/x-diff",
        bytes: 42,
        createdAt: expect.any(String),
      },
    ]);
  });

  it("rejects an empty title or prompt", async () => {
    const f = fixture();
    await expect(createMission(f, { title: "   " })).rejects.toBeInstanceOf(CommandError);
    await expect(createMission(f, { prompt: "" })).rejects.toBeInstanceOf(CommandError);
    expect(f.runtime.store.listMissions()).toHaveLength(0);
  });
});
