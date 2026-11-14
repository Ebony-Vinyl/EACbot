import { afterEach, describe, expect, it } from "vitest";

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

async function parentWith(f: Fixture, childCount: number, agent: "hermes" = "hermes") {
  const parentId = await createMission(f, { title: "parent", agent });
  const children: string[] = [];
  for (let index = 0; index < childCount; index += 1) {
    children.push(await createMission(f, { parentMissionId: parentId, title: `child ${index}` }));
  }
  return { parentId, children };
}

function finishChild(f: Fixture, childId: string, outcome: "succeeded" | "failed" = "succeeded") {
  const mission = f.runtime.store.requireMission(childId);
  const adapter = f.adapters.adapter(mission.agent);
  const runId = mission.activeRunId!;
  const seq = f.runtime.store.requireRun(runId).lastAdapterSeq + 1;
  if (outcome === "succeeded") {
    adapter.emitRaw(runId, seq, "run.completed", { outcome: "succeeded" });
  } else {
    adapter.emitRaw(runId, seq, "run.failed", { code: "child_failed", message: "child exploded" });
  }
}

describe("parents and parallel children", () => {
  it("moves a parent to waiting_children while its children run", async () => {
    const f = fixture();
    const { parentId, children } = await parentWith(f, 2);
    const parent = f.runtime.store.requireMission(parentId);
    expect(parent.status).toBe("waiting_children");
    expect(parent.childIds).toEqual(children);
    for (const childId of children) {
      expect(f.runtime.store.requireMission(childId).status).toBe("running");
    }
  });

  it("wakes the parent exactly once, after the last child settles", async () => {
    const f = fixture();
    const { parentId, children } = await parentWith(f, 3);

    finishChild(f, children[0]!);
    finishChild(f, children[1]!);
    expect(f.runtime.records.inbox(parentId)).toHaveLength(0);
    expect(f.runtime.store.requireMission(parentId).status).toBe("waiting_children");

    finishChild(f, children[2]!);
    const inbox = f.runtime.records.inbox(parentId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.kind).toBe("wake");
    expect(inbox[0]!.generation).toBe(1);
    expect(f.runtime.store.requireMission(parentId).status).toBe("running");
    expect(f.runtime.store.requireMission(parentId).wakeGeneration).toBe(1);
  });

  it("does not wake twice when the last child settles again", async () => {
    const f = fixture();
    const { parentId, children } = await parentWith(f, 1);
    const child = f.runtime.store.requireMission(children[0]!);
    const runId = child.activeRunId!;
    finishChild(f, children[0]!);
    expect(f.runtime.records.inbox(parentId)).toHaveLength(1);

    f.adapters.adapter(child.agent).emitRaw(runId, 9, "run.child_settled", { childMissionId: children[0], status: "succeeded" });
    expect(f.runtime.records.inbox(parentId)).toHaveLength(1);
    expect(f.runtime.store.requireMission(parentId).wakeGeneration).toBe(1);
  });

  it("keeps the wake durable when the parent is interrupted while children settle", async () => {
    const f = fixture();
    const { parentId, children } = await parentWith(f, 1);
    await f.runtime.execute({
      type: "run.interrupt",
      commandId: commandId("pause-parent"),
      missionId: parentId,
      expectedRevision: f.runtime.store.requireMission(parentId).revision,
    });
    expect(f.runtime.store.requireMission(parentId).status).toBe("interrupted");

    finishChild(f, children[0]!);
    const inbox = f.runtime.records.inbox(parentId);
    expect(inbox).toHaveLength(1);
    expect(f.runtime.store.requireMission(parentId).status).toBe("interrupted");
    expect(f.runtime.store.requireMission(parentId).wakeGeneration).toBe(1);
  });

  it("does not settle a parent whose own run finishes while children are live", async () => {
    const f = fixture();
    const { parentId, children } = await parentWith(f, 1);
    const parent = f.runtime.store.requireMission(parentId);
    const run = f.runtime.store.requireRun(parent.activeRunId!);
    f.adapters.adapter("hermes").emitRaw(run.id, run.lastAdapterSeq + 1, "run.completed", { outcome: "succeeded" });

    expect(f.runtime.store.requireMission(parentId).status).toBe("waiting_children");
    expect(f.runtime.store.requireMission(parentId).settledAt).toBeUndefined();
    expect(f.runtime.store.requireMission(children[0]!).status).toBe("running");

    finishChild(f, children[0]!);
    expect(f.runtime.store.requireMission(parentId).status).toBe("running");
    expect(f.runtime.records.inbox(parentId)).toHaveLength(1);
  });

  it("rejects a cancel whose expected revision is stale", async () => {
    const f = fixture();
    const { parentId } = await parentWith(f, 1);
    const stale = f.runtime.store.requireMission(parentId).revision;
    await f.runtime.execute({
      type: "run.interrupt",
      commandId: commandId("bump"),
      missionId: parentId,
      expectedRevision: stale,
    });
    await expect(
      f.runtime.execute({
        type: "mission.cancel",
        commandId: commandId("stale-cancel"),
        missionId: parentId,
        expectedRevision: stale,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("writes at most one wake for a generation even when asked twice", async () => {
    const f = fixture();
    const { parentId } = await parentWith(f, 1);
    const records = f.runtime.records;
    const input = { missionId: parentId, generation: 7, kind: "wake" as const, payload: {}, createdAt: "2026-01-01T00:00:00.000Z" };
    expect(records.enqueueWake(input)).toBe(true);
    expect(records.enqueueWake(input)).toBe(false);
    expect(records.inbox(parentId).filter((item) => item.generation === 7)).toHaveLength(1);
  });

  it("settles the parent with a failed child while the others still complete", async () => {
    const f = fixture();
    const { parentId, children } = await parentWith(f, 2);
    finishChild(f, children[0]!, "failed");
    expect(f.runtime.store.requireMission(children[0]!).status).toBe("failed");
    expect(f.runtime.records.inbox(parentId)).toHaveLength(0);
    finishChild(f, children[1]!);
    expect(f.runtime.records.inbox(parentId)).toHaveLength(1);
    expect(f.runtime.store.requireMission(children[1]!).status).toBe("succeeded");
  });

  it("keeps sibling runs independent", async () => {
    const f = fixture();
    const { children } = await parentWith(f, 2);
    const first = f.runtime.store.requireMission(children[0]!);
    const second = f.runtime.store.requireMission(children[1]!);
    expect(first.activeRunId).not.toBe(second.activeRunId);
    expect(f.runtime.store.requireRun(first.activeRunId!).id).not.toBe(f.runtime.store.requireRun(second.activeRunId!).id);
    finishChild(f, children[0]!);
    expect(f.runtime.store.requireMission(children[1]!).status).toBe("running");
  });

  it("wakes the immediate parent only, and the grandparent only once its child settles", async () => {
    const f = fixture();
    const grandparent = await createMission(f, { title: "grandparent" });
    const parent = await createMission(f, { parentMissionId: grandparent, title: "parent" });
    const child = await createMission(f, { parentMissionId: parent, title: "child" });

    finishChild(f, child);
    expect(f.runtime.records.inbox(parent)).toHaveLength(1);
    expect(f.runtime.store.requireMission(parent).status).toBe("running");
    expect(f.runtime.records.inbox(grandparent)).toHaveLength(0);
    expect(f.runtime.store.requireMission(grandparent).status).toBe("waiting_children");

    finishChild(f, parent);
    expect(f.runtime.records.inbox(grandparent)).toHaveLength(1);
    expect(f.runtime.store.requireMission(grandparent).status).toBe("running");
  });

  it("cancels a whole subtree and wakes the surviving parent", async () => {
    const f = fixture();
    const { parentId, children } = await parentWith(f, 2);
    const nested = await createMission(f, { parentMissionId: children[0]!, title: "nested" });

    const revision = f.runtime.store.requireMission(parentId).revision;
    const result = await f.runtime.execute({
      type: "mission.cancel",
      commandId: commandId("cancel-tree"),
      missionId: parentId,
      expectedRevision: revision,
      reason: "user stopped it",
      cascade: true,
    });

    expect(result.affectedMissionIds?.sort()).toEqual([parentId, ...children, nested].sort());
    for (const id of [parentId, ...children, nested]) {
      const mission = f.runtime.store.requireMission(id);
      expect(mission.status).toBe("cancelled");
      expect(mission.cancelReason).toBe("user stopped it");
    }
  });

  it("cancels only the named mission when cascade is off", async () => {
    const f = fixture();
    const { parentId, children } = await parentWith(f, 2);
    const result = await f.runtime.execute({
      type: "mission.cancel",
      commandId: commandId("cancel-one"),
      missionId: children[0]!,
      expectedRevision: f.runtime.store.requireMission(children[0]!).revision,
      cascade: false,
    });
    expect(result.affectedMissionIds).toEqual([children[0]]);
    expect(f.runtime.store.requireMission(children[1]!).status).toBe("running");
    expect(f.runtime.store.requireMission(parentId).status).toBe("waiting_children");
  });

  it("wakes each ancestor as its own children settle", async () => {
    const f = fixture();
    const outer = await createMission(f, { title: "outer" });
    const middle = await createMission(f, { parentMissionId: outer, title: "middle" });
    const leaf = await createMission(f, { parentMissionId: middle, title: "leaf" });

    await f.runtime.execute({
      type: "mission.cancel",
      commandId: commandId("cancel-leaf"),
      missionId: leaf,
      expectedRevision: f.runtime.store.requireMission(leaf).revision,
      cascade: true,
    });
    expect(f.runtime.records.inbox(middle)).toHaveLength(1);
    expect(f.runtime.store.requireMission(middle).status).toBe("running");
    expect(f.runtime.records.inbox(outer)).toHaveLength(0);

    await f.runtime.execute({
      type: "mission.cancel",
      commandId: commandId("cancel-middle"),
      missionId: middle,
      expectedRevision: f.runtime.store.requireMission(middle).revision,
      cascade: true,
    });
    expect(f.runtime.records.inbox(outer)).toHaveLength(1);
    expect(f.runtime.store.requireMission(outer).status).toBe("running");
  });

  it("refuses to cancel a mission that already settled", async () => {
    const f = fixture();
    const missionId = await createMission(f);
    const adapter = f.adapters.adapter("hermes");
    adapter.emitRaw(f.runtime.store.requireMission(missionId).activeRunId!, 2, "run.completed", { outcome: "succeeded" });
    await expect(
      f.runtime.execute({
        type: "mission.cancel",
        commandId: commandId(),
        missionId,
        expectedRevision: f.runtime.store.requireMission(missionId).revision,
      }),
    ).rejects.toMatchObject({ code: "already_settled" });
  });

  it("asks the adapter to cancel every live run in the subtree", async () => {
    const f = fixture();
    const { parentId, children } = await parentWith(f, 2);
    const adapter = f.adapters.adapter("hermes");
    const runIds = [parentId, ...children].map((id) => f.runtime.store.requireMission(id).activeRunId!);
    const result = await f.runtime.execute({
      type: "mission.cancel",
      commandId: commandId("cancel-all"),
      missionId: parentId,
      expectedRevision: f.runtime.store.requireMission(parentId).revision,
      cascade: true,
    });
    expect([...(result.affectedRunIds ?? [])].sort()).toEqual([...runIds].sort());
    expect([...adapter.cancelled].sort()).toEqual([...runIds].sort());
    for (const runId of runIds) {
      expect(f.runtime.store.requireRun(runId).status).toBe("cancelled");
      expect(f.runtime.store.requireRun(runId).nativeOutcome).toBe("cancelled");
    }
  });
});
