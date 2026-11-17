import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RevisionConflictError } from "./errors.ts";
import { createFixture, createMission, environment, type Fixture } from "./fixture.ts";
import { MissionRuntime } from "./runtime.ts";
import { FakeAdapterRegistry } from "./fake-registry.ts";
import { TestClock } from "./fixture.ts";

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture(path?: string): Fixture {
  const created = createFixture(path);
  open.push(created);
  return created;
}

describe("the durable mission store", () => {
  it("accepts a mission and its first run before any native work starts", async () => {
    const f = fixture();
    const missionId = await createMission(f);
    const mission = f.runtime.store.requireMission(missionId);
    expect(mission.protocolVersion).toBe(1);
    expect(mission.status).toBe("running");
    expect(mission.acceptedAt).toBe(mission.createdAt);
    expect(mission.rootMissionId).toBe(missionId);
    expect(mission.depth).toBe(0);
    expect(mission.runIds).toHaveLength(1);

    const run = f.runtime.store.requireRun(mission.activeRunId!);
    expect(run.acceptedAt).toBe(mission.acceptedAt);
    expect(run.attempt).toBe(1);
    expect(run.status).toBe("running");
    expect(run.nativeStartedAt).toBeDefined();
  });

  it("runs in WAL mode with full durability", () => {
    const f = fixture();
    const journal = f.runtime.store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const sync = f.runtime.store.db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    expect(journal.journal_mode).toBe("wal");
    expect(sync.synchronous).toBe(2);
  });

  it("builds a tree whose children inherit the root and one deeper level", async () => {
    const f = fixture();
    const root = await createMission(f);
    const child = await createMission(f, { parentMissionId: root, title: "child" });
    const grandchild = await createMission(f, { parentMissionId: child, title: "grandchild" });

    const rootMission = f.runtime.store.requireMission(root);
    expect(rootMission.status).toBe("waiting_children");
    const childMission = f.runtime.store.requireMission(child);
    expect(childMission.rootMissionId).toBe(root);
    expect(childMission.depth).toBe(1);
    expect(f.runtime.store.requireMission(grandchild).depth).toBe(2);

    const tree = f.runtime.store.missionTree(root)!;
    expect(tree.mission.id).toBe(root);
    expect(tree.children.map((node) => node.mission.id)).toEqual([child]);
    expect(tree.children[0]!.children.map((node) => node.mission.id)).toEqual([grandchild]);
    expect(rootMission.childIds).toEqual([child]);
  });

  it("lists every descendant of a mission", async () => {
    const f = fixture();
    const root = await createMission(f);
    const first = await createMission(f, { parentMissionId: root });
    const second = await createMission(f, { parentMissionId: root });
    const leaf = await createMission(f, { parentMissionId: first });
    expect(f.runtime.store.descendantsOf(root).map((m) => m.id).sort()).toEqual([first, leaf, second].sort());
  });

  it("rejects a mutation whose expected revision is stale", async () => {
    const f = fixture();
    const missionId = await createMission(f);
    const mission = f.runtime.store.requireMission(missionId);
    expect(() => f.runtime.store.mutateMission(missionId, mission.revision - 1, { updatedAt: f.clock.now() })).toThrow(
      RevisionConflictError,
    );
    expect(() => f.runtime.store.mutateMission(missionId, mission.revision, { status: "succeeded", updatedAt: f.clock.now() })).not.toThrow();
  });

  it("refuses a transition the machine forbids", async () => {
    const f = fixture();
    const missionId = await createMission(f);
    f.runtime.store.applyAuthorityStatus(missionId, "succeeded", f.clock.now());
    const settled = f.runtime.store.requireMission(missionId);
    expect(() => f.runtime.store.mutateMission(missionId, settled.revision, { status: "running", updatedAt: f.clock.now() })).toThrow(
      /cannot move from succeeded to running/,
    );
  });

  it("never stores a secret field on a mission", async () => {
    const f = fixture();
    await expect(
      f.runtime.execute({
        type: "mission.create",
        commandId: "secret-create",
        title: "leaky",
        prompt: "x",
        agent: "hermes",
        environment: { ...environment(), privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----" } as never,
      }),
    ).rejects.toThrow(/secret-bearing/);
    expect(f.runtime.store.listMissions()).toHaveLength(0);
  });

  it("reads its own state back after the process closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-restart-"));
    const path = join(dir, "missions.db");
    const first = fixture(path);
    const missionId = await createMission(first);
    const runId = first.runtime.store.requireMission(missionId).activeRunId!;
    first.runtime.ingest({
      source: "adapter",
      type: "run.output",
      eventId: "evt-persisted",
      seq: first.runtime.store.requireRun(runId).lastAdapterSeq + 1,
      missionId,
      runId,
      at: "2026-01-01T00:00:09.000Z",
      text: "kept",
      stream: "assistant",
    });
    const before = first.runtime.store.requireMission(missionId);
    first.close();
    open.pop();

    const clock = new TestClock();
    const adapters = new FakeAdapterRegistry();
    const restarted = new MissionRuntime({ databasePath: path, adapters: (kind) => adapters.get(kind), now: clock.now });
    const after = restarted.store.requireMission(missionId);
    expect(after).toEqual(before);
    expect(restarted.log.events(missionId).some((entry) => entry.type === "run.output")).toBe(true);
    expect(existsSync(path)).toBe(true);
    restarted.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the database file beside its WAL companion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-wal-"));
    const path = join(dir, "missions.db");
    const f = createFixture(path);
    await createMission(f);
    f.runtime.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(existsSync(path)).toBe(true);
    f.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
