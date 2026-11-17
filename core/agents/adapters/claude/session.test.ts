import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./session.ts";
import { claudeArgs, controlRequest, initSessionId, resultUsage, streamEventDelta, userFrame } from "./codec.ts";
import { collectUntil, fakeSpawn, type FakeChild } from "../../testing/fake-child.ts";

const HOME = "/tmp/fixture-claude-home";

function adapter(fake: ReturnType<typeof fakeSpawn>): ClaudeAdapter {
  return new ClaudeAdapter({ spawn: fake.spawn, home: HOME });
}

function init(child: FakeChild, sessionId = "native-session-1"): void {
  child.send({ type: "system", subtype: "init", session_id: sessionId, model: "claude" });
}

describe("Claude stream-json codec", () => {
  it("builds the argv with stream-json in and out, keeping stdin open for steers", () => {
    expect(claudeArgs({ permissionMode: "default" })).toEqual([
      "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
      "--include-partial-messages", "--permission-mode", "default",
    ]);
    expect(claudeArgs({ permissionMode: "default", resume: "abc" })).toContain("--resume");
    expect(claudeArgs({ permissionMode: "default", model: "claude-sonnet" })).toContain("--model");
  });

  it("wraps an image as base64 content and keeps the text beside it", () => {
    const frame = userFrame("look", [{ mime: "image/png", base64: "AAAA" }]);
    expect(frame.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "look" },
    ]);
  });

  it("reads text and thinking deltas from the CLI's own stream_event", () => {
    expect(streamEventDelta({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } }))
      .toEqual({ kind: "text", text: "hi" });
    expect(streamEventDelta({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } }))
      .toEqual({ kind: "reasoning", text: "hmm" });
    expect(streamEventDelta({ type: "assistant" })).toBeNull();
  });

  it("reads the native session id only from an init frame", () => {
    expect(initSessionId({ type: "system", subtype: "init", session_id: "s" })).toBe("s");
    expect(initSessionId({ type: "system", subtype: "other", session_id: "s" })).toBeNull();
  });

  it("counts cached prompt tokens inside input, as the other adapters do", () => {
    expect(resultUsage({ type: "result", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 } }))
      .toEqual({ input: 15, output: 2, cachedInput: 5 });
    expect(resultUsage({ type: "result" })).toBeNull();
  });

  it("recognises a control request and names its kind", () => {
    expect(controlRequest({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash" } }))
      .toMatchObject({ requestId: "r1", kind: "question", title: "Bash" });
    expect(controlRequest({ type: "control_request", request_id: "r2", request: { subtype: "elicitation", mcp_server_name: "notes" } }))
      .toMatchObject({ requestId: "r2", kind: "permission", title: "notes" });
    expect(controlRequest({ type: "control_request", request: {} })).toBeNull();
  });
});

describe("Claude adapter", () => {
  it("launches with the instance home and the prompt on stdin, never on argv", async () => {
    const fake = fakeSpawn();
    const session = await adapter(fake).create({ sessionId: "conv-1", prompt: "a secret prompt" });
    const call = fake.calls[0]!;
    expect(call.command).toBe("claude");
    expect(call.options.env.HOME).toBe(HOME);
    expect(call.args.join(" ")).not.toContain("a secret prompt");
    expect(fake.children[0]!.framesOfType("user")).toHaveLength(1);
    await session.close();
  });

  it("streams deltas and completes on the result frame with usage", async () => {
    const fake = fakeSpawn();
    const session = await adapter(fake).create({ sessionId: "conv-2", prompt: "hi" });
    const child = fake.children[0]!;
    init(child);
    child.send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "answer" } } });
    child.send({ type: "result", subtype: "success", usage: { input_tokens: 4, output_tokens: 2 } });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "session.started", nativeSessionId: "native-session-1" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "text.delta", text: "answer" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "usage.updated", input: 4, output: 2 }));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true }));
  });

  it("takes the resume cursor from the caller and does not announce a new session", async () => {
    const fake = fakeSpawn();
    const session = await adapter(fake).create({ sessionId: "conv-3", prompt: "hi", resumeCursor: "prior-native" });
    expect(fake.calls[0]!.args).toEqual(expect.arrayContaining(["--resume", "prior-native"]));
    const child = fake.children[0]!;
    init(child, "prior-native");
    child.send({ type: "result", subtype: "success" });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events.some((event) => event.type === "session.started")).toBe(false);
    expect(session.nativeSessionId).toBe("prior-native");
  });

  it("steers through stdin with a fresh uuid and refuses once the turn ended", async () => {
    const fake = fakeSpawn();
    const session = await adapter(fake).create({ sessionId: "conv-4", prompt: "hi" });
    const child = fake.children[0]!;
    expect(await session.steer("more")).toBe("steered");
    const steerFrames = child.framesOfType("user");
    expect(steerFrames).toHaveLength(2);
    expect(steerFrames[1]!.uuid).toEqual(expect.any(String));

    child.send({ type: "result", subtype: "success" });
    await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(await session.steer("late")).toBe("refused");
  });

  it("raises a permission control request and answers it with a control_response", async () => {
    const fake = fakeSpawn();
    const session = await adapter(fake).create({ sessionId: "conv-5", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({
      type: "control_request",
      request_id: "perm-1",
      request: { subtype: "can_use_tool", tool_name: "Bash", prompt: "run rm -rf?" },
    });
    const events = await collectUntil(session.events(), (event) => event.type === "question.requested");
    expect(events).toContainEqual(expect.objectContaining({ type: "question.requested", requestId: "perm-1" }));

    expect(await session.respondApproval("perm-1", { behavior: "allow" })).toBe("allowed-once");
    const response = child.framesOfType("control_response")[0] as { response: { request_id: string; response: { behavior: string } } };
    expect(response.response.request_id).toBe("perm-1");
    expect(response.response.response.behavior).toBe("allow");
    expect(await session.respondApproval("perm-1", { behavior: "deny" })).toBe("unavailable");
  });

  it("sends a deny the CLI understands, not a silent drop", async () => {
    const fake = fakeSpawn();
    const session = await adapter(fake).create({ sessionId: "conv-6", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ type: "control_request", request_id: "perm-2", request: { subtype: "elicitation", mcp_server_name: "notes" } });
    await collectUntil(session.events(), (event) => event.type === "approval.requested");
    expect(await session.respondApproval("perm-2", { behavior: "deny", message: "no" })).toBe("rejected");
    const response = child.framesOfType("control_response")[0] as { response: { response: { behavior: string; message: string } } };
    expect(response.response.response).toMatchObject({ behavior: "deny", message: "no" });
  });

  it("reports a result marked as an error as a failed turn", async () => {
    const fake = fakeSpawn();
    const session = await adapter(fake).create({ sessionId: "conv-7", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ type: "result", subtype: "error", is_error: true });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: false, stopReason: "failed" }));
  });

  it("interrupts by closing stdin, keeping the native session resumable", async () => {
    const fake = fakeSpawn();
    const session = await adapter(fake).create({ sessionId: "conv-8", prompt: "hi" });
    const child = fake.children[0]!;
    init(child);
    await session.interrupt();
    expect(child.stdin.closed).toBe(true);
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true, stopReason: "interrupted" }));
    expect(session.nativeSessionId).toBe("native-session-1");
  });

  it("cancels by terminating the process and marks the turn failed", async () => {
    const fake = spawnWithLongLivedChild();
    const session = await adapter(fake).create({ sessionId: "conv-9", prompt: "hi" });
    await session.cancel();
    expect(fake.children[0]!.killed).toBe(true);
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: false, stopReason: "cancelled" }));
  });

  it("reports a process that dies before a result as a terminal error", async () => {
    const fake = fakeSpawn();
    const session = await adapter(fake).create({ sessionId: "conv-10", prompt: "hi" });
    fake.children[0]!.emitExit(2);
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "error", terminal: true }));
  });

  it("releases its process when the session is closed after the turn ended", async () => {
    const fake = fakeSpawn();
    const session = await adapter(fake).create({ sessionId: "conv-close", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ type: "result", subtype: "success" });
    await collectUntil(session.events(), (event) => event.type === "turn.completed");
    await session.close();
    expect(child.killed).toBe(true);
  });

  it("gives a native TUI descriptor pointing at the instance's own home", async () => {
    const fake = fakeSpawn();
    const session = await adapter(fake).create({ sessionId: "conv-11", prompt: "hi" });
    expect(session.nativeTui()).toEqual({ command: "claude", args: [], env: { HOME } });
    await session.close();
  });
});

function spawnWithLongLivedChild(): ReturnType<typeof fakeSpawn> {
  return fakeSpawn();
}
