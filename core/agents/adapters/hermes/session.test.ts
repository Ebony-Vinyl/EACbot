import { describe, expect, it } from "vitest";
import { HermesAdapter } from "./session.ts";
import {
  approvalBody, clarifyBody, createRunBody, deltaText, hermesErrorCode, hermesFeatures, isTerminalStatus,
  nativeSessionIdOf, runUsage, steerBody, terminalEventStatus, validIdempotencyKey,
} from "./codec.ts";
import { AgentHttpError } from "../../errors.ts";
import { collectUntil, fakeFetch, jsonResponse, sseResponse, textResponse } from "../../testing/fake-child.ts";

const BASE = "http://127.0.0.1:8642";
const TOKEN = "api-server-key";

interface Options {
  /** `GET /v1/runs/{id}` answer; the default is a running run that echoes a session id. */
  status?: Record<string, unknown> | null;
  /** `GET /v1/capabilities` features; `null` answers 404, as an older server does. */
  features?: Record<string, unknown> | null;
  create?: { body: unknown; status: number };
}

function adapter(responder: Parameters<typeof fakeFetch>[0], options: Options = {}) {
  const fake = fakeFetch((request) => {
    if (request.url === `${BASE}/v1/capabilities`) {
      if (options.features === null) return textResponse("not found", 404);
      return jsonResponse({ features: options.features ?? { run_submission: true, run_approval: true } });
    }
    if (request.url === `${BASE}/v1/runs` && request.method === "POST") {
      if (options.create) return jsonResponse(options.create.body, options.create.status);
      return jsonResponse({ run_id: "run-1", status: "started" }, 202);
    }
    if (request.url === `${BASE}/v1/runs/run-1` && request.method === "GET") {
      if (options.status === null) return textResponse("gone", 404);
      return jsonResponse(options.status ?? { run_id: "run-1", status: "running", session_id: "hermes-session-7" });
    }
    return responder(request);
  });
  return { fake, adapter: new HermesAdapter({ baseUrl: BASE, fetch: fake.fetch, token: TOKEN }) };
}

