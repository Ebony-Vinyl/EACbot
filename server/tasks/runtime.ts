import type { RoutineManager, RoutineInput } from "../routines.ts";
import { KanbanError, type KanbanStore } from "../plugins/kanban.ts";
import type { KanbanTask } from "../../shared/plugins/tasks.ts";

export class TaskRuntime {
  readonly boards: KanbanStore;
  private readonly routines: RoutineManager;
  private readonly botExists: (id: string) => boolean;

  constructor(
    boards: KanbanStore,
    routines: RoutineManager,
    botExists: (id: string) => boolean,
  ) {
    this.boards = boards;
    this.routines = routines;
    this.botExists = botExists;
    this.reconcile();
  }

  reconcile(): void {
    for (const run of this.routines
      .listRuns()
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt))
      this.boards.syncRoutineRun(run);
  }

  details(task: KanbanTask) {
    const routine = task.routineId
      ? this.routines
          .listRoutines()
          .find((entry) => entry.id === task.routineId)
      : undefined;
    return {
      ...task,
      schedule: routine?.schedule,
      nextRunAt: routine?.nextRunAt,
      scheduleEnabled: routine?.enabled ?? false,
    };
  }

  assertReady(task: KanbanTask): void {
    if (task.archivedAt)
      throw new KanbanError("conflict", "restore the task before running it");
    if (!task.assigneeBotId || !this.botExists(task.assigneeBotId))
      throw new KanbanError("invalid", "choose an available bot");
    if (
      (task.dependsOn ?? []).some(
        (id) => this.boards.task(task.boardId, id).column !== "done",
      )
    ) {
      throw new KanbanError("conflict", "complete the task dependencies first");
    }
  }

  private prepare(
    boardId: string,
    taskId: string,
    revision: number,
    schedule?: RoutineInput["schedule"],
  ): KanbanTask {
    const task = this.boards.task(boardId, taskId);
    if (task.revision !== revision)
      throw new KanbanError(
        "stale",
        `the task changed (revision ${task.revision}); read it again`,
      );
    this.assertReady(task);
    if (task.run && ["queued", "running", "waiting"].includes(task.run.status))
      throw new KanbanError("conflict", "the task already has an active run");
    if (
      schedule?.type === "once" &&
      (!Number.isFinite(schedule.at) || schedule.at <= Date.now())
    )
      throw new KanbanError("invalid", "choose a future execution time");
    const input: RoutineInput = {
      name: task.title,
      prompt: task.description || task.title,
      botId: task.assigneeBotId!,
      schedule: schedule ?? { type: "once", at: Date.now() + 60_000 },
      enabled: false,
      overlap: "skip",
      runOn: "maus",
      durationMinutes: 10,
    };
    const previous = task.routineId
      ? this.routines
          .listRoutines()
          .find((routine) => routine.id === task.routineId)
      : undefined;
    if (task.routineId && !previous)
      throw new KanbanError("conflict", "the linked routine was removed");
    const routine = previous
      ? this.routines.update(previous.id, input)!
      : this.routines.create(input);
    let attached: KanbanTask | undefined;
    try {
      attached = this.boards.setRoutine(
        boardId,
        taskId,
        revision,
        routine.id,
        schedule ? "scheduled" : "ready",
      );
      if (schedule) this.routines.update(routine.id, { enabled: true });
      return attached;
    } catch (error) {
      if (attached)
        this.boards.setRoutine(
          boardId,
          taskId,
          attached.revision,
          task.routineId,
          task.column,
        );
      if (previous) this.routines.update(previous.id, previous);
      else this.routines.remove(routine.id);
      throw error;
    }
  }

  patch(
    boardId: string,
    taskId: string,
    revision: number,
    patch: Parameters<KanbanStore["patchTask"]>[3],
  ): KanbanTask {
    const current = this.boards.task(boardId, taskId);
    if (
      current.routineId &&
      this.routines
        .listRoutines()
        .some((routine) => routine.id === current.routineId && routine.enabled)
    ) {
      throw new KanbanError(
        "conflict",
        "pause the schedule before editing the task",
      );
    }
    return this.boards.patchTask(boardId, taskId, revision, patch);
  }

  execute(boardId: string, taskId: string, revision: number): KanbanTask {
    const task = this.prepare(boardId, taskId, revision);
    if (!this.routines.runNow(task.routineId!))
      throw new KanbanError("conflict", "the routine could not start");
    this.reconcile();
    return this.boards.task(boardId, taskId);
  }

  schedule(
    boardId: string,
    taskId: string,
    revision: number,
    schedule: RoutineInput["schedule"],
  ): KanbanTask {
    return this.prepare(boardId, taskId, revision, schedule);
  }

  async cancel(
    boardId: string,
    taskId: string,
    revision: number,
  ): Promise<KanbanTask> {
    const task = this.boards.task(boardId, taskId);
    if (task.revision !== revision)
      throw new KanbanError("stale", "the task changed; read it again");
    if (task.routineId)
      this.routines.update(task.routineId, { enabled: false });
    if (task.run) await this.routines.cancelRun(task.run.runId);
    this.reconcile();
    const cancelled = this.boards.task(boardId, taskId);
    return cancelled.column === "scheduled"
      ? this.boards.patchTask(boardId, taskId, cancelled.revision, {
          column: "todo",
        })
      : cancelled;
  }

  taskForThread(threadId: string): KanbanTask | undefined {
    const run = this.routines
      .listRuns()
      .find((entry) => entry.threadId === threadId);
    return run
      ? this.boards.allTasks().find((task) => task.runIds?.includes(run.id))
      : undefined;
  }

  guardTurn(threadId: string): void {
    const run = this.routines
      .listRuns()
      .find(
        (entry) =>
          entry.threadId === threadId &&
          ["queued", "running", "waiting"].includes(entry.status),
      );
    const task =
      run &&
      this.boards.allTasks().find((entry) => entry.routineId === run.routineId);
    if (task) this.assertReady(task);
  }
}
