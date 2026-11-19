import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HerdrSessions } from "../herdr/sessions.ts";
import { registerHerdrRoutes } from "../herdr/routes.ts";
import { Router } from "../http/router.ts";
import type { TerminalService, StartTerminalInput } from "../terminal/service.ts";
import type { EnvironmentRecord } from "../environments/types.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
it("starts a native CLI without an app server, forwards input to it and preserves its binding after restart", async () => {
  const directory = mkdtempSync("/tmp/eac-herdr-native-"); directories.push(directory);
  const terminals = { nativeAddress: () => "t7", start: vi.fn(async (_input: StartTerminalInput) => ({ id: "terminal-1" })), send: vi.fn(async () => ({ turn: 1 })), interrupt: vi.fn(), inspect: vi.fn(async () => ({ state: "live", pid: null, labels: {} })), kill: vi.fn(), get: vi.fn(() => ({ id: "terminal-1" })) };
  const local = { id: "local", capabilities: { homeDir: directory }, tools: [{ name: "codex", status: "installed" }] } as EnvironmentRecord;
  let sessions = new HerdrSessions(terminals as unknown as TerminalService, local, directory);
  const session = await sessions.create({ project: directory, tool: "codex", title: "原生会话" });
  expect(session.nativeAddress).toBe("t7");
  expect(terminals.start).toHaveBeenCalledTimes(1);
  expect(terminals.start.mock.calls[0]?.[0]).toMatchObject({ cwd: realpathSync(directory), tool: "codex" });
  expect(terminals.start.mock.calls[0]?.[0]).not.toHaveProperty("args");
  await sessions.send(session.id, "你好\n继续工作");
  expect(terminals.send).toHaveBeenCalledWith(session.terminalId, "你好\n继续工作");
  sessions = new HerdrSessions(terminals as unknown as TerminalService, local, directory);
  expect(sessions.list()).toEqual([session]);
  expect((await sessions.conversation(session.id)).notice).toContain("等待原生会话记录");
  expect(terminals.start).toHaveBeenCalledTimes(1);
  await expect(sessions.image(session.id, "unrelated-message", 0)).rejects.toThrow("找不到这条原生回复");
  await sessions.interrupt(session.id); expect(terminals.interrupt).toHaveBeenCalledWith(session.terminalId);
  await sessions.end(session.id); expect(terminals.kill).toHaveBeenCalledWith(session.terminalId);
  expect(sessions.list()[0]?.endedAt).toBeTruthy();
});
it("preserves old RPC records without silently restarting or replacing their native history", async () => {
  const directory = mkdtempSync("/tmp/eac-herdr-old-"); directories.push(directory);
  const saved = [{ id: "old", title: "旧会话", project: directory, tool: "codex", terminalId: "old-terminal", createdAt: "2026-11-16", conversation: true, socket: "/tmp/old/rpc.sock", threadId: "original-thread" }];
  writeFileSync(join(directory, "herdr-sessions.json"), JSON.stringify(saved));
  const sessions = new HerdrSessions({} as TerminalService, { capabilities: { homeDir: directory } } as EnvironmentRecord, directory);
  expect(sessions.list()[0]?.conversation).toBe(false);
  await expect(sessions.send("old", "hi")).rejects.toThrow("旧会话");
});
it("requires device authentication for terminal input and lifecycle operations", () => {
  const router = new Router(); registerHerdrRoutes(router, {} as HerdrSessions);
  for (const path of ["/api/v1/herdr/sessions", "/api/v1/herdr/sessions/one/messages", "/api/v1/herdr/sessions/one/end", "/api/v1/herdr/sessions/one/interrupt"]) {
    const found = router.match("POST", path);
    expect(found && typeof found === "object" && found.route.scope).toBe("device");
  }
});
