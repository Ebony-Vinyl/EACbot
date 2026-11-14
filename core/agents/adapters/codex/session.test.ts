import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./session.ts";
import {
  approvalResult, codexNotification, initializeParams, isApprovalMethod, threadStartParams, tokenUsage, toolItemTitle,
  turnInterruptParams, turnStartParams, turnSteerParams,
} from "./codec.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUntil, fakeSpawn, type FakeChild } from "../../testing/fake-child.ts";

const HOME = "/tmp/fixture-codex-home";

function adapter(fake: ReturnType<typeof fakeSpawn>): CodexAdapter {
  return new CodexAdapter({ spawn: fake.spawn, home: HOME, clientVersion: "9.9.9" });
}

/** Answers the app-server's own handshake so the turn can start. Steering is left to each test. */
function scriptHandshake(child: FakeChild): void {
  child.onLine((line) => {
    if (line.method === "initialize") child.send({ jsonrpc: "2.0", id: line.id, result: { userAgent: "codex" } });
    if (line.method === "thread/start") child.send({ jsonrpc: "2.0", id: line.id, result: { thread: { id: "thread-1" } } });
    if (line.method === "thread/resume") child.send({ jsonrpc: "2.0", id: line.id, result: { thread: { id: String((line.params as { threadId: string }).threadId) } } });
    if (line.method === "turn/start") child.send({ jsonrpc: "2.0", id: line.id, result: { turn: { id: "turn-1" } } });
    if (line.method === "turn/interrupt") child.send({ jsonrpc: "2.0", id: line.id, result: {} });
  });
}

