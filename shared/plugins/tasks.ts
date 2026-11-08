import { z } from "zod";

export const KANBAN_COLUMNS = ["backlog", "ready", "doing", "blocked", "review", "done"] as const;
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];

export const RUN_STATUSES = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"]);

const instant = z.string().datetime({ offset: true });

export const kanbanBoardSchema = z.object({
  boardId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  createdAt: instant,
}).strict();

export type KanbanBoard = z.infer<typeof kanbanBoardSchema>;

export const kanbanLeaseSchema = z.object({
  leaseId: z.string().uuid(),
  holderId: z.string().min(1).max(120),
  expiresAt: instant,
  heartbeatAt: instant,
}).strict();

export type KanbanLease = z.infer<typeof kanbanLeaseSchema>;

export const kanbanRunSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(RUN_STATUSES),
  executorId: z.string().min(1).max(120).optional(),
  startedAt: instant.optional(),
  endedAt: instant.optional(),
  error: z.string().max(500).optional(),
}).strict();

export type KanbanRun = z.infer<typeof kanbanRunSchema>;

export const kanbanTaskSchema = z.object({
  taskId: z.string().uuid(),
  boardId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(8_000).optional(),
  column: z.enum(KANBAN_COLUMNS),
  revision: z.number().int().min(1),
  assigneeBotId: z.string().max(120).optional(),
  dependsOn: z.array(z.string().uuid()).max(50).optional(),
  lease: kanbanLeaseSchema.optional(),
  run: kanbanRunSchema.optional(),
  createdAt: instant,
  updatedAt: instant,
}).strict();

export type KanbanTask = z.infer<typeof kanbanTaskSchema>;

export type TaskActorKind = "person" | "bot" | "plugin" | "executor";

export interface TaskActor {
  kind: TaskActorKind;
  id: string;
}

export type TaskRefusal =
  | { ok: false; code: "EXECUTOR_ONLY" | "NOT_RUNNING" | "TERMINAL" | "WRONG_ACTOR" | "DONE_NEEDS_SUCCESS"; error: string }
  | { ok: true };

/** Only the executor that holds the lease moves a run to running or out of it. A failed or cancelled run may be retried;
 * a succeeded one may not be run again. */
export function canChangeRunStatus(from: RunStatus | undefined, to: RunStatus, actor: TaskActor): TaskRefusal {
  if (from === "succeeded") return { ok: false, code: "TERMINAL", error: "the run already succeeded" };
  if (from !== undefined && to === "running" && from !== "failed" && from !== "cancelled") {
    return { ok: false, code: "NOT_RUNNING", error: "a new run starts only after the previous one ended" };
  }
  if (to === "running" && actor.kind !== "executor") return { ok: false, code: "EXECUTOR_ONLY", error: "only its executor starts a run" };
  if (from === "running" && actor.kind !== "executor") return { ok: false, code: "EXECUTOR_ONLY", error: "only its executor changes a running run" };
  return { ok: true };
}

/** A task may enter done only when no run exists or its run has succeeded. */
export function canMoveToColumn(task: Pick<KanbanTask, "run">, column: KanbanColumn): TaskRefusal {
  if (column !== "done") return { ok: true };
  if (!task.run) return { ok: true };
  if (task.run.status === "succeeded") return { ok: true };
  return { ok: false, code: "DONE_NEEDS_SUCCESS", error: "a task with an unfinished run cannot be done" };
}

export function leaseLive(lease: KanbanLease | undefined, at: string): boolean {
  return Boolean(lease && Date.parse(lease.expiresAt) > Date.parse(at));
}
