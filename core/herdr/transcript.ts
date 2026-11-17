import { execFile } from "node:child_process";
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrMessage } from "../../packages/agent-protocol/herdr.ts";
import { readRollout } from "./rollout.ts";

/** Resolve an exact native session label or files held by the terminal process tree, never the newest file in a shared cwd. */
export async function findCodexTranscript(pid: number | null | undefined, home: string, sessionLabel?: string): Promise<{ path: string; threadId: string } | undefined> {
  const labelledId = /^codex:id:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(sessionLabel ?? "")?.[1];
  if (labelledId) {
    const matches: string[] = [];
    for await (const file of glob(`sessions/**/rollout-*-${labelledId}.jsonl`, { cwd: home })) matches.push(join(home, file));
    if (matches.length > 1) throw new Error("原生会话 ID 对应多份记录，无法确定当前对话");
    if (matches[0]) {
      await readRollout(home, matches[0], labelledId);
      return { path: matches[0], threadId: labelledId };
    }
    return undefined;
  }
  if (!pid) return undefined;
  const processes = (await run("/bin/ps", ["-axo", "pid=,ppid="])).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([pid]);
  let size = 0;
  while (size !== pids.size) {
    size = pids.size;
    for (const [child, parent] of processes) if (parent !== undefined && pids.has(parent) && child !== undefined) pids.add(child);
  }
  const files = await run(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", ["-n", "-P", "-p", [...pids].join(","), "-Fn"]);
  const paths = [...new Set(files.split("\n").filter(line => /^n.*\/rollout-.*\.jsonl$/.test(line)).map(line => line.slice(1)))];
  if (paths.length > 1) throw new Error("终端进程关联了多份会话记录，无法确定当前对话");
  if (!paths[0]) return undefined;
  const header = JSON.parse((await readFile(paths[0], "utf8")).split("\n")[0]!);
  if (header.type !== "session_meta" || typeof header.payload?.id !== "string") throw new Error("Codex 会话记录缺少原生 ID");
  return { path: paths[0], threadId: header.payload.id };
}

function run(program: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(program, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    // lsof returns 1 when no files match a process that already exited.
    if (error && !(program.endsWith("lsof") && error.code === 1)) reject(error);
    else resolve(stdout);
  }));
}

export async function codexMessages(home: string, path: string, threadId: string): Promise<HerdrMessage[]> {
  const messages: HerdrMessage[] = [];
  for (const turn of await readRollout(home, path, threadId)) for (const raw of turn.items as Record<string, unknown>[]) {
    const id = String(raw.id);
    if (raw.type === "userMessage") messages.push({ id, role: "user", text: (raw.content as { text: string }[]).map(item => item.text).join("\n") });
    if (raw.type === "agentMessage") messages.push({ id, role: "assistant", text: String(raw.text) });
    if (raw.type === "commandExecution") messages.push({ id, role: "tool", text: `${raw.command}\n${raw.input}\n${raw.aggregatedOutput}`, tool: { name: String(raw.command), input: String(raw.input), ...(typeof raw.output === "string" ? { output: raw.output } : {}) } });
  }
  return messages;
}
