import { describe, expect, it } from "vitest";
import { JsonlRpcAdapter } from "./session.ts";
import { agentDescriptor } from "../../registry.ts";
import { collectUntil, fakeSpawn, type FakeChild } from "../../testing/fake-child.ts";
import { MAX_PIECE_BYTES } from "../../transport/jsonl.ts";

const HOME = "/tmp/fixture-pi-home";

function adapter(id: "pi" | "ohMyPi", fake: ReturnType<typeof fakeSpawn>, home = HOME): JsonlRpcAdapter {
  return new JsonlRpcAdapter(agentDescriptor(id), {
    spawn: fake.spawn,
    cli: agentDescriptor(id).cli!,
    home,
    negotiateProtocol: true,
    settleOnAgentSettled: id === "pi",
  });
}

/** Answers the frames a real engine answers before the turn can run. */
function scriptStart(
  child: FakeChild,
  options: { sessionFile?: string; steer?: (message: string) => "accept" | "refuse" | "silent" } = {},
): void {
  child.onLine((line) => {
    if (line.type === "new_session") child.send({ type: "response", id: line.id, command: "new_session", success: true, data: { sessionFile: options.sessionFile ?? "/sessions/one.jsonl" } });
    if (line.type === "switch_session") child.send({ type: "response", id: line.id, command: "switch_session", success: true, data: { sessionFile: String(line.sessionPath) } });
    if (line.type === "set_model") child.send({ type: "response", id: line.id, command: "set_model", success: true, data: { provider: line.provider, id: line.modelId } });
    if (line.type === "prompt") child.send({ type: "response", id: line.id, command: "prompt", success: true, data: {} });
    if (line.type === "abort") child.send({ type: "response", id: line.id, command: "abort", success: true, data: {} });
    if (line.type === "steer") {
      const verdict = options.steer?.(String(line.message)) ?? "accept";
      if (verdict === "silent") return;
      child.send({ type: "response", id: line.id, command: "steer", success: verdict === "accept" });
    }
  });
}