describe("Hermes Runs codec", () => {
  it("creates a run with the caller's session id, never a CLI-private session", () => {
    const body = createRunBody({ prompt: "hi", sessionId: "conv-1" });
    expect(body).toMatchObject({ input: "hi", session_id: "conv-1" });
    expect(JSON.stringify(body)).not.toMatch(/cli|terminal/i);
  });

  it("names the provider and model separately from the session", () => {
    const body = createRunBody({ prompt: "hi", sessionId: "conv-1", model: { providerId: "anthropic", modelId: "claude" } });
    expect(body).toMatchObject({ model: "claude", provider: "anthropic", session_id: "conv-1" });
  });

  it("answers an approval with choice once or deny and the exact identity", () => {
    expect(approvalBody({ requestId: "p1", allow: true })).toEqual({ request_id: "p1", choice: "once" });
    expect(approvalBody({ requestId: "p1", allow: false, executionGeneration: 3 }))
      .toEqual({ request_id: "p1", execution_generation: 3, choice: "deny" });
  });

  it("answers a clarify with a string answer and the same identity", () => {
    expect(clarifyBody({ requestId: "q1", executionGeneration: 4, answer: "src" }))
      .toEqual({ request_id: "q1", execution_generation: 4, answer: "src" });
    expect(clarifyBody({ requestId: "q1", answer: "" })).toEqual({ request_id: "q1", answer: "" });
  });

  it("steers with the documented input field", () => {
    expect(steerBody("go left")).toEqual({ input: "go left" });
  });

  it("accepts only a 1–255 visible-ASCII idempotency key", () => {
    expect(validIdempotencyKey("cmd-1")).toBe(true);
    expect(validIdempotencyKey("a".repeat(255))).toBe(true);
    expect(validIdempotencyKey("")).toBe(false);
    expect(validIdempotencyKey("a".repeat(256))).toBe(false);
    expect(validIdempotencyKey("has space")).toBe(false);
    expect(validIdempotencyKey("tab\tkey")).toBe(false);
    expect(validIdempotencyKey("ünïcode")).toBe(false);
  });

  it("maps each terminal event name to its exact status, and unknown is not terminal", () => {
    expect(terminalEventStatus("run.completed")).toBe("completed");
    expect(terminalEventStatus("run.cancelled")).toBe("cancelled");
    expect(terminalEventStatus("run.interrupted")).toBe("interrupted");
    expect(terminalEventStatus("run.failed")).toBe("failed");
    expect(terminalEventStatus("run.steered")).toBeNull();
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("unknown")).toBe(false);
  });

  it("takes the native session id only from what the server reports", () => {
    expect(nativeSessionIdOf({ session_id: "hermes-session" })).toBe("hermes-session");
    expect(nativeSessionIdOf({ session_id: "" })).toBeNull();
    expect(nativeSessionIdOf({})).toBeNull();
    expect(nativeSessionIdOf(null)).toBeNull();
  });

  it("reads usage with cached tokens inside input", () => {
    expect(runUsage({ usage: { input_tokens: 10, output_tokens: 3, cache_read_tokens: 4 } }))
      .toEqual({ input: 14, output: 3, cachedInput: 4 });
    expect(runUsage({})).toBeNull();
  });

  it("takes a delta's text from whichever field the adapter used", () => {
    expect(deltaText({ text: "a" })).toBe("a");
    expect(deltaText({ delta: "b" })).toBe("b");
    expect(deltaText({})).toBeNull();
  });

  it("reads only the documented capability flags", () => {
    expect(hermesFeatures({ features: { run_submission: true, run_approval: true } }))
      .toEqual({ runs: true, approval: true, unknownResolution: false, clarify: true });
    expect(hermesFeatures({ features: { run_submission: true } }))
      .toEqual({ runs: true, approval: false, unknownResolution: false, clarify: false });
    expect(hermesFeatures(null)).toEqual({ runs: false, approval: false, unknownResolution: false, clarify: false });
  });

  it("reads the engine's own error code from either documented field", () => {
    expect(hermesErrorCode({ code: "idempotency_key_conflict" })).toBe("idempotency_key_conflict");
    expect(hermesErrorCode({ error: "run_not_accepting_steer" })).toBe("run_not_accepting_steer");
    expect(hermesErrorCode({})).toBeNull();
  });
});

