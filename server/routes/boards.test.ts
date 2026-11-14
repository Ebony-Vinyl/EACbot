import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { KanbanStore } from "../plugins/kanban.ts";
import { createBoardRoutes } from "./boards.ts";
import { dispatchRoutes } from "./table.ts";

const owner = { kind: "session", session: { id: "s1" }, via: "bearer", scopes: ["admin", "client"] } as unknown as RequestAuth;
const client = { ...owner, scopes: ["client"] } as unknown as RequestAuth;
const folders: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function serve() {
  const folder = mkdtempSync(join(tmpdir(), "eac-board-routes-"));
  folders.push(folder);
  const boards = new KanbanStore(folder);
  const accounts = new Map<string, string>();
  const route = createBoardRoutes({ boards, accountForBot: (botId) => accounts.get(botId), mayManage: (auth) => auth.kind === "loopback" || auth.scopes.includes("admin") });
  let auth = owner;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "next route" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, accounts, setAuth: (next: RequestAuth) => { auth = next; } };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("/api/boards", () => {
  it("is owner/admin only", async () => {
    const { base, setAuth } = await serve();
    setAuth(client);
    expect((await call(base, "GET", "/api/boards")).status).toBe(403);
  });

  it("creates a board and task, moves it and reports a stale revision", async () => {
    const { base } = await serve();
    const board = await call(base, "POST", "/api/boards", { name: "Work" });
    expect(board.status).toBe(200);
    const boardId = (board.body.board as { boardId: string }).boardId;
    const task = await call(base, "POST", `/api/boards/${boardId}/tasks`, { title: "Ship M6" });
    expect(task.body.task).toMatchObject({ column: "backlog", revision: 1 });
    const taskId = (task.body.task as { taskId: string }).taskId;
    expect((await call(base, "PATCH", `/api/boards/${boardId}/tasks/${taskId}`, { revision: 1, column: "ready" })).body.task)
      .toMatchObject({ column: "ready", revision: 2 });
    expect((await call(base, "PATCH", `/api/boards/${boardId}/tasks/${taskId}`, { revision: 1, column: "doing" })).status).toBe(409);
    expect((await call(base, "GET", `/api/boards/${boardId}`)).body.tasks).toHaveLength(1);
  });

  it("lets only the lease holder run and finish, and refuses done before success", async () => {
    const { base } = await serve();
    const boardId = ((await call(base, "POST", "/api/boards", { name: "Work" })).body.board as { boardId: string }).boardId;
    const taskId = ((await call(base, "POST", `/api/boards/${boardId}/tasks`, { title: "Ship" })).body.task as { taskId: string }).taskId;
    const claimed = await call(base, "POST", `/api/boards/${boardId}/tasks/${taskId}/claim`, { revision: 1, holderId: "worker-a" });
    const leaseId = (claimed.body.task as { lease: { leaseId: string } }).lease.leaseId;
    expect((await call(base, "POST", `/api/boards/${boardId}/tasks/${taskId}/run`, { leaseId, executorId: "worker-b" })).status).toBe(403);
    const running = await call(base, "POST", `/api/boards/${boardId}/tasks/${taskId}/run`, { leaseId, executorId: "worker-a" });
    const runId = (running.body.task as { run: { runId: string } }).run.runId;
    expect((await call(base, "PATCH", `/api/boards/${boardId}/tasks/${taskId}`, { revision: 3, column: "done" })).status).toBe(403);
    expect((await call(base, "POST", `/api/boards/${boardId}/tasks/${taskId}/run/${runId}`, { executorId: "worker-a", status: "succeeded" })).body.task)
      .toMatchObject({ run: { status: "succeeded" } });
    expect((await call(base, "PATCH", `/api/boards/${boardId}/tasks/${taskId}`, { revision: 4, column: "done" })).body.task)
      .toMatchObject({ column: "done" });
  });

  it("leaves other API paths to the next route", async () => {
    const { base } = await serve();
    expect(await (await fetch(`${base}/api/not-boards`)).json()).toEqual({ from: "next route" });
  });
});

it("derives task accounts from the assigned bot and filters each account without trusting a submitted account id", async () => {
  const { base, accounts } = await serve();
  const accountA = "00000000-0000-4000-a000-000000000001";
  const accountB = "00000000-0000-4000-a000-000000000002";
  accounts.set("bot-a", accountA); accounts.set("bot-b", accountB);
  const boardId = ((await call(base, "POST", "/api/boards", { name: "Accounts" })).body.board as { boardId: string }).boardId;
  const path = `/api/boards/${boardId}/tasks`;
  const first = (await call(base, "POST", path, { title: "A", assigneeBotId: "bot-a", accountId: accountB })).body.task as { taskId: string; revision: number; accountId: string };
  await call(base, "POST", path, { title: "B", assigneeBotId: "bot-b" });
  expect(first.accountId).toBe(accountA);
  expect((await call(base, "GET", `/api/boards/${boardId}?accountId=${accountA}`)).body.tasks).toHaveLength(1);
  expect((await call(base, "GET", `/api/boards/tasks?accountId=${accountB}`)).body.tasks).toHaveLength(1);
  expect((await call(base, "PATCH", path + "/" + first.taskId, { revision: first.revision, assigneeBotId: null })).body.task).not.toHaveProperty("accountId");
});