describe("Codex app-server codec", () => {
  it("declares the experimental API the named permission profiles need", () => {
    expect(initializeParams("9.9.9")).toMatchObject({
      clientInfo: { name: "eacbot-core", version: "9.9.9" },
      capabilities: { experimentalApi: true },
    });
  });

  it("sends thread/start with the approval policy and sandbox, and turn/start with input items", () => {
    expect(threadStartParams({ cwd: "/w", approvalPolicy: "on-request", sandbox: "workspace-write" }))
      .toMatchObject({ cwd: "/w", approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(turnStartParams({ threadId: "t", text: "hi" })).toEqual({
      threadId: "t", input: [{ type: "text", text: "hi" }],
    });
  });

  it("guards a steer with the running turn's own id", () => {
    expect(turnSteerParams({ threadId: "t", turnId: "u", text: "x" })).toMatchObject({
      threadId: "t", expectedTurnId: "u", input: [{ type: "text", text: "x" }],
    });
    expect(turnInterruptParams({ threadId: "t", turnId: "u" })).toEqual({ threadId: "t", turnId: "u" });
  });

  it("answers a legacy approval with approved/denied and a current one with accept/decline", () => {
    expect(approvalResult("execCommandApproval", true)).toEqual({ decision: "approved" });
    expect(approvalResult("execCommandApproval", false)).toEqual({ decision: "denied" });
    expect(approvalResult("item/commandExecution/requestApproval", true)).toEqual({ decision: "accept" });
    expect(approvalResult("item/commandExecution/requestApproval", false)).toEqual({ decision: "decline" });
  });

  it("recognises the approval methods and declines the rest", () => {
    expect(isApprovalMethod("item/fileChange/requestApproval")).toBe(true);
    expect(isApprovalMethod("item/tool/requestUserInput")).toBe(true);
    expect(isApprovalMethod("thread/started")).toBe(false);
  });

  it("names the tools it can show and ignores the prompt echo", () => {
    expect(toolItemTitle({ type: "commandExecution", command: "ls" })).toBe("ls");
    expect(toolItemTitle({ type: "fileChange" })).toBe("edit");
    expect(toolItemTitle({ type: "userMessage" })).toBeNull();
  });

  it("reads token totals and distinguishes a notification from a response", () => {
    expect(tokenUsage({ tokenUsage: { total: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 2 } } }))
      .toEqual({ input: 5, output: 1, cachedInput: 2 });
    expect(codexNotification({ method: "turn/completed", params: {} })).toEqual({ method: "turn/completed", params: {} });
    expect(codexNotification({ id: 1, method: "turn/completed", params: {} })).toBeNull();
  });
});

describe("Codex adapter", () => {
  it("runs initialize, initialized, thread/start and turn/start in that order", async () => {
    const fake = fakeSpawn((child) => scriptHandshake(child));
    const session = await adapter(fake).create({ sessionId: "conv-1", prompt: "hi" });
    const methods = fake.children[0]!.lines.map((line) => line.method).filter(Boolean);
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(fake.calls[0]!.args).toEqual(["app-server"]);
    expect(fake.calls[0]!.options.env.HOME).toBe(HOME);
    await session.close();
  });

  it("resumes a thread instead of starting one, and reports the engine's own thread id", async () => {
    const fake = fakeSpawn((child) => scriptHandshake(child));
    const session = await adapter(fake).create({ sessionId: "conv-2", prompt: "hi", resumeCursor: "thread-old" });
    const methods = fake.children[0]!.lines.map((line) => line.method).filter(Boolean);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect(session.nativeSessionId).toBe("thread-old");
  });

  it("streams deltas, tool items and usage, then completes on turn/completed", async () => {
    const fake = fakeSpawn((child) => scriptHandshake(child));
    const session = await adapter(fake).create({ sessionId: "conv-3", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "hello" } });
    child.send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "i1", type: "commandExecution", command: "ls" } } });
    child.send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "i1", type: "commandExecution", status: "completed" } } });
    child.send({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 7, outputTokens: 3 } } } });
    child.send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "text.delta", text: "hello" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.started", title: "ls" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", ok: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "usage.updated", input: 7, output: 3 }));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true }));
  });

  it("turns a failed turn into a failed completion", async () => {
    const fake = fakeSpawn((child) => scriptHandshake(child));
    const session = await adapter(fake).create({ sessionId: "conv-4", prompt: "hi" });
    fake.children[0]!.send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed" } } });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: false, stopReason: "failed" }));
  });

  it("steers with the running turn's id and reports a JSON-RPC refusal as refused", async () => {
    const fake = fakeSpawn((child) => {
      scriptHandshake(child);
      child.onLine((line) => {
        if (line.method === "turn/steer") {
          child.send({ jsonrpc: "2.0", id: line.id, error: { code: -32000, message: "ActiveTurnNotSteerable" } });
        }
      });
    });
    const session = await adapter(fake).create({ sessionId: "conv-5", prompt: "hi" });
    expect(await session.steer("more")).toBe("refused");
    const steer = fake.children[0]!.callsOfMethod("turn/steer")[0]!;
    expect(steer.params).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1" });
  });

  it("reports an accepted steer as steered", async () => {
    const fake = fakeSpawn((child) => {
      scriptHandshake(child);
      child.onLine((line) => {
        if (line.method === "turn/steer") child.send({ jsonrpc: "2.0", id: line.id, result: {} });
      });
    });
    const session = await adapter(fake).create({ sessionId: "conv-6", prompt: "hi" });
    expect(await session.steer("more")).toBe("steered");
    await session.close();
  });

  it("reports a steer that never answered as indeterminate", async () => {
    const fake = fakeSpawn((child) => {
      scriptHandshake(child);
      child.onLine((line) => {
        if (line.method === "turn/steer") {
          // Accepted and never answered, as a wedged app-server does.
          return;
        }
      });
    });
    const session = await new CodexAdapter({ spawn: fake.spawn, home: HOME }).create({ sessionId: "conv-7", prompt: "hi" });
    const child = fake.children[0]!;
    const pending = session.steer("hang");
    // The turn ends while the answer is in flight: the words may already be in the turn, so the
    // outcome is indeterminate rather than a refusal the caller could safely queue on.
    child.send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(await pending).toBe("indeterminate");
  });

  it("interrupts over the protocol with turn/interrupt", async () => {
    const fake = fakeSpawn((child) => scriptHandshake(child));
    const session = await adapter(fake).create({ sessionId: "conv-8", prompt: "hi" });
    await session.interrupt();
    expect(fake.children[0]!.callsOfMethod("turn/interrupt")[0]!.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    await session.close();
  });

  it("answers a command approval with the app-server's own decision shape", async () => {
    const fake = fakeSpawn((child) => scriptHandshake(child));
    const session = await adapter(fake).create({ sessionId: "conv-9", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({
      jsonrpc: "2.0", id: 99, method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "rm -rf build" },
    });
    const events = await collectUntil(session.events(), (event) => event.type === "approval.requested");
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.requested", requestId: "codex-99" }));

    expect(await session.respondApproval("codex-99", { behavior: "allow" })).toBe("allowed-once");
    const reply = child.lines.find((line) => line.id === 99 && line.result) as { result: { decision: string } };
    expect(reply.result).toEqual({ decision: "accept" });
  });

  it("fails an unknown server request closed instead of accepting it", async () => {
    const fake = fakeSpawn((child) => scriptHandshake(child));
    const session = await adapter(fake).create({ sessionId: "conv-10", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ jsonrpc: "2.0", id: 77, method: "item/permissions/widenSandbox", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = child.lines.find((line) => line.id === 77) as { error?: { code: number }; result?: unknown };
    expect(reply.error?.code).toBe(-32601);
    expect(reply.result).toBeUndefined();
    await session.close();
  });

  it("reports a server error notification without ending the turn early", async () => {
    const fake = fakeSpawn((child) => scriptHandshake(child));
    const session = await adapter(fake).create({ sessionId: "conv-11", prompt: "hi" });
    const child = fake.children[0]!;
    child.send({ jsonrpc: "2.0", method: "error", params: { message: "model unavailable" } });
    child.send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: "model unavailable" }));
    // An error notification does not make a completed turn a failure.
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true }));
  });

  it("reports an app-server that exits before turn/completed as a terminal error", async () => {
    const fake = fakeSpawn((child) => scriptHandshake(child));
    const session = await adapter(fake).create({ sessionId: "conv-12", prompt: "hi" });
    fake.children[0]!.emitExit(1);
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "error", terminal: true }));
  });

  it("sends each attached image as an inline data URL, never a host path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-codex-image-"));
    const imagePath = join(dir, "shot.png");
    // A one-pixel PNG, so the adapter reads a real file rather than a stub.
    writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
    const fake = fakeSpawn((child) => scriptHandshake(child));
    const session = await new CodexAdapter({ spawn: fake.spawn, home: HOME }).create({
      sessionId: "conv-images",
      prompt: "what is this?",
      images: [{ path: imagePath, mime: "image/png" }],
    });
    const turn = fake.children[0]!.callsOfMethod("turn/start")[0]!;
    const input = (turn.params as { input: Array<{ type: string; text?: string; url?: string }> }).input;
    expect(input[0]).toEqual({ type: "text", text: "what is this?" });
    expect(input[1]!.type).toBe("image");
    // A sandboxed run cannot read the host path; the bytes travel with the request.
    expect(input[1]!.url).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(input)).not.toContain(imagePath);
    await session.close();
  });

  it("closes the stream and the process when the handshake fails", async () => {
    const fake = fakeSpawn((child) => {
      child.onLine((line) => {
        if (line.method === "initialize") {
          child.send({ jsonrpc: "2.0", id: line.id, error: { code: -32600, message: "unsupported protocol" } });
        }
      });
    });
    const failure = await new CodexAdapter({ spawn: fake.spawn, home: HOME })
      .create({ sessionId: "conv-handshake", prompt: "hi" })
      .catch((error: unknown) => error);
    expect((failure as Error).message).toMatch(/initialize failed/);
    expect(fake.children[0]!.killed).toBe(true);
  });

  it("gives a native TUI descriptor pointing at the instance's own home", async () => {
    const fake = fakeSpawn((child) => scriptHandshake(child));
    const session = await adapter(fake).create({ sessionId: "conv-13", prompt: "hi" });
    expect(session.nativeTui()).toEqual({ command: "codex", args: [], env: { HOME } });
    await session.close();
  });
});
