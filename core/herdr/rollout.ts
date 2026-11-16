import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

/** Read the native Codex JSONL transcript within its configured home. */
export async function readRollout(home: string, path: string, threadId: string): Promise<Record<string, unknown>[]> {
  const [root, file] = await Promise.all([realpath(home), realpath(path)]);
  const within = relative(root, file);
  if (within === ".." || within.startsWith("../") || isAbsolute(within)) throw new Error("Codex 会话记录超出了它的配置目录");
  return rolloutTurns(await readFile(file, "utf8"), threadId);
}

export function rolloutTurns(text: string, threadId: string): Record<string, unknown>[] {
  const lines = text.split("\n");
  lines.pop();
  const records = lines.filter(Boolean).map(line => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  const header = records[0];
  if (header?.type !== "session_meta" || header.payload.id !== threadId) throw new Error("Codex 会话记录的 ID 不匹配");
  const turns: { id: string; status: string; items: Record<string, unknown>[] }[] = [];
  let turn: typeof turns[number] | undefined;
  const calls = new Map<string, Record<string, unknown>>();
  for (const [index, record] of records.entries()) {
    const item = record.payload;
    if (record.type === "event_msg" && item.type === "task_started") {
      if (typeof item.turn_id !== "string") throw new Error("Codex 回合记录缺少 ID");
      turn = { id: item.turn_id, status: "inProgress", items: [] }; turns.push(turn); calls.clear();
    }
    if (!turn) continue;
    if (record.type === "event_msg") {
      if (item.type === "user_message" && typeof item.message === "string") turn.items.push({ id: `rollout-${index}`, type: "userMessage", content: [{ text: item.message }] });
      if (item.type === "item_completed" && item.item && typeof item.item === "object") {
        const completed = item.item as Record<string, unknown>;
        if (completed.type === "UserMessage" && Array.isArray(completed.content)) {
          const text = completed.content.map(part => typeof part.text === "string" ? part.text : "[附件]").join("\n");
          turn.items.push({ id: String(completed.id), type: "userMessage", content: [{ text }] });
        }
      }
      if (item.type === "task_complete") turn.status = "completed";
      if (item.type === "turn_aborted") turn.status = "interrupted";
    }
    if (record.type !== "response_item") continue;
    if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
      const text = item.content.map(part => typeof part.text === "string" ? part.text : "").join("\n");
      turn.items.push({ id: `rollout-${index}`, type: "agentMessage", text });
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const call = { id: `rollout-${index}`, type: "commandExecution", command: item.name, input: item.arguments ?? item.input ?? "", aggregatedOutput: "" };
      turn.items.push(call);
      if (typeof item.call_id === "string") calls.set(item.call_id, call);
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
      const call = typeof item.call_id === "string" ? calls.get(item.call_id) : undefined;
      if (call) { call.aggregatedOutput = output; call.output = output; }
      else turn.items.push({ id: `rollout-${index}`, type: "commandExecution", command: "工具输出", input: "", aggregatedOutput: output, output });
    }
  }
  return turns;
}
