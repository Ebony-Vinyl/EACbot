import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { KanbanError, KanbanStore } from "./kanban.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function makeStore(ttlMs = 60_000) {
  const folder = mkdtempSync(join(tmpdir(), "eac-kanban-"));
  folders.push(folder);
  let at = Date.parse("2026-11-08T00:00:00.000Z");
  const store = new KanbanStore(folder, { now: () => new Date(at).toISOString(), ttlMs });
  return { folder, store, advance: (ms: number) => { at += ms; } };
}

function boardWithTask(store: KanbanStore) {
  const board = store.createBoard({ name: "Work" });
  const task = store.createTask(board.boardId, { title: "Ship M6" });
  return { board, task };
}

describe("kanban tasks", () => {
  it("persists boards and tasks with a monotonic revision", () => {
    const { folder, store } = makeStore();
    const { board, task } = boardWithTask(store);
    expect(task).toMatchObject({ column: "backlog", revision: 1 });
    const moved = store.patchTask(board.boardId, task.taskId, 1, { column: "ready", title: "Ship M6 today" });
    expect(moved).toMatchObject({ column: "ready", revision: 2, title: "Ship M6 today" });
    expect(new KanbanStore(folder).tasks(board.boardId)).toMatchObject([{ taskId: task.taskId, revision: 2 }]);
  });

  it("returns a recoverable conflict on a stale revision", () => {
    const { store } = makeStore();
    const { board, task } = boardWithTask(store);
    store.patchTask(board.boardId, task.taskId, 1, { column: "ready" });
    expect(() => store.patchTask(board.boardId, task.taskId, 1, { column: "doing" })).toThrow(KanbanError);
    expect(() => store.patchTask(board.boardId, task.taskId, 1, { column: "doing" })).toThrow(/revision 2/);
  });

  it("lets only the lease holder start and finish a run", () => {
    const { store } = makeStore();
    const { board, task } = boardWithTask(store);
    const claimed = store.claim(board.boardId, task.taskId, 1, "worker-a");
    expect(claimed.lease?.holderId).toBe("worker-a");
    expect(() => store.claim(board.boardId, task.taskId, claimed.revision, "worker-b")).toThrow(/another executor/);
    expect(() => store.startRun(board.boardId, task.taskId, claimed.lease!.leaseId, "worker-b")).toThrow(/another executor/);
    const running = store.startRun(board.boardId, task.taskId, claimed.lease!.leaseId, "worker-a");
    expect(running.run).toMatchObject({ status: "running", executorId: "worker-a" });
    expect(() => store.finishRun(board.boardId, task.taskId, running.run!.runId, "worker-b", "succeeded")).toThrow(/executor/);
    const finished = store.finishRun(board.boardId, task.taskId, running.run!.runId, "worker-a", "succeeded");
    expect(finished.run).toMatchObject({ status: "succeeded" });
    expect(finished.lease).toBeUndefined();
  });

  it("makes finishing idempotent for a duplicated delivery", () => {
    const { store } = makeStore();
    const { board, task } = boardWithTask(store);
    const claimed = store.claim(board.boardId, task.taskId, 1, "worker-a");
    const running = store.startRun(board.boardId, task.taskId, claimed.lease!.leaseId, "worker-a");
    const first = store.finishRun(board.boardId, task.taskId, running.run!.runId, "worker-a", "succeeded");
    const again = store.finishRun(board.boardId, task.taskId, running.run!.runId, "worker-a", "succeeded");
    expect(again.revision).toBe(first.revision);
  });

  it("reclaims an expired lease without a second approval and refuses a stale heartbeat", () => {
    const { store, advance } = makeStore(1_000);
    const { board, task } = boardWithTask(store);
    const claimed = store.claim(board.boardId, task.taskId, 1, "worker-a");
    advance(1_001);
    expect(() => store.heartbeat(board.boardId, task.taskId, claimed.lease!.leaseId)).toThrow(/expired/);
    const reclaimed = store.claim(board.boardId, task.taskId, claimed.revision, "worker-b");
    expect(reclaimed.lease?.holderId).toBe("worker-b");
  });

  it("keeps a task out of done until its run succeeds", () => {
    const { store } = makeStore();
    const { board, task } = boardWithTask(store);
    const claimed = store.claim(board.boardId, task.taskId, 1, "worker-a");
    const running = store.startRun(board.boardId, task.taskId, claimed.lease!.leaseId, "worker-a");
    expect(() => store.patchTask(board.boardId, task.taskId, running.revision, { column: "done" })).toThrow(/unfinished/);
    const finished = store.finishRun(board.boardId, task.taskId, running.run!.runId, "worker-a", "succeeded");
    expect(store.patchTask(board.boardId, task.taskId, finished.revision, { column: "done" }).column).toBe("done");
  });
});

it("ends a crashed executor's run when its expired lease is reclaimed", () => {
  const { store, advance } = makeStore(1000);
  const { board, task } = boardWithTask(store);
  const claimed = store.claim(board.boardId, task.taskId, task.revision, "worker-a");
  const running = store.startRun(board.boardId, task.taskId, claimed.lease!.leaseId, "worker-a");
  advance(1001);
  const recovered = store.claim(board.boardId, task.taskId, running.revision, "worker-b");
  expect(recovered.run?.status).toBe("failed");
  expect(() => store.finishRun(board.boardId, task.taskId, running.run!.runId, "worker-a", "succeeded")).toThrow(/not running/);
  expect(store.startRun(board.boardId, task.taskId, recovered.lease!.leaseId, "worker-b").run?.status).toBe("running");
});
