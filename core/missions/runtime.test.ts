import { afterEach, describe, expect, it } from "vitest";

import { CommandError } from "../../packages/agent-protocol/commands.ts";
import { findSecretFields } from "../../packages/agent-protocol/guards.ts";
import { FakeAdapter } from "./fake-adapter.ts";
import { commandId, createFixture, createMission, type Fixture } from "./fixture.ts";

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture(): Fixture {
  const created = createFixture();
  open.push(created);
  return created;
}

describe("the fake adapter runtime", () => {
  it("runs a scripted mission to success through structured events only", async () => {
    const f = fixture();
    const adapter = f.adapters.adapter("hermes");
    adapter.script({ output: ["thinking", "done"] });

    const missionId = await createMission(f);
    const runId = f.runtime.store.requireMission(missionId).activeRunId!;
    adapter.finish(runId);

    const mission = f.runtime.store.requireMission(missionId);
    expect(mission.status).toBe("succeeded");
    expect(mission.settledAt).toBeDefined();
    const types = f.runtime.log.events(missionId).map((entry) => entry.type);
    expect(types).toContain("run.output");
    expect(types).toContain("run.completed");
  });

  it("records a scripted artifact and a scripted approval", async () => {
    const f = fixture();
    const adapter = f.adapters.adapter("hermes");
    adapter.script({
      artifact: { path: "/tmp/report.md", bytes: 128, mediaType: "text/markdown" },
      approval: { action: "push branch", detail: "origin/main" },
    });
    const missionId = await createMission(f);
    const runId = f.runtime.store.requireMission(missionId).activeRunId!;
    adapter.finish(runId);

    expect(f.runtime.records.artifactsFor(missionId).map((artifact) => artifact.path)).toEqual(["/tmp/report.md"]);
    expect(f.runtime.records.approvalsFor(missionId).map((approval) => approval.action)).toEqual(["push branch"]);
    expect(f.runtime.store.requireMission(missionId).status).toBe("succeeded");
  });

  it("fails a mission through a scripted failure", async () => {
    const f = fixture();
    const adapter = f.adapters.adapter("hermes");
    adapter.script({ failWith: { code: "boom", message: "the tool crashed" } });
    const missionId = await createMission(f);
    const runId = f.runtime.store.requireMission(missionId).activeRunId!;
    adapter.finish(runId);

    const mission = f.runtime.store.requireMission(missionId);
    expect(mission.status).toBe("failed");
    expect(mission.error).toEqual({ code: "boom", message: "the tool crashed" });
  });

  it("holds a run at waiting_input until the input is submitted", async () => {
    const f = fixture();
    const adapter = f.adapters.adapter("hermes");
    adapter.script({ waitingForInput: true });
    const missionId = await createMission(f);
    const runId = f.runtime.store.requireMission(missionId).activeRunId!;
    adapter.finish(runId);
    expect(f.runtime.store.requireMission(missionId).status).toBe("waiting_input");

    await f.runtime.execute({
      type: "run.submit_input",
      commandId: commandId(),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
      input: "use the staging branch",
    });
    expect(f.runtime.store.requireMission(missionId).status).toBe("running");
  });

  it("is deterministic: finishing the same run twice changes nothing", async () => {
    const f = fixture();
    const adapter = f.adapters.adapter("hermes");
    const missionId = await createMission(f);
    const runId = f.runtime.store.requireMission(missionId).activeRunId!;
    adapter.finish(runId);
    const before = f.runtime.store.requireMission(missionId);
    const events = f.runtime.log.countFor(missionId);
    adapter.finish(runId);
    expect(f.runtime.store.requireMission(missionId)).toEqual(before);
    expect(f.runtime.log.countFor(missionId)).toBe(events);
  });

  it("declares a descriptor with no secret fields and real capabilities", () => {
    const adapter = new FakeAdapter("claudeCode");
    const descriptor = adapter.describe();
    expect(descriptor.kind).toBe("claudeCode");
    expect(descriptor.capabilities.steer.kind).toBe("native");
    expect(descriptor.capabilities.images).toBe(true);
    expect(descriptor.models[0]!.ref.model).toBe("fake-1");
    expect(findSecretFields(descriptor)).toEqual([]);
    expect(descriptor.authModes).toContain("apiKey");
  });

  it("reports a missing adapter instead of silently dropping a run", async () => {
    const f = fixture();
    const missionId = await createMission(f, { agent: "custom" });
    expect(f.runtime.store.requireMission(missionId).agent).toBe("custom");
    const noAdapter = createFixture();
    open.push(noAdapter);
    const failing = new CommandError("capability_missing", "no adapter");
    expect(failing.status).toBe(422);
  });

  it("keeps a mission and its run revision moving together on each command", async () => {
    const f = fixture();
    const missionId = await createMission(f);
    const first = f.runtime.store.requireMission(missionId);
    await f.runtime.execute({
      type: "run.interrupt",
      commandId: commandId(),
      missionId,
      expectedRevision: first.revision,
    });
    const second = f.runtime.store.requireMission(missionId);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.status).toBe("interrupted");
  });

  it("records a terminal run outcome distinct from acceptance", async () => {
    const f = fixture();
    const adapter = f.adapters.adapter("hermes");
    adapter.script({ output: ["a"] });
    const missionId = await createMission(f);
    const runId = f.runtime.store.requireMission(missionId).activeRunId!;
    const accepted = f.runtime.store.requireRun(runId);
    adapter.finish(runId);
    const done = f.runtime.store.requireRun(runId);
    expect(done.acceptedAt).toBe(accepted.acceptedAt);
    expect(done.nativeOutcome).toBe("succeeded");
    expect(done.nativeCompletedAt).toBeDefined();
  });

  it("delivers a wake to the parent's durable inbox and lets it be consumed once", async () => {
    const f = fixture();
    const parentId = await createMission(f, { title: "parent" });
    const childId = await createMission(f, { parentMissionId: parentId, title: "child" });
    const adapter = f.adapters.adapter("hermes");
    const child = f.runtime.store.requireMission(childId);
    adapter.emitRaw(child.activeRunId!, child.revision > 0 ? f.runtime.store.requireRun(child.activeRunId!).lastAdapterSeq + 1 : 2, "run.completed", {
      outcome: "succeeded",
    });

    const inbox = f.runtime.records.inbox(parentId);
    expect(inbox).toHaveLength(1);
    const payload = inbox[0]!.payload as { children: { missionId: string; status: string }[] };
    expect(payload.children).toEqual([{ missionId: childId, status: "succeeded" }]);

    const consumedAt = f.clock.now();
    expect(f.runtime.records.consumeInbox(parentId, consumedAt)).toBe(1);
    expect(f.runtime.records.consumeInbox(parentId, consumedAt)).toBe(0);
    expect(f.runtime.records.inbox(parentId)).toHaveLength(0);
    expect(f.runtime.records.inbox(parentId, true)).toHaveLength(1);
  });
});
