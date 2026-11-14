import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RoutineManager } from "../routines.ts";
import { KanbanStore } from "../plugins/kanban.ts";
import { TaskRuntime } from "./runtime.ts";

const folders: string[] = [];
const managers: RoutineManager[] = [];
afterEach(() => {
  managers.splice(0).forEach((manager) => manager.close());
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});

function setup() {
  const folder = mkdtempSync(join(tmpdir(), "eac-task-runtime-"));
  folders.push(folder);
  const boards = new KanbanStore(folder);
  const board = boards.createBoard({ name: "Work" });
  let now = Date.now();
  const starts: string[] = [];
  const routines = new RoutineManager({
    file: join(folder, "routines.json"),
    now: () => now,
    botState: () => "ready",
    createTask: () => ({ threadId: `thread-${starts.length}` }),
    startTurn: async (_botId, threadId) => {
      starts.push(threadId);
    },
    onRunChanged: (run) => boards.syncRoutineRun(run),
  });
  managers.push(routines);
  const runtime = new TaskRuntime(boards, routines, (id) => id === "bot");
  const task = boards.createTask(board.boardId, {
    title: "Research",
    assigneeBotId: "bot",
  });
  return {
    folder,
    boards,
    board,
    task,
    routines,
    runtime,
    starts,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("executes through RoutineManager once, records an artifact and preserves the completed state after reload", async () => {
  const { folder, boards, board, task, routines, runtime, starts } = setup();
  const queued = runtime.execute(board.boardId, task.taskId, task.revision);
  expect(() =>
    runtime.execute(board.boardId, task.taskId, queued.revision),
  ).toThrow(/active run/);
  await routines.tick();
  expect(starts).toHaveLength(1);
  const running = boards.task(board.boardId, task.taskId);
  expect(running).toMatchObject({
    column: "doing",
    run: { status: "running", threadId: starts[0] },
  });
  routines.handleRuntimeEvent({
    type: "item.completed",
    itemType: "assistant_text",
    threadId: starts[0]!,
    text: "Verified result",
  } as Parameters<RoutineManager["handleRuntimeEvent"]>[0]);
  routines.handleRuntimeEvent({
    type: "turn.completed",
    threadId: starts[0]!,
    ok: true,
  } as Parameters<RoutineManager["handleRuntimeEvent"]>[0]);
  const finished = boards.task(board.boardId, task.taskId);
  expect(finished).toMatchObject({
    column: "review",
    run: { status: "succeeded" },
  });
  expect(finished.artifacts?.[0]?.text).toContain("Verified result");
  runtime.reconcile();
  runtime.reconcile();
  expect(boards.task(board.boardId, task.taskId).revision).toBe(
    finished.revision,
  );
  expect(
    new KanbanStore(folder).task(board.boardId, task.taskId).run?.status,
  ).toBe("succeeded");
});

it("gates dependencies, persists the scheduler link, cancels a scheduled task and does not dispatch it", async () => {
  const { boards, board, task, routines, runtime, starts, advance } = setup();
  const child = boards.createTask(board.boardId, {
    title: "Dependent",
    assigneeBotId: "bot",
    dependsOn: [task.taskId],
  });
  expect(() =>
    runtime.execute(board.boardId, child.taskId, child.revision),
  ).toThrow(/dependencies/);
  const scheduled = runtime.schedule(
    board.boardId,
    task.taskId,
    task.revision,
    { type: "once", at: Date.now() + 30_000 },
  );
  expect(scheduled.column).toBe("scheduled");
  expect(runtime.details(scheduled).scheduleEnabled).toBe(true);
  expect(() =>
    runtime.patch(board.boardId, task.taskId, scheduled.revision, {
      description: "changed",
    }),
  ).toThrow(/pause/);
  await runtime.cancel(board.boardId, task.taskId, scheduled.revision);
  advance(31_000);
  await routines.tick();
  expect(starts).toHaveLength(0);
  expect(boards.task(board.boardId, task.taskId).column).toBe("todo");
});

it("rejects forged running state, dependency cycles and stale writes without losing task data", () => {
  const { boards, board, task } = setup();
  expect(() =>
    boards.createTask(board.boardId, { title: "Fake", column: "doing" }),
  ).toThrow(/pending/);
  const child = boards.createTask(board.boardId, {
    title: "Child",
    dependsOn: [task.taskId],
  });
  expect(() =>
    boards.patchTask(board.boardId, task.taskId, task.revision, {
      dependsOn: [child.taskId],
    }),
  ).toThrow(/cycle/);
  expect(() =>
    boards.patchTask(board.boardId, task.taskId, task.revision, { title: "" }),
  ).toThrow();
  expect(boards.task(board.boardId, task.taskId).title).toBe("Research");
});

it("requeues an interrupted executor once after restart and keeps one artifact", async () => {
  const { folder, boards, board, task, routines, runtime, starts } = setup();
  runtime.execute(board.boardId, task.taskId, task.revision);
  await routines.tick();
  await expect
    .poll(
      () =>
        JSON.parse(readFileSync(join(folder, "routines.json"), "utf8")).runs[0]
          ?.status,
    )
    .toBe("running");
  routines.close();
  let recoveredAt = Date.now();
  const restarted = new RoutineManager({
    now: () => recoveredAt,
    file: join(folder, "routines.json"),
    botState: () => "ready",
    createTask: () => ({ threadId: "recovered" }),
    startTurn: async (_bot, threadId) => {
      starts.push(threadId);
    },
    onRunChanged: (run) => boards.syncRoutineRun(run),
  });
  managers.push(restarted);
  new TaskRuntime(boards, restarted, () => true);
  recoveredAt = restarted.listRuns()[0]!.retryAt! + 1;
  await restarted.tick();
  await restarted.tick();
  expect(starts).toHaveLength(2);
  const recovered = boards.task(board.boardId, task.taskId);
  restarted.handleRuntimeEvent({
    type: "item.completed",
    threadId: recovered.run!.threadId!,
    itemType: "assistant_text",
    text: "Recovered output",
  } as Parameters<RoutineManager["handleRuntimeEvent"]>[0]);
  restarted.handleRuntimeEvent({
    type: "turn.completed",
    threadId: recovered.run!.threadId!,
    ok: true,
  } as Parameters<RoutineManager["handleRuntimeEvent"]>[0]);
  expect(boards.task(board.boardId, task.taskId).artifacts).toHaveLength(1);
});