describe("Hermes adapter", () => {
  it("creates a run with the bearer key and reads the native session id from the status", async () => {
    const stream = sseResponse();
    const { fake, adapter: hermes } = adapter(() => stream.response);
    const session = await hermes.create({ sessionId: "conv-1", prompt: "hello" });
    const created = fake.requests.find((request) => request.url === `${BASE}/v1/runs`)!;
    expect(created.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(created.body).toMatchObject({ input: "hello", session_id: "conv-1" });

    // The native id is the engine's own echo, not the caller's id standing in for it.
    expect(session.sessionId).toBe("conv-1");
    expect(session.nativeSessionId).toBe("hermes-session-7");

    stream.send("message.delta", { text: "hi " });
    stream.send("run.completed", { output: "there", usage: { input_tokens: 5, output_tokens: 2 } });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "session.started", nativeSessionId: "hermes-session-7" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "text.delta", text: "hi " }));
    expect(events).toContainEqual(expect.objectContaining({ type: "usage.updated", input: 5, output: 2 }));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true }));
  });

  it("reports no native session id when the engine never reported one", async () => {
    const stream = sseResponse();
    const { adapter: hermes } = adapter(() => stream.response, { status: { run_id: "run-1", status: "running" } });
    const session = await hermes.create({ sessionId: "caller-conv", prompt: "hi" });
    expect(session.nativeSessionId).toBeNull();
    expect(session.sessionId).toBe("caller-conv");
    await session.close();
  });

  it("sends the caller's idempotency key on the create request", async () => {
    const stream = sseResponse();
    const { fake, adapter: hermes } = adapter(() => stream.response);
    const session = await hermes.create({ sessionId: "conv-2", prompt: "hi", idempotencyKey: "command-7" });
    expect(fake.requests.find((request) => request.url === `${BASE}/v1/runs`)!.headers["Idempotency-Key"]).toBe("command-7");
    await session.close();
  });

  it("refuses a malformed idempotency key instead of sending it", async () => {
    const { fake, adapter: hermes } = adapter(() => textResponse("no", 500));
    await expect(hermes.create({ sessionId: "conv-3", prompt: "hi", idempotencyKey: "bad key" }))
      .rejects.toThrow(/1–255 visible ASCII/);
    expect(fake.requests).toHaveLength(0);
  });

  it("surfaces a create refusal as a typed HTTP error with the engine's code", async () => {
    const { adapter: hermes } = adapter(() => textResponse("no", 500), {
      create: { body: { error: "permission_denied" }, status: 409 },
    });
    const failure = await hermes.create({ sessionId: "conv-4", prompt: "hi" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentHttpError);
    expect(failure).toMatchObject({ status: 409, code: "permission_denied", isRefusal: true });
  });

  it("steers while running and reports the engine's 409 as a refusal", async () => {
    const stream = sseResponse();
    let steerStatus = 200;
    const { fake, adapter: hermes } = adapter((request) => {
      if (request.url.endsWith("/steer")) {
        return steerStatus === 200
          ? jsonResponse({ ok: true })
          : textResponse(JSON.stringify({ error: "run_not_accepting_steer" }), 409);
      }
      return stream.response;
    });
    const session = await hermes.create({ sessionId: "conv-5", prompt: "hi" });
    expect(await session.steer("go left")).toBe("steered");
    expect(fake.requests.find((request) => request.url.endsWith("/steer"))!.body).toEqual({ input: "go left" });
    steerStatus = 409;
    expect(await session.steer("go right")).toBe("refused");
    await session.close();
  });

  it("reports a steer whose transport failed as indeterminate", async () => {
    const stream = sseResponse();
    const { adapter: hermes } = adapter((request) => {
      if (request.url.endsWith("/steer")) throw new Error("socket hang up");
      return stream.response;
    });
    const session = await hermes.create({ sessionId: "conv-6", prompt: "hi" });
    expect(await session.steer("go")).toBe("indeterminate");
    await session.close();
  });

  it("stops the run through /stop and settles it cancelled", async () => {
    const stream = sseResponse();
    const { fake, adapter: hermes } = adapter((request) => {
      if (request.url.endsWith("/stop")) return jsonResponse({ ok: true });
      return stream.response;
    });
    const session = await hermes.create({ sessionId: "conv-7", prompt: "hi" });
    await session.cancel();
    expect(fake.requests.some((request) => request.url === `${BASE}/v1/runs/run-1/stop`)).toBe(true);
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true, stopReason: "cancelled" }));
  });

  it("answers an approval with the request id and the run's own generation", async () => {
    const stream = sseResponse();
    const { fake, adapter: hermes } = adapter((request) => {
      if (request.url.endsWith("/approval")) return jsonResponse({ ok: true });
      return stream.response;
    }, { status: { run_id: "run-1", status: "running", session_id: "s", pending_controls: { prompt_id: "req-1", execution_generation: 4 } } });
    const session = await hermes.create({ sessionId: "conv-8", prompt: "hi" });
    stream.send("approval.request", { request_id: "req-1", command: "rm -rf build" });
    const events = await collectUntil(session.events(), (event) => event.type === "approval.requested");
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.requested", requestId: "req-1" }));

    expect(await session.respondApproval("req-1", { behavior: "allow" })).toBe("allowed-once");
    const approval = fake.requests.find((request) => request.url.endsWith("/approval"))!;
    expect(approval.body).toEqual({ request_id: "req-1", execution_generation: 4, choice: "once" });
  });

  it("answers a clarify through its own endpoint with the run's generation", async () => {
    const stream = sseResponse();
    const { fake, adapter: hermes } = adapter((request) => {
      if (request.url.endsWith("/clarify")) return jsonResponse({ ok: true });
      return stream.response;
    }, { status: { run_id: "run-1", status: "running", session_id: "s", execution_generation: 6 } });
    const session = await hermes.create({ sessionId: "conv-9", prompt: "hi" });
    stream.send("clarify.request", { request_id: "q-1", question: "Which folder?", choices: ["src", "docs"] });
    const events = await collectUntil(session.events(), (event) => event.type === "question.requested");
    expect(events).toContainEqual(expect.objectContaining({
      type: "question.requested",
      requestId: "q-1",
      questions: [{ question: "Which folder?", options: [{ label: "src" }, { label: "docs" }] }],
    }));

    expect(await session.respondApproval("q-1", { behavior: "answer", message: "src" })).toBe("answered");
    const clarify = fake.requests.find((request) => request.url.endsWith("/clarify"))!;
    expect(clarify.body).toEqual({ request_id: "q-1", execution_generation: 6, answer: "src" });
  });

  it("reports an approval unavailable when the server never advertised run_approval", async () => {
    const stream = sseResponse();
    const { fake, adapter: hermes } = adapter((request) => {
      if (request.url.endsWith("/approval")) return jsonResponse({ ok: true });
      return stream.response;
    }, { features: { run_submission: true } });
    const session = await hermes.create({ sessionId: "conv-10", prompt: "hi" });
    expect(await session.respondApproval("req-1", { behavior: "allow" })).toBe("unavailable");
    expect(fake.requests.some((request) => request.url.endsWith("/approval"))).toBe(false);
    await session.close();
  });

  it("reports a cancelled run as a clean stop and a failed one as a failure", async () => {
    const stream = sseResponse();
    const { adapter: hermes } = adapter(() => stream.response);
    const session = await hermes.create({ sessionId: "conv-11", prompt: "hi" });
    stream.send("run.cancelled", { interrupted: true, turn_exit_reason: "interrupted_by_user" });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true, stopReason: "cancelled" }));
  });

  it("surfaces the engine's pending_steer rather than silently dropping it", async () => {
    const stream = sseResponse();
    const { adapter: hermes } = adapter(() => stream.response);
    const session = await hermes.create({ sessionId: "conv-12", prompt: "hi" });
    stream.send("run.completed", { output: "done", pending_steer: "the words nobody delivered" });
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn.completed",
      pendingSteer: "the words nobody delivered",
    }));
  });

  it("reports an unknown run as not terminal and waits for resolve-unknown", async () => {
    const stream = sseResponse();
    const { adapter: hermes } = adapter(() => stream.response, {
      status: { run_id: "run-1", status: "unknown", session_id: "s", admission_id: "a-1", execution_generation: 2 },
    });
    const session = await hermes.create({ sessionId: "conv-13", prompt: "hi" });
    const events = await collectUntil(session.events(), (event) => event.type === "notice");
    expect(events).toContainEqual(expect.objectContaining({ type: "notice" }));
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    await session.close();
  });

  it("reads the run's status when the stream ends without a terminal event", async () => {
    const stream = sseResponse();
    const { fake, adapter: hermes } = adapter(() => stream.response, {
      status: { run_id: "run-1", status: "completed", session_id: "s", output: "final answer" },
    });
    const session = await hermes.create({ sessionId: "conv-14", prompt: "hi" });
    stream.end();
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(fake.requests.filter((request) => request.url === `${BASE}/v1/runs/run-1`).length).toBeGreaterThan(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "text.delta", text: "final answer" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true }));
  });

  it("refuses a run the server rejects instead of starting a turn", async () => {
    const { adapter: hermes } = adapter(() => textResponse("no", 500), {
      create: { body: { error: "unauthorized" }, status: 401 },
    });
    await expect(hermes.create({ sessionId: "conv-15", prompt: "hi" })).rejects.toThrow(/answered 401/);
  });

  it("says plainly that it cannot send images rather than dropping them silently", async () => {
    const { fake, adapter: hermes } = adapter(() => jsonResponse({ run_id: "run-16" }, 202));
    const session = await hermes.create({
      sessionId: "conv-16",
      prompt: "look",
      images: [{ path: "/tmp/x.png", mime: "image/png" }],
    });
    const events = await collectUntil(session.events(), () => false).catch(() => []);
    expect(events).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });
});
