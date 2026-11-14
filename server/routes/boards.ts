import { z } from "zod";
import type { TaskRuntime } from "../tasks/runtime.ts";
import { RoutineScheduleError, type RoutineInput } from "../routines.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { KanbanError, type KanbanStore } from "../plugins/kanban.ts";
import type { KanbanColumn, RunStatus } from "../../shared/plugins/tasks.ts";

export interface BoardRouteDeps {
  boards: KanbanStore;
  execution?: TaskRuntime;
  accountForBot?(botId: string): string | undefined;
  mayManage(auth: RequestAuth): boolean;
}

const STATUS: Readonly<Record<KanbanError["code"], number>> = {
  invalid: 400,
  "not-found": 404,
  conflict: 409,
  stale: 409,
  forbidden: 403,
  corrupt: 500,
};

const COLUMNS = new Set<string>(["backlog", "todo", "scheduled", "ready", "doing", "blocked", "review", "done"]);
const metadata = z.object({ priority: z.enum(["low", "normal", "high"]).optional(), source: z.string().trim().max(120).optional() });
const operation = z.object({ revision: z.number().int().positive() });
const FINAL = new Set<string>(["succeeded", "failed", "cancelled"]);

/** Kanban boards and tasks. A run is started and finished only by the executor that holds the task's lease. */
export function createBoardRoutes(deps: BoardRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody, url }) => {
    if (path !== "/api/boards" && !path.startsWith("/api/boards/")) return PASS;
    if (!deps.mayManage(auth)) return json(res, 403, { error: "Only an owner or administrator can manage boards." });
    res.setHeader("Cache-Control", "no-store");

    try {
      if (method === "GET" && path === "/api/boards") return json(res, 200, { boards: deps.boards.boards() });

      if (method === "POST" && path === "/api/boards") {
        const body = await readBody(req, 8_192);
        if (typeof body?.name !== "string" || !body.name.trim()) return json(res, 400, { error: "name is required.", code: "invalid" });
        return json(res, 200, { board: deps.boards.createBoard({ name: body.name }) });
      }

      if (method === "GET" && path === "/api/boards/tasks") {
        deps.execution?.reconcile();
        const botId = url.searchParams.get("botId");
        return json(res, 200, { tasks: deps.boards.allTasks().filter((task) => (!botId || task.assigneeBotId === botId) && (!url.searchParams.has("accountId") || task.accountId === url.searchParams.get("accountId"))).map((task) => deps.execution?.details(task) ?? task) });
      }
      const boardOne = /^\/api\/boards\/([0-9a-f-]{36})$/.exec(path);
      if (method === "GET" && boardOne) {
        deps.execution?.reconcile();
        return json(res, 200, { tasks: deps.boards.tasks(boardOne[1]!).filter((task) => !url.searchParams.has("accountId") || task.accountId === url.searchParams.get("accountId")).map((task) => deps.execution?.details(task) ?? task) });
      }

      const tasksPath = /^\/api\/boards\/([0-9a-f-]{36})\/tasks$/.exec(path);
      if (method === "POST" && tasksPath) {
        const body = await readBody(req, 32_768);
        if (typeof body?.title !== "string" || !body.title.trim()) return json(res, 400, { error: "title is required.", code: "invalid" });
        if (body.column !== undefined && !COLUMNS.has(String(body.column))) {
          return json(res, 400, { error: "unknown column", code: "invalid" });
        }
        return json(res, 200, {
          task: deps.boards.createTask(tasksPath[1]!, {
            ...metadata.parse(body),
            ...(typeof body.assigneeBotId === "string" ? { accountId: deps.accountForBot?.(body.assigneeBotId) } : {}),
            title: body.title,
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(typeof body.column === "string" ? { column: body.column as KanbanColumn } : {}),
            ...(typeof body.assigneeBotId === "string" ? { assigneeBotId: body.assigneeBotId } : {}),
            ...(Array.isArray(body.dependsOn) ? { dependsOn: body.dependsOn.filter((item: unknown): item is string => typeof item === "string") } : {}),
          }),
        });
      }

      const taskOne = /^\/api\/boards\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})$/.exec(path);
      if (method === "PATCH" && taskOne) {
        const body = await readBody(req, 32_768);
        if (typeof body?.revision !== "number") return json(res, 400, { error: "revision is required.", code: "invalid" });
        if (body.column !== undefined && !COLUMNS.has(String(body.column))) {
          return json(res, 400, { error: "unknown column", code: "invalid" });
        }
        return json(res, 200, {
          task: (deps.execution ? deps.execution.patch.bind(deps.execution) : deps.boards.patchTask.bind(deps.boards))(taskOne[1]!, taskOne[2]!, body.revision, {
            ...metadata.parse(body),
            ...(body.assigneeBotId !== undefined ? { accountId: typeof body.assigneeBotId === "string" ? deps.accountForBot?.(body.assigneeBotId) ?? null : null } : {}),
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(typeof body.column === "string" ? { column: body.column as KanbanColumn } : {}),
            ...(body.assigneeBotId === null || typeof body.assigneeBotId === "string" ? { assigneeBotId: body.assigneeBotId } : {}),
            ...(Array.isArray(body.dependsOn) ? { dependsOn: body.dependsOn.filter((item: unknown): item is string => typeof item === "string") } : {}),
          }),
        });
      }

      const action = /^\/api\/boards\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/(execute|schedule|cancel|notes|archive)$/.exec(path);
      if (method === "POST" && action) {
        const body = await readBody(req, 40_000);
        const { revision } = operation.parse(body);
        const [, boardId, taskId, verb] = action;
        if (verb === "notes") {
          const note = z.object({ text: z.string().trim().min(1).max(4000), kind: z.enum(["comment", "artifact"]) }).parse(body);
          return json(res, 200, { task: deps.boards.addNote(boardId!, taskId!, revision, note.text, note.kind) });
        }
        if (!deps.execution) return json(res, 503, { error: "Task execution is unavailable." });
        let task;
        if (verb === "execute") task = deps.execution.execute(boardId!, taskId!, revision);
        else if (verb === "schedule") {
          const schedule = z.object({ schedule: z.object({ type: z.enum(["once", "daily", "interval", "cron"]) }).passthrough() }).parse(body).schedule;
          task = deps.execution.schedule(boardId!, taskId!, revision, schedule as RoutineInput["schedule"]);
        } else if (verb === "cancel") task = await deps.execution.cancel(boardId!, taskId!, revision);
        else {
          const { archived } = z.object({ archived: z.boolean() }).parse(body);
          const current = deps.boards.task(boardId!, taskId!);
          if (current.revision !== revision) throw new KanbanError("stale", "the task changed; read it again");
          if (archived) await deps.execution.cancel(boardId!, taskId!, revision);
          task = deps.boards.archive(boardId!, taskId!, deps.boards.task(boardId!, taskId!).revision, archived);
        }
        return json(res, 200, { task: deps.execution.details(task) });
      }

      if (deps.execution && /\/(claim|heartbeat|run)(\/|$)/.test(path)) return json(res, 403, { error: "The server executor owns run state. Use execute or cancel.", code: "forbidden" });
      const claim = /^\/api\/boards\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/claim$/.exec(path);
      if (method === "POST" && claim) {
        const body = await readBody(req, 8_192);
        if (typeof body?.revision !== "number" || typeof body?.holderId !== "string") {
          return json(res, 400, { error: "revision and holderId are required.", code: "invalid" });
        }
        return json(res, 200, { task: deps.boards.claim(claim[1]!, claim[2]!, body.revision, body.holderId) });
      }

      const heartbeat = /^\/api\/boards\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/heartbeat$/.exec(path);
      if (method === "POST" && heartbeat) {
        const body = await readBody(req, 8_192);
        if (typeof body?.leaseId !== "string") return json(res, 400, { error: "leaseId is required.", code: "invalid" });
        return json(res, 200, { task: deps.boards.heartbeat(heartbeat[1]!, heartbeat[2]!, body.leaseId) });
      }

      const start = /^\/api\/boards\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/run$/.exec(path);
      if (method === "POST" && start) {
        const body = await readBody(req, 8_192);
        if (typeof body?.leaseId !== "string" || typeof body?.executorId !== "string") {
          return json(res, 400, { error: "leaseId and executorId are required.", code: "invalid" });
        }
        return json(res, 200, { task: deps.boards.startRun(start[1]!, start[2]!, body.leaseId, body.executorId) });
      }

      const finish = /^\/api\/boards\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})\/run\/([0-9a-f-]{36})$/.exec(path);
      if (method === "POST" && finish) {
        const body = await readBody(req, 8_192);
        if (typeof body?.executorId !== "string" || typeof body?.status !== "string" || !FINAL.has(body.status)) {
          return json(res, 400, { error: "executorId and a final status are required.", code: "invalid" });
        }
        return json(res, 200, {
          task: deps.boards.finishRun(
            finish[1]!, finish[2]!, finish[3]!, body.executorId,
            body.status as Exclude<RunStatus, "queued" | "running" | "waiting">,
            typeof body.error === "string" ? body.error : undefined,
          ),
        });
      }

      return json(res, 405, { error: "unsupported board route", code: "method-not-allowed" });
    } catch (error) {
      if (error instanceof RoutineScheduleError) return json(res, 400, { error: error.message, code: "invalid" });
      if (error instanceof z.ZodError) return json(res, 400, { error: error.issues[0]!.message, code: "invalid" });
      if (error instanceof KanbanError) return json(res, STATUS[error.code], { error: error.message, code: error.code });
      return json(res, 500, { error: "board operation failed", code: "internal" });
    }
  };
}
