import { expect, it } from "vitest";

it("reads real rollout messages without treating injected instructions as user messages", async () => {
  const { rolloutTurns } = await import("../herdr/rollout.ts");
  const records = [
    { type: "session_meta", payload: { id: "fixture-thread" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "injected project instructions" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "hello" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
  const text = records.map(record => JSON.stringify(record)).join("\n") + '\n{"partial":';
  const turns = rolloutTurns(text, "fixture-thread");
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ id: "turn-1", status: "completed", items: [{ type: "userMessage", content: [{ text: "hello" }] }, { type: "agentMessage", text: "reply" }] });
  expect(() => rolloutTurns(text, "another-thread")).toThrow("ID 不匹配");
});

it("reads native TUI UserMessage completion events and ignores environment injection", async () => {
  const { rolloutTurns } = await import("../herdr/rollout.ts");
  const records = [
    { type: "session_meta", payload: { id: "native" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "environment injection" }] } },
    { type: "turn_context", payload: {} },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "real message" }] } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "user-1", content: [{ type: "text", text: "real message" }] } } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
  const turns = rolloutTurns(records.map(record => JSON.stringify(record)).join("\n") + "\n", "native");
  expect(turns[0]?.items).toEqual([{ id: "user-1", type: "userMessage", content: [{ text: "real message" }] }]);
});

it("finds an idle terminal's exact labelled session without an open rollout file", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { findCodexTranscript } = await import("../herdr/transcript.ts");
  const home = await mkdtemp("/tmp/eac-herdr-labelled-");
  const id = "01a1e385-b704-7f11-a241-47161ec1edf8";
  try {
    const directory = join(home, "sessions", "2026", "11", "16");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-2026-11-16-${id}.jsonl`);
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n");
    await writeFile(join(directory, "rollout-newer-other.jsonl"), "unrelated session");
    expect(await findCodexTranscript(null, home, `codex:id:${id}`)).toEqual({ path, threadId: id });
    expect(await findCodexTranscript(null, home, "codex:id:*")).toBeUndefined();
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: "wrong-session" } }) + "\n");
    await expect(findCodexTranscript(null, home, `codex:id:${id}`)).rejects.toThrow("ID 不匹配");
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("pairs tool results by call id, including out-of-order completions", async () => {
  const { rolloutTurns } = await import("../herdr/rollout.ts");
  const records = [
    { type: "session_meta", payload: { id: "paired" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
    { type: "response_item", payload: { type: "function_call", call_id: "a", name: "exec", arguments: '{"cmd":"cat README.md"}' } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "b", name: "search", input: "needle" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "b", output: "second result" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "a", output: "first result" } },
  ];
  const turns = rolloutTurns(records.map(record => JSON.stringify(record)).join("\n") + "\n", "paired");
  expect(turns[0]?.items).toMatchObject([{ command: "exec", output: "first result" }, { command: "search", output: "second result" }]);
  expect(turns[0]?.items).toHaveLength(2);
});