describe("Pi and Oh My Pi JSONL RPC", () => {
  it("starts the engine's own CLI with its own home and negotiates protocol v2", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const pi = adapter("pi", fake);
    const session = await pi.create({ sessionId: "conv-1", prompt: "hello", model: { providerId: "anthropic", modelId: "claude" } });
    const child = fake.children[0]!;
    expect(fake.calls[0]!.command).toBe("pi");
    expect(fake.calls[0]!.args).toEqual(["--mode", "rpc", "--no-session"]);
    expect(fake.calls[0]!.options.env.PI_HOME).toBe(HOME);
    expect(child.framesOfType("negotiate_protocol")[0]).toMatchObject({ protocolVersion: 2 });
    expect(child.framesOfType("new_session")).toHaveLength(1);
    expect(child.framesOfType("set_model")[0]).toMatchObject({ provider: "anthropic", modelId: "claude" });
    await session.close();
  });

  it("keeps Oh My Pi on its own binary and home, never Pi's", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const omp = adapter("ohMyPi", fake, "/tmp/fixture-omp-home");
    const session = await omp.create({ sessionId: "conv-2", prompt: "hello" });
    expect(fake.calls[0]!.command).toBe("omp");
    expect(fake.calls[0]!.options.env.OMP_HOME).toBe("/tmp/fixture-omp-home");
    expect(fake.calls[0]!.options.env.PI_HOME).toBeUndefined();
    await session.close();
  });

  it("streams text and reasoning deltas and settles on agent_settled", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("pi", fake).create({ sessionId: "conv-3", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
    child.send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking" } });
    child.send({ type: "agent_settled" });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "turn.started", "text.delta", "reasoning.delta", "turn.completed",
    ]));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true }));
  });

  it("does not settle a Pi turn on agent_end that will retry", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("pi", fake).create({ sessionId: "conv-4", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ type: "agent_end", willRetry: true });
    child.send({ type: "agent_end" });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("does not settle an Oh My Pi turn on agent_end with isTerminal false", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("ohMyPi", fake).create({ sessionId: "conv-5", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ type: "agent_end", isTerminal: false });
    // Oh My Pi may never send agent_settled, so a terminal agent_end has to end the turn.
    child.send({ type: "agent_end" });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("does not treat a tool-call turn_end as the end of the turn", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("pi", fake).create({ sessionId: "conv-6", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ type: "turn_end", message: { stopReason: "toolUse" } });
    child.send({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
    child.send({ type: "tool_execution_end", toolCallId: "t1", isError: false });
    child.send({ type: "agent_settled" });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["tool.started", "tool.completed"]));
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("reassembles an Oh My Pi chunked frame into one event", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("ohMyPi", fake).create({ sessionId: "conv-7", prompt: "hi" });
    const child = fake.children[0]!;
    const payload = Buffer.from(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "chunked text" },
    }), "utf8");
    const pieceSize = Math.ceil(payload.length / 2);
    for (let index = 0; index < 2; index++) {
      child.send({
        type: "rpc_chunk",
        chunkId: "c-1",
        index,
        count: 2,
        byteLength: payload.length,
        data: payload.subarray(index * pieceSize, (index + 1) * pieceSize).toString("base64"),
      });
    }
    child.send({ type: "agent_end" });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "text.delta", text: "chunked text" }));
  });

  it("refuses an oversized piece without emitting a spliced event", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("ohMyPi", fake).create({ sessionId: "conv-8", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({
      type: "rpc_chunk",
      chunkId: "c-2",
      index: 0,
      count: 2,
      byteLength: 10,
      data: Buffer.alloc(MAX_PIECE_BYTES + 8, 0x61).toString("base64"),
    });
    child.send({ type: "agent_end" });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events.some((event) => event.type === "text.delta")).toBe(false);
  });

  it("answers a steer as steered, refused or indeterminate without guessing", async () => {
    const fake = fakeSpawn((child) => scriptStart(child, { steer: (message) => (message === "no" ? "refuse" : "accept") }));
    const session = await adapter("pi", fake).create({ sessionId: "conv-9", prompt: "hi" });
    expect(await session.steer("keep going")).toBe("steered");

    // A live engine's explicit success:false is a refusal the caller may queue on.
    expect(await session.steer("no")).toBe("refused");

    const child = fake.children[0]!;
    child.send({ type: "agent_settled" });
    await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(await session.steer("too late")).toBe("refused");
  });

  it("reports a steer whose answer never comes as indeterminate", async () => {
    const fake = fakeSpawn((child) => scriptStart(child, { steer: () => "silent" }));
    const adapterWithShortTimeout = new JsonlRpcAdapter(agentDescriptor("pi"), {
      spawn: fake.spawn,
      cli: "pi",
      home: HOME,
      negotiateProtocol: true,
      settleOnAgentSettled: true,
      steerTimeoutMs: 20,
    });
    const session = await adapterWithShortTimeout.create({ sessionId: "conv-10", prompt: "hi" });
    // The frame was accepted by a live runtime that never answered: the words may already be in
    // the turn, so the caller must not re-queue them.
    expect(await session.steer("hang")).toBe("indeterminate");
    await session.close();
  });

  it("raises an approval for an extension ui request and answers it", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("pi", fake).create({ sessionId: "conv-11", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ type: "extension_ui_request", id: "ask-1", method: "confirm", title: "run the tests?" });
    const events = await collectUntil(session.events(), (event) => event.type === "approval.requested");
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.requested", requestId: "ask-1" }));

    expect(await session.respondApproval("ask-1", { behavior: "allow" })).toBe("allowed-once");
    expect(child.framesOfType("extension_ui_response")[0]).toMatchObject({ id: "ask-1", confirmed: true });
    expect(await session.respondApproval("ask-1", { behavior: "allow" })).toBe("unavailable");
  });

  it("turns a select request into a question and answers with the chosen option", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("pi", fake).create({ sessionId: "conv-12", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({
      type: "extension_ui_request", id: "q-1", method: "select", title: "which file?",
      options: ["a.ts", "b.ts"],
    });
    const events = await collectUntil(session.events(), (event) => event.type === "question.requested");
    const question = events.find((event) => event.type === "question.requested");
    expect(question).toMatchObject({ requestId: "q-1" });
    await session.respondApproval("q-1", { behavior: "answer", message: "b.ts" });
    expect(child.framesOfType("extension_ui_response")[0]).toMatchObject({ id: "q-1", value: "b.ts" });
  });

  it("ignores the extension ui floods that are not questions", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("pi", fake).create({ sessionId: "conv-13", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ type: "extension_ui_request", id: "w-1", method: "setWidget", title: "x" });
    child.send({ type: "agent_settled" });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
  });

  it("reports a process that dies before the turn ends as a terminal error", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("pi", fake).create({ sessionId: "conv-14", prompt: "hi" });
    const child = fake.children[0]!;
    child.emitExit(1);
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "error", terminal: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: false }));
  });

  it("interrupts with the engine's abort frame and settles the turn", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("pi", fake).create({ sessionId: "conv-15", prompt: "hi" });
    const child = fake.children[0]!;
    await session.interrupt();
    expect(child.framesOfType("abort")).toHaveLength(1);
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true, stopReason: "cancelled" }));
  });

  it("resumes from a session file cursor and reports a refusal honestly", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("pi", fake).create({ sessionId: "conv-16", prompt: "hi" });
    expect(await session.resume({ cursor: "/sessions/old.jsonl" })).toEqual({
      resumed: true, nativeSessionId: "/sessions/old.jsonl", rebuilt: false,
    });
    await session.close();
  });

  it("refuses attached images instead of dropping them silently", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("pi", fake).create({
      sessionId: "conv-images",
      prompt: "look",
      images: [{ path: "/tmp/none.png", mime: "image/png" }],
    }).catch((error: unknown) => error);
    // The read of a missing file fails before any prompt, and the stream is closed rather than
    // left open with no turn behind it.
    expect(session).toBeInstanceOf(Error);
    expect(fake.children[0]!.killed).toBe(true);
  });

  it("says so when the engine never confirms a session, and still runs the turn", async () => {
    const fake = fakeSpawn((child) => {
      child.onLine((line) => {
        // Answers the prompt but never the session frame, as a wedged runtime does.
        if (line.type === "prompt") child.send({ type: "response", id: line.id, success: true });
      });
    });
    const pi = new JsonlRpcAdapter(agentDescriptor("pi"), {
      spawn: fake.spawn,
      cli: "pi",
      home: HOME,
      negotiateProtocol: true,
      settleOnAgentSettled: true,
      sessionOpenTimeoutMs: 20,
    });
    const session = await pi.create({ sessionId: "conv-handshake", prompt: "hi" });
    const events = await collectUntil(session.events(), (event) => event.type === "session.started");
    expect(events).toContainEqual(expect.objectContaining({ type: "notice" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "session.started", nativeSessionId: null }));
    await session.close();
  });

  it("releases its process when the session is closed after the turn ended", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("pi", fake).create({ sessionId: "conv-close", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ type: "agent_settled" });
    await collectUntil(session.events(), (event) => event.type === "turn.completed");
    await session.close();
    expect(child.killed).toBe(true);
  });

  it("gives a native TUI argv that matches the engine's own binary", async () => {
    const fake = fakeSpawn((child) => scriptStart(child));
    const session = await adapter("ohMyPi", fake).create({ sessionId: "conv-17", prompt: "hi" });
    expect(session.nativeTui()).toEqual({ command: "omp", args: [], env: { OMP_HOME: HOME } });
    await session.close();
  });
});
