import { describe, expect, it } from "vitest";
import { CustomAcpAdapter } from "./session.ts";
import { UnsupportedCapabilityError } from "../../errors.ts";
import { collectUntil, fakeSpawn, type FakeChild } from "../../testing/fake-child.ts";

const HOME = "/tmp/fixture-acp-home";

function adapter(fake: ReturnType<typeof fakeSpawn>): CustomAcpAdapter {
  return new CustomAcpAdapter({ spawn: fake.spawn, command: "custom-agent", args: ["acp"], home: HOME });
}

/** A real agent answers session/prompt only when the turn ends, so the updates arrive first. */
function scriptAgent(child: FakeChild, options: { holdPrompt?: boolean } = {}): void {
  child.onLine((line) => {
    if (line.method === "initialize") child.send({ jsonrpc: "2.0", id: line.id, result: { protocolVersion: 1 } });
    if (line.method === "session/new") child.send({ jsonrpc: "2.0", id: line.id, result: { sessionId: "acp-session-1" } });
    if (line.method === "session/prompt" && !options.holdPrompt) {
      child.send({ jsonrpc: "2.0", id: line.id, result: { stopReason: "end_turn" } });
    }
  });
}

function answerPrompt(child: FakeChild): void {
  const prompt = child.callsOfMethod("session/prompt")[0]!;
  child.send({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
}

describe("custom ACP adapter", () => {
  it("reports steer as unsupported instead of faking it", async () => {
    const fake = fakeSpawn((child) => scriptAgent(child));
    const session = await adapter(fake).create({ sessionId: "conv-1", prompt: "hi" });
    await expect(session.steer("more")).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await session.close();
  });

  it("reports the capability set honestly in the registry and on the adapter", async () => {
    const fake = fakeSpawn((child) => scriptAgent(child));
    const acp = adapter(fake);
    expect(acp.capabilities.steer.kind).toBe("none");
    expect(acp.capabilities.nativeTui).toBe(false);
    const session = await acp.create({ sessionId: "conv-2", prompt: "hi" });
    expect(() => session.nativeTui()).toThrow(UnsupportedCapabilityError);
    await session.close();
  });

  it("runs initialize, session/new and session/prompt and completes on its stop reason", async () => {
    const fake = fakeSpawn((child) => scriptAgent(child));
    const session = await adapter(fake).create({ sessionId: "conv-3", prompt: "hello" });
    const child = fake.children[0]!;
    expect(fake.calls[0]!.command).toBe("custom-agent");
    expect(fake.calls[0]!.args).toEqual(["acp"]);
    expect(fake.calls[0]!.options.env.HOME).toBe(HOME);
    expect(child.lines.map((line) => line.method).filter(Boolean))
      .toEqual(["initialize", "session/new", "session/prompt"]);
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "session.started", nativeSessionId: "acp-session-1" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true, stopReason: "end_turn" }));
  });

  it("streams agent text, thought chunks and tool calls", async () => {
    const fake = fakeSpawn((child) => scriptAgent(child, { holdPrompt: true }));
    const session = await adapter(fake).create({ sessionId: "conv-4", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } },
    });
    child.send({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "acp-session-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" } } },
    });
    child.send({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "acp-session-1", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "read file" } },
    });
    child.send({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "acp-session-1", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } },
    });
    answerPrompt(child);
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "text.delta", text: "answer" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "reasoning.delta", text: "thought" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.started", title: "read file" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", ok: true }));
  });

  it("answers a permission request and fails an unknown one closed", async () => {
    const fake = fakeSpawn((child) => scriptAgent(child, { holdPrompt: true }));
    const session = await adapter(fake).create({ sessionId: "conv-5", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({
      jsonrpc: "2.0", id: 5, method: "session/request_permission",
      params: { sessionId: "acp-session-1", toolCall: { title: "run tests" }, options: [{ optionId: "allow_once", kind: "allow_once" }] },
    });
    const events = await collectUntil(session.events(), (event) => event.type === "approval.requested");
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.requested", requestId: "acp-5" }));
    expect(await session.respondApproval("acp-5", { behavior: "allow" })).toBe("allowed-once");
    const reply = child.lines.find((line) => line.id === 5 && line.result) as { result: { outcome: { outcome: string } } };
    expect(reply.result.outcome).toEqual({ outcome: "selected", optionId: "allow_once" });

    child.send({ jsonrpc: "2.0", id: 6, method: "fs/write_text_file", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const refused = child.lines.find((line) => line.id === 6) as { error?: { code: number } };
    expect(refused.error?.code).toBe(-32601);
    await session.close();
  });

  it("cancels through the protocol's own notification", async () => {
    const fake = fakeSpawn((child) => {
      child.onLine((line) => {
        if (line.method === "initialize") child.send({ jsonrpc: "2.0", id: line.id, result: {} });
        if (line.method === "session/new") child.send({ jsonrpc: "2.0", id: line.id, result: { sessionId: "acp-session-1" } });
      });
    });
    const session = await adapter(fake).create({ sessionId: "conv-6", prompt: "hi" });
    await session.interrupt();
    expect(fake.children[0]!.callsOfMethod("session/cancel")).toHaveLength(1);
    await session.close();
  });
});
