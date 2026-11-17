import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FakeAdapterRegistry } from "./fake-registry.ts";
import { TestClock, commandId, createFixture, createMission, type Fixture } from "./fixture.ts";
import { MissionRuntime } from "./runtime.ts";

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture(path?: string): Fixture {
  const created = createFixture(path);
  open.push(created);
  return created;
}

async function started(f: Fixture) {
  const missionId = await createMission(f);
  const mission = f.runtime.store.requireMission(missionId);
  return { missionId, runId: mission.activeRunId!, revision: mission.revision, adapter: f.adapters.adapter("hermes") };
}

describe("interrupt and resume", () => {
  it("interrupts a live run, keeping its native session", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);
    const session = adapter.sessionOf(runId);

    const result = await f.runtime.execute({
      type: "run.interrupt",
      commandId: commandId("interrupt"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
      reason: "user paused",
    });

    expect(result.runId).toBe(runId);
    const mission = f.runtime.store.requireMission(missionId);
    expect(mission.status).toBe("interrupted");
    expect(mission.settledAt).toBeUndefined();
    const run = f.runtime.store.requireRun(runId);
    expect(run.status).toBe("interrupted");
    expect(run.nativeSessionId).toBe(session);
    expect(run.interruptedAt).toBeDefined();
    expect(adapter.interrupts).toEqual([runId]);
  });

  it("never lets an interrupt settle a mission", async () => {
    const f = fixture();
    const { missionId } = await started(f);
    await f.runtime.execute({
      type: "run.interrupt",
      commandId: commandId(),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });
    const mission = f.runtime.store.requireMission(missionId);
    expect(mission.status).toBe("interrupted");
    expect(mission.settledAt).toBeUndefined();
  });

  it("resumes an interrupted mission into a new attempt on the same session", async () => {
    const f = fixture();
    const { missionId, runId, adapter } = await started(f);
    const session = adapter.sessionOf(runId);
    await f.runtime.execute({
      type: "run.interrupt",
      commandId: commandId("i"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });

    const resumed = await f.runtime.execute({
      type: "mission.resume",
      commandId: commandId("resume"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });

    expect(resumed.runId).not.toBe(runId);
    const mission = f.runtime.store.requireMission(missionId);
    expect(mission.status).toBe("running");
    expect(mission.activeRunId).toBe(resumed.runId);
    expect(mission.runIds).toHaveLength(2);

    const newRun = f.runtime.store.requireRun(resumed.runId!);
    expect(newRun.attempt).toBe(2);
    expect(newRun.resumeOfRunId).toBe(runId);
    expect(newRun.nativeSessionId).toBe(session);
    expect(newRun.status).toBe("running");
  });

  it("refuses to resume a mission that is not interrupted", async () => {
    const f = fixture();
    const { missionId } = await started(f);
    await expect(
      f.runtime.execute({
        type: "mission.resume",
        commandId: commandId(),
        missionId,
        expectedRevision: f.runtime.store.requireMission(missionId).revision,
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("refuses to resume a run that kept no native session", async () => {
    const f = fixture();
    const missionId = await createMission(f);
    const runId = f.runtime.store.requireMission(missionId).activeRunId!;
    await f.runtime.execute({
      type: "run.interrupt",
      commandId: commandId(),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });
    f.runtime.store.updateRun(runId, { nativeSessionId: undefined });
    await expect(
      f.runtime.execute({
        type: "mission.resume",
        commandId: commandId(),
        missionId,
        expectedRevision: f.runtime.store.requireMission(missionId).revision,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("completes a resumed run normally", async () => {
    const f = fixture();
    const { missionId, adapter } = await started(f);
    await f.runtime.execute({
      type: "run.interrupt",
      commandId: commandId(),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });
    const resumed = await f.runtime.execute({
      type: "mission.resume",
      commandId: commandId(),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });
    const run = f.runtime.store.requireRun(resumed.runId!);
    adapter.emitRaw(run.id, run.lastAdapterSeq + 1, "run.completed", { outcome: "succeeded" });
    expect(f.runtime.store.requireMission(missionId).status).toBe("succeeded");
  });

  it("cancels an interrupted mission without resuming it", async () => {
    const f = fixture();
    const { missionId } = await started(f);
    await f.runtime.execute({
      type: "run.interrupt",
      commandId: commandId(),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });
    await f.runtime.execute({
      type: "mission.cancel",
      commandId: commandId(),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
      reason: "not needed",
    });
    expect(f.runtime.store.requireMission(missionId).status).toBe("cancelled");
  });
});

describe("recovery after a crash", () => {
  it("reads every mission, run and event back from a closed database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-recover-"));
    const path = join(dir, "missions.db");
    const first = fixture(path);
    const root = await createMission(first, { title: "root" });
    const child = await createMission(first, { parentMissionId: root, title: "child" });
    const rootRun = first.runtime.store.requireMission(root).activeRunId!;
    first.adapters.adapter("hermes").emitRaw(rootRun, first.runtime.store.requireRun(rootRun).lastAdapterSeq + 1, "run.output", {
      text: "progress",
      stream: "stdout",
    });
    const eventCount = first.runtime.log.treeEvents(root, { limit: 1000 }).length;
    first.close();
    open.pop();

    const adapters = new FakeAdapterRegistry();
    const clock = new TestClock();
    const second = new MissionRuntime({ databasePath: path, adapters: (kind) => adapters.get(kind), now: clock.now });
    const read = second.readTree(root);
    expect(read.tree?.mission.id).toBe(root);
    expect(read.tree?.children.map((node) => node.mission.id)).toEqual([child]);
    expect(read.runs.map((run) => run.missionId).sort()).toEqual([root, child].sort());
    expect(read.events).toHaveLength(eventCount);
    expect(read.events.some((entry) => entry.type === "run.output")).toBe(true);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the open missions and their unstarted runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-recover2-"));
    const path = join(dir, "missions.db");
    const first = fixture(path);
    const running = await createMission(first, { title: "running" });
    const interrupted = await createMission(first, { title: "interrupted" });
    await first.runtime.execute({
      type: "run.interrupt",
      commandId: commandId(),
      missionId: interrupted,
      expectedRevision: first.runtime.store.requireMission(interrupted).revision,
    });
    first.close();
    open.pop();

    const adapters = new FakeAdapterRegistry();
    const clock = new TestClock();
    const second = new MissionRuntime({ databasePath: path, adapters: (kind) => adapters.get(kind), now: clock.now });
    const report = second.recover();
    expect(report.openMissions.map((mission) => mission.id).sort()).toEqual([running, interrupted].sort());
    expect(report.interruptedRuns.map((run) => run.missionId)).toEqual([interrupted]);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not re-run a command whose record survived the crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-recover3-"));
    const path = join(dir, "missions.db");
    const first = fixture(path);
    const missionId = await createMission(first, { commandId: "stable-create" });
    first.close();
    open.pop();

    const adapters = new FakeAdapterRegistry();
    const clock = new TestClock();
    const second = new MissionRuntime({ databasePath: path, adapters: (kind) => adapters.get(kind), now: clock.now });
    const replay = await second.execute({
      type: "mission.create",
      commandId: "stable-create",
      title: "demo mission",
      prompt: "do the thing",
      agent: "hermes",
      environment: {
        id: "env-1",
        label: "test computer",
        kind: "ssh",
        host: "127.0.0.1",
        user: "tester",
        authMode: "subscription",
      },
    });
    expect(replay.missionId).toBe(missionId);
    expect(replay.replayed).toBe(true);
    expect(second.store.listMissions()).toHaveLength(1);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("separates acceptance from native completion", async () => {
    const f = fixture();
    const missionId = await createMission(f);
    const run = f.runtime.store.requireRun(f.runtime.store.requireMission(missionId).activeRunId!);
    expect(run.acceptedAt).toBeDefined();
    expect(run.nativeCompletedAt).toBeUndefined();
    expect(run.nativeOutcome).toBeUndefined();
    expect(run.nativeStartedAt).toBeDefined();

    f.adapters.adapter("hermes").emitRaw(run.id, run.lastAdapterSeq + 1, "run.completed", { outcome: "succeeded" });
    const settled = f.runtime.store.requireRun(run.id);
    expect(settled.acceptedAt).toBe(run.acceptedAt);
    expect(settled.nativeCompletedAt).toBeDefined();
    expect(settled.nativeOutcome).toBe("succeeded");
  });
});
