import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import {
  canChangeRunStatus,
  canMoveToColumn,
  kanbanBoardSchema,
  kanbanTaskSchema,
  leaseLive,
  type KanbanBoard,
  type KanbanColumn,
  type KanbanTask,
  type RunStatus,
} from "../../shared/plugins/tasks.ts";

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  boards: z.array(kanbanBoardSchema).max(100),
  tasks: z.array(kanbanTaskSchema).max(20_000),
}).strict();

export class KanbanError extends Error {
  readonly code: "invalid" | "not-found" | "conflict" | "stale" | "forbidden" | "corrupt";
  constructor(code: KanbanError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface KanbanOptions {
  now?: () => string;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;
const MAX_TASKS = 20_000;

/** Kanban tasks with CAS revisions and executor leases; a second scheduler is never started here. */
export class KanbanStore {
  readonly file: string;
  private state: z.infer<typeof fileSchema> | null = null;
  private readonly now: () => string;
  private readonly ttlMs: number;

  constructor(dataDir: string, options: KanbanOptions = {}) {
    this.file = join(dataDir, "tasks", "kanban.json");
    this.now = options.now ?? (() => new Date().toISOString());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  createBoard(input: { name: string; boardId?: string }): KanbanBoard {
    const parsed = kanbanBoardSchema.safeParse({
      boardId: input.boardId ?? randomUUID(),
      name: input.name,
      createdAt: this.now(),
    });
    if (!parsed.success) throw new KanbanError("invalid", parsed.error.issues[0]?.message ?? "invalid board");
    const state = this.load();
    if (state.boards.some((board) => board.boardId === parsed.data.boardId)) {
      throw new KanbanError("conflict", "a board with this id already exists");
    }
    state.boards.push(parsed.data);
    this.persist(state);
    return structuredClone(parsed.data);
  }

  boards(): KanbanBoard[] {
    return this.load().boards.map((board) => structuredClone(board));
  }

  tasks(boardId: string): KanbanTask[] {
    this.requireBoard(boardId);
    return this.load().tasks.filter((task) => task.boardId === boardId).map((task) => structuredClone(task));
  }

  task(boardId: string, taskId: string): KanbanTask {
    return structuredClone(this.requireTask(boardId, taskId));
  }

  createTask(boardId: string, input: {
    title: string;
    description?: string;
    column?: KanbanColumn;
    assigneeBotId?: string;
    dependsOn?: string[];
  }): KanbanTask {
    this.requireBoard(boardId);
    const at = this.now();
    const parsed = kanbanTaskSchema.safeParse({
      taskId: randomUUID(),
      boardId,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      column: input.column ?? "backlog",
      revision: 1,
      ...(input.assigneeBotId ? { assigneeBotId: input.assigneeBotId } : {}),
      ...(input.dependsOn?.length ? { dependsOn: input.dependsOn } : {}),
      createdAt: at,
      updatedAt: at,
    });
    if (!parsed.success) throw new KanbanError("invalid", parsed.error.issues[0]?.message ?? "invalid task");
    const state = this.load();
    for (const dependency of parsed.data.dependsOn ?? []) {
      if (!state.tasks.some((task) => task.boardId === boardId && task.taskId === dependency)) {
        throw new KanbanError("invalid", "a dependency does not exist on this board");
      }
    }
    state.tasks.push(parsed.data);
    this.persist(state);
    return structuredClone(parsed.data);
  }

  patchTask(boardId: string, taskId: string, expectedRevision: number, patch: {
    title?: string;
    description?: string;
    column?: KanbanColumn;
    assigneeBotId?: string | null;
    dependsOn?: string[];
  }): KanbanTask {
    const task = this.requireTask(boardId, taskId);
    this.expectRevision(task, expectedRevision);
    if (patch.column && patch.column !== task.column) {
      const allowed = canMoveToColumn({ run: task.run }, patch.column);
      if (!allowed.ok) throw new KanbanError("forbidden", allowed.error);
    }
    if (patch.dependsOn) {
      const state = this.load();
      for (const dependency of patch.dependsOn) {
        if (dependency === taskId || !state.tasks.some((candidate) => candidate.boardId === boardId && candidate.taskId === dependency)) {
          throw new KanbanError("invalid", "a dependency does not exist on this board");
        }
      }
    }
    const next: KanbanTask = {
      ...task,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.column !== undefined ? { column: patch.column } : {}),
      ...(patch.assigneeBotId !== undefined ? { assigneeBotId: patch.assigneeBotId ?? undefined } : {}),
      ...(patch.dependsOn !== undefined ? { dependsOn: patch.dependsOn } : {}),
      revision: task.revision + 1,
      updatedAt: this.now(),
    };
    if (patch.assigneeBotId === null) delete next.assigneeBotId;
    this.replaceTask(next);
    return structuredClone(next);
  }

  /** A holder claims the task before it starts work; an expired lease can be reclaimed without a second approval. */
  claim(boardId: string, taskId: string, expectedRevision: number, holderId: string, ttlMs = this.ttlMs): KanbanTask {
    const task = this.requireTask(boardId, taskId);
    this.expectRevision(task, expectedRevision);
    const at = this.now();
    if (leaseLive(task.lease, at) && task.lease!.holderId !== holderId) {
      throw new KanbanError("conflict", "another executor holds this task");
    }
    const next: KanbanTask = {
      ...task,
      lease: {
        leaseId: randomUUID(),
        holderId,
        expiresAt: new Date(Date.parse(at) + ttlMs).toISOString(),
        heartbeatAt: at,
      },
      revision: task.revision + 1,
      updatedAt: at,
    };
    this.replaceTask(next);
    return structuredClone(next);
  }

  heartbeat(boardId: string, taskId: string, leaseId: string, ttlMs = this.ttlMs): KanbanTask {
    const task = this.requireTask(boardId, taskId);
    this.requireLease(task, leaseId);
    const at = this.now();
    const next: KanbanTask = {
      ...task,
      lease: {
        ...task.lease!,
        heartbeatAt: at,
        expiresAt: new Date(Date.parse(at) + ttlMs).toISOString(),
      },
      revision: task.revision + 1,
      updatedAt: at,
    };
    this.replaceTask(next);
    return structuredClone(next);
  }

  startRun(boardId: string, taskId: string, leaseId: string, executorId: string): KanbanTask {
    const task = this.requireTask(boardId, taskId);
    this.requireLease(task, leaseId);
    if (task.lease!.holderId !== executorId) throw new KanbanError("forbidden", "the lease belongs to another executor");
    const allowed = canChangeRunStatus(task.run?.status, "running", { kind: "executor", id: executorId });
    if (!allowed.ok) throw new KanbanError("forbidden", allowed.error);
    const at = this.now();
    const next: KanbanTask = {
      ...task,
      run: {
        runId: randomUUID(),
        status: "running",
        executorId,
        startedAt: at,
      },
      revision: task.revision + 1,
      updatedAt: at,
    };
    this.replaceTask(next);
    return structuredClone(next);
  }

  /** Finishing is idempotent for the same run: a duplicated delivery does not append a second result. */
  finishRun(boardId: string, taskId: string, runId: string, executorId: string, status: Exclude<RunStatus, "queued" | "running" | "waiting">, error?: string): KanbanTask {
    const task = this.requireTask(boardId, taskId);
    if (!task.run || task.run.runId !== runId) throw new KanbanError("not-found", "no such run");
    if (task.run.executorId !== executorId) throw new KanbanError("forbidden", "only the executor that started the run may finish it");
    if (task.run.status === status) return structuredClone(task);
    if (task.run.status !== "running") throw new KanbanError("conflict", "the run is not running");
    const at = this.now();
    const next: KanbanTask = {
      ...task,
      run: { ...task.run, status, endedAt: at, ...(error ? { error: error.slice(0, 500) } : {}) },
      revision: task.revision + 1,
      updatedAt: at,
    };
    delete next.lease;
    this.replaceTask(next);
    return structuredClone(next);
  }

  release(boardId: string, taskId: string, leaseId: string): KanbanTask {
    const task = this.requireTask(boardId, taskId);
    this.requireLease(task, leaseId);
    const next = { ...task, revision: task.revision + 1, updatedAt: this.now() };
    delete next.lease;
    this.replaceTask(next);
    return structuredClone(next);
  }

  private requireBoard(boardId: string): KanbanBoard {
    const board = this.load().boards.find((candidate) => candidate.boardId === boardId);
    if (!board) throw new KanbanError("not-found", "no such board");
    return board;
  }

  private requireTask(boardId: string, taskId: string): KanbanTask {
    const task = this.load().tasks.find((candidate) => candidate.boardId === boardId && candidate.taskId === taskId);
    if (!task) throw new KanbanError("not-found", "no such task");
    return task;
  }

  private requireLease(task: KanbanTask, leaseId: string): void {
    if (!task.lease || task.lease.leaseId !== leaseId) throw new KanbanError("forbidden", "this executor does not hold the task");
    if (!leaseLive(task.lease, this.now())) throw new KanbanError("conflict", "the lease expired");
  }

  private expectRevision(task: KanbanTask, expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) {
      throw new KanbanError("stale", `the task changed (revision ${task.revision}); read it again`);
    }
  }

  private replaceTask(next: KanbanTask): void {
    const state = this.load();
    const index = state.tasks.findIndex((task) => task.boardId === next.boardId && task.taskId === next.taskId);
    if (index < 0) throw new KanbanError("not-found", "no such task");
    state.tasks[index] = next;
    this.persist(state);
  }

  private load(): z.infer<typeof fileSchema> {
    if (this.state) return this.state;
    if (!existsSync(this.file)) {
      this.state = { schemaVersion: 1, boards: [], tasks: [] };
      return this.state;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new KanbanError("corrupt", "tasks/kanban.json is not valid JSON");
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) throw new KanbanError("corrupt", "tasks/kanban.json does not match schema version 1");
    this.state = parsed.data;
    return this.state;
  }

  private persist(state: z.infer<typeof fileSchema>): void {
    if (state.tasks.length > MAX_TASKS) throw new KanbanError("conflict", "the board store is full; archive or remove tasks first");
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    this.state = state;
  }
}
