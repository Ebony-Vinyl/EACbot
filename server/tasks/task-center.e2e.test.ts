import { DatabaseSync, backup } from "node:sqlite";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  launchVerificationServer,
  verificationServerEnvironment,
  type VerificationServer,
} from "../../scripts/control-omb.ts";
import type { KanbanTask } from "../../shared/plugins/tasks.ts";
import { freePortBlock } from "../testing/ports.ts";
import { waitForExit } from "../testing/cleanup.ts";

let fixture: VerificationServer | undefined;
let restored: ChildProcess | undefined;
let restoredDir: string | undefined;
let base: string;
beforeAll(async () => {
  fixture = await launchVerificationServer();
  base = fixture.info.url;
}, 60_000);
afterAll(async () => {
  if (fixture) await fixture.close();
  if (restored) {
    restored.kill("SIGTERM");
    await waitForExit(restored);
  }
  if (restoredDir) rmSync(restoredDir, { recursive: true, force: true });
}, 30_000);

async function request<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

it("runs a board task through the normal executor, exports attributable usage and restores persisted results in a fresh backend", async () => {
  const bots = await request<{ bots: { id: string }[] }>("/api/bots");
  const botId = bots.body.bots[0].id as string;
  const boardId = (
    await request<{ board: { boardId: string } }>("/api/boards", "POST", {
      name: "Acceptance",
    })
  ).body.board.boardId as string;
  const path = `/api/boards/${boardId}/tasks`;
  const initial: KanbanTask = (
    await request<{ task: KanbanTask }>(path, "POST", {
      title: "M6 acceptance",
      description: "Give a short report",
      assigneeBotId: botId,
    })
  ).body.task;
  const taskPath = path + "/" + initial.taskId;
  expect(
    (
      await request(taskPath + "/run", "POST", {
        leaseId: "forged",
        executorId: "person",
      })
    ).status,
  ).toBe(403);
  const execution = await request<{ task: KanbanTask }>(
    taskPath + "/execute",
    "POST",
    {
      revision: initial.revision,
    },
  );
  expect(execution.status).toBe(200);
  expect(
    (
      await request<{ task: KanbanTask }>(taskPath + "/execute", "POST", {
        revision: initial.revision,
      })
    ).status,
  ).toBe(409);
  let task: KanbanTask = execution.body.task;
  for (
    let attempt = 0;
    attempt < 100 && task.run?.status !== "succeeded";
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    task = (await request<{ tasks: KanbanTask[] }>(`/api/boards/${boardId}`))
      .body.tasks[0];
  }
  expect(task.column).toBe("review");
  expect(task.artifacts?.[0]?.text).toBeTruthy();
  const metering = await request<{ total: number; groups: { key: string }[] }>(
    `/api/usage/metering?groupBy=task&taskId=${initial.taskId}`,
  );
  expect(metering.status).toBe(200);
  expect(metering.body.total).toBe(1);
  expect(metering.body.groups[0].key).toBe(initial.taskId);
  const csv = await (
    await fetch(base + `/api/usage/metering.csv?taskId=${initial.taskId}`)
  ).text();
  expect(csv).toContain(initial.taskId);
  expect(csv).not.toContain("Give a short report");
  expect(
    (
      await request<{ task: KanbanTask }>(taskPath + "/schedule", "POST", {
        revision: task.revision,
        schedule: {
          type: "cron",
          expression: "0 9 * * *",
          timeZone: "invalid",
        },
      })
    ).status,
  ).toBe(400);
  const scheduled = await request<{ task: KanbanTask }>(
    taskPath + "/schedule",
    "POST",
    {
      revision: task.revision,
      schedule: {
        type: "cron",
        expression: "0 9 * * *",
        timeZone: "Asia/Shanghai",
      },
    },
  );
  expect(scheduled.status).toBe(200);
  const cancelled = await request<{ task: KanbanTask }>(
    taskPath + "/cancel",
    "POST",
    {
      revision: scheduled.body.task.revision,
    },
  );
  expect(cancelled.body.task).toMatchObject({
    column: "todo",
    scheduleEnabled: false,
  });

  const pairing = (
    await request<{ code: string }>("/api/auth/pairing", "POST", {
      scopes: ["client"],
    })
  ).body;
  const paired = (
    await request<{ token: string }>("/api/auth/pair", "POST", {
      code: pairing.code,
      label: "Client",
    })
  ).body;
  const denied = await fetch(base + "/api/boards/tasks", {
    headers: { authorization: `Bearer ${paired.token}` },
  });
  expect(denied.status).toBe(403);

  restoredDir = mkdtempSync(join(tmpdir(), "eac-m6-restore-"));
  const source = fixture!.info.dataDir;
  cpSync(source, restoredDir, {
    recursive: true,
    filter: (file) =>
      !file.endsWith(".lease") &&
      !lstatSync(file).isSocket() &&
      !/\.db(?:-wal|-shm)?$/.test(file),
  });
  for (const name of ["messages.db", "runtime.db"]) {
    const db = new DatabaseSync(join(source, name), { readOnly: true });
    try {
      await backup(db, join(restoredDir, name));
    } finally {
      db.close();
    }
  }
  const configPath = join(restoredDir, "config.json");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replaceAll(source, restoredDir),
  );
  await fixture!.close();
  fixture = undefined;
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  restored = spawn(
    process.execPath,
    ["--experimental-strip-types", "server/index.ts"],
    {
      env: verificationServerEnvironment({}, restoredDir, port),
      stdio: "ignore",
    },
  );
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    ready = await fetch(base + "/api/bots").then(
      (response) => response.ok,
      () => false,
    );
  }
  expect(ready).toBe(true);
  const recovered = (
    await request<{ tasks: KanbanTask[] }>(`/api/boards/${boardId}`)
  ).body.tasks[0];
  expect(recovered).toMatchObject({
    taskId: initial.taskId,
    column: "todo",
    run: { status: "succeeded" },
    scheduleEnabled: false,
  });
  expect(recovered.artifacts).toHaveLength(1);
  expect(
    (
      await request<{ total: number }>(
        `/api/usage/metering?taskId=${initial.taskId}`,
      )
    ).body.total,
  ).toBe(1);
}, 60_000);
