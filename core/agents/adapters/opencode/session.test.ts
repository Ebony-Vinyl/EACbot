import { describe, expect, it } from "vitest";
import { OpenCodeAdapter } from "./session.ts";
import {
  createSessionRequest, eventSessionId, eventsUrl, inboxDeliveryRequest, interruptUrl, openCodeEvent,
  permissionReply, permissionReplyUrl, promptRequest, readModels, readUsage, switchModelRequest,
} from "./codec.ts";
import { AgentHttpError } from "../../errors.ts";
import { collectUntil, fakeFetch, jsonResponse, sseResponse, textResponse } from "../../testing/fake-child.ts";

const BASE = "http://127.0.0.1:4096";

/** One SSE frame as the server sends it: an `event:` name and a JSON `data:` payload. */
function event(name: string, data: Record<string, unknown>): Record<string, unknown> {
  return { type: name, data: { ...data, type: name } };
}

describe("OpenCode V2 codec", () => {
  it("uses the fixed /api prefix and the engine's own delivery words", () => {
    expect(createSessionRequest(BASE).url).toBe(`${BASE}/api/session`);
    expect(promptRequest(BASE, "s1", { text: "hi" }).url).toBe(`${BASE}/api/session/s1/prompt`);
    // The official body is flat, and `text` is required.
    expect(promptRequest(BASE, "s1", { text: "hi", delivery: "steer" }).body).toEqual({ text: "hi", delivery: "steer" });
    expect(interruptUrl(BASE, "s1", true)).toBe(`${BASE}/api/session/s1/interrupt?resume=true`);
    expect(interruptUrl(BASE, "s1", false)).toBe(`${BASE}/api/session/s1/interrupt?resume=false`);
    expect(eventsUrl(BASE)).toBe(`${BASE}/api/event`);
    expect(permissionReplyUrl(BASE, "s1", "p1")).toBe(`${BASE}/api/session/s1/permission/p1/reply`);
  });

  it("encodes a model as providerID/id and a variant only when one is named", () => {
    expect(createSessionRequest(BASE, { providerId: "p", modelId: "m" }).body).toEqual({ model: { providerID: "p", id: "m" } });
    expect(createSessionRequest(BASE, { providerId: "p", modelId: "m", variant: "high" }).body)
      .toEqual({ model: { providerID: "p", id: "m", variant: "high" } });
    expect(switchModelRequest(BASE, "s1", { providerId: "p", modelId: "m" })).toEqual({
      url: `${BASE}/api/session/s1/model`,
      body: { model: { providerID: "p", id: "m" } },
    });
  });

  it("promotes a queued inbox item through the documented PATCH body", () => {
    expect(inboxDeliveryRequest(BASE, "s1", "m1", "steer")).toEqual({
      url: `${BASE}/api/session/s1/inbox/m1`,
      body: { delivery: "steer" },
    });
  });

  it("maps an allow to once/always and a deny to reject", () => {
    expect(permissionReply("allow", false)).toBe("once");
    expect(permissionReply("allow", true)).toBe("always");
    expect(permissionReply("deny", false)).toBe("reject");
  });

  it("reads the event type from the payload or the SSE line, and its session from data", () => {
    expect(openCodeEvent({ data: { type: "session.idle", sessionID: "s1" } }))
      .toEqual({ type: "session.idle", data: { type: "session.idle", sessionID: "s1" } });
    expect(openCodeEvent({ data: { sessionID: "s1" } }, "session.text.delta"))
      .toEqual({ type: "session.text.delta", data: { sessionID: "s1" } });
    expect(openCodeEvent({ data: "not an object" })).toBeNull();
    const parsed = openCodeEvent({ data: { type: "session.idle", sessionID: "s1" } })!;
    expect(eventSessionId(parsed)).toBe("s1");
  });

  it("reads a model row from Model.Info, including its image capability", () => {
    const models = readModels({
      location: { directory: "/w" },
      data: [
        {
          id: "p/m", modelID: "m", providerID: "p", name: "Model M", enabled: true,
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          variants: [{ id: "high" }, { id: "low" }],
          limit: { context: 200000, output: 8192 },
          time: { released: 1 }, cost: [], status: "active",
        },
        { id: "bad" },
      ],
    });
    expect(models).toEqual([{
      ref: { providerId: "p", modelId: "m" },
      label: "Model M",
      contextWindow: 200000,
      maxOutputTokens: 8192,
      enabled: true,
      acceptsImages: true,
      variants: ["high", "low"],
    }]);
  });

  it("counts cached prompt tokens inside input", () => {
    expect(readUsage({ input: 10, output: 2, reasoning: 0, cache: { read: 5, write: 0 } }))
      .toEqual({ input: 15, output: 2, cachedInput: 5 });
    expect(readUsage(undefined)).toBeNull();
  });
});

describe("OpenCode adapter", () => {
  function adapter(responder: Parameters<typeof fakeFetch>[0]) {
    const fake = fakeFetch(responder);
    return { fake, adapter: new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch }) };
  }

  it("subscribes to the global event stream before sending the prompt", async () => {
    const stream = sseResponse();
    const order: string[] = [];
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) {
        order.push("subscribe");
        return stream.response;
      }
      if (request.url === `${BASE}/api/session` && request.method === "POST") {
        return jsonResponse({ data: { id: "ses-1" } });
      }
      if (request.url.endsWith("/prompt")) {
        order.push("prompt");
        return jsonResponse({ data: { admittedSeq: 1, id: "m1" } });
      }
      return textResponse("not found", 404);
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "conv-1", prompt: "hello" });
    // A volatile stream that is subscribed after the prompt could lose the whole turn.
    expect(order).toEqual(["subscribe", "prompt"]);
    expect(fake.requests.find((request) => request.url.endsWith("/prompt"))!.body).toEqual({ text: "hello" });
    await session.close();
  });

  it("filters the shared stream to this session's events", async () => {
    const stream = sseResponse();
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "ses-1" } });
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "conv-2", prompt: "hi" });
    stream.send("session.text.delta", event("session.text.delta", { sessionID: "other-session", delta: "not ours" }));
    stream.send("session.text.delta", event("session.text.delta", { sessionID: "ses-1", delta: "ours" }));
    stream.send("session.execution.succeeded", event("session.execution.succeeded", { sessionID: "ses-1" }));
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "text.delta", text: "ours" }));
    expect(events.some((event) => event.type === "text.delta" && "text" in event && event.text === "not ours")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true }));
  });

  it("keeps the caller's session id as its identity and the engine's as a cursor", async () => {
    const stream = sseResponse();
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "engine-session" } });
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "caller-conv", prompt: "hi" });
    expect(session.sessionId).toBe("caller-conv");
    expect(session.nativeSessionId).toBe("engine-session");
    await session.close();
  });

  it("steers through the prompt endpoint with delivery steer", async () => {
    const stream = sseResponse();
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "ses-1" } });
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "conv-3", prompt: "hi" });
    expect(await session.steer("more")).toBe("steered");
    const steer = fake.requests.find((request) => request.url.endsWith("/prompt") && (request.body as { delivery?: string }).delivery === "steer");
    expect(steer?.body).toEqual({ text: "more", delivery: "steer" });
    await session.close();
  });

  it("reads a 409 as a refusal and a network failure as indeterminate", async () => {
    const stream = sseResponse();
    let steerAnswer: "409" | "throw" = "409";
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "ses-1" } });
      if (request.url.endsWith("/prompt") && (request.body as { delivery?: string }).delivery === "steer") {
        if (steerAnswer === "throw") throw new Error("socket hang up");
        return textResponse(JSON.stringify({ _tag: "ConflictError", message: "busy" }), 409);
      }
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "conv-4", prompt: "hi" });
    expect(await session.steer("more")).toBe("refused");
    steerAnswer = "throw";
    expect(await session.steer("more")).toBe("indeterminate");
    await session.close();
  });

  it("interrupts with resume=true so pending steering input resumes", async () => {
    const stream = sseResponse();
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "ses-1" } });
      if (request.url.includes("/interrupt")) return jsonResponse({ interrupted: true });
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "conv-5", prompt: "hi" });
    await session.interrupt();
    expect(fake.requests.some((request) => request.url === `${BASE}/api/session/ses-1/interrupt?resume=true`)).toBe(true);
    await session.close();
  });

  it("answers a permission with the documented decision field", async () => {
    const stream = sseResponse();
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "ses-1" } });
      if (request.url.endsWith("/reply")) return new Response(null, { status: 204 });
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "conv-6", prompt: "hi" });
    stream.send("permission.asked", event("permission.asked", {
      id: "perm-1", sessionID: "ses-1", action: "bash", resources: ["rm -rf build"],
    }));
    const events = await collectUntil(session.events(), (event) => event.type === "approval.requested");
    expect(events).toContainEqual(expect.objectContaining({
      type: "approval.requested", requestId: "perm-1", choices: ["rm -rf build"],
    }));

    expect(await session.respondApproval("perm-1", { behavior: "allow", always: true })).toBe("allowed-once");
    expect(fake.requests.find((request) => request.url.endsWith("/reply"))!.body).toEqual({ decision: "always" });
  });

  it("reports a free-text answer unavailable, because the reply has no answer field", async () => {
    const stream = sseResponse();
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "ses-1" } });
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "conv-7", prompt: "hi" });
    expect(await session.respondApproval("perm-1", { behavior: "answer", message: "src" })).toBe("unavailable");
    expect(fake.requests.some((request) => request.url.endsWith("/reply"))).toBe(false);
    await session.close();
  });

  it("does not finish a step that ended with tool-calls", async () => {
    const stream = sseResponse();
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "ses-1" } });
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "conv-8", prompt: "hi" });
    stream.send("session.step.ended", event("session.step.ended", {
      sessionID: "ses-1", assistantMessageID: "a1", finish: "tool-calls", cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    stream.send("session.execution.succeeded", event("session.execution.succeeded", { sessionID: "ses-1" }));
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("reports a failed execution with the engine's error", async () => {
    const stream = sseResponse();
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "ses-1" } });
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "conv-9", prompt: "hi" });
    stream.send("session.execution.failed", event("session.execution.failed", {
      sessionID: "ses-1", error: { message: "provider refused" },
    }));
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: "provider refused" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: false }));
  });

  it("fails the turn when the stream ends without an outcome", async () => {
    const stream = sseResponse();
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "ses-1" } });
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "conv-10", prompt: "hi" });
    stream.end();
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: false }));
  });

  it("sends the bearer when the server requires one", async () => {
    const stream = sseResponse();
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "ses-1" } });
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch, token: "secret-token" });
    const session = await openCode.create({ sessionId: "conv-11", prompt: "hi" });
    expect(fake.requests[0]!.headers.authorization).toBe("Bearer secret-token");
    await session.close();
  });

  it("surfaces a create refusal as a typed HTTP error", async () => {
    const { adapter: openCode } = adapter(() => textResponse("boom", 500));
    const failure = await openCode.create({ sessionId: "conv-12", prompt: "hi" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentHttpError);
    expect(failure).toMatchObject({ status: 500 });
  });

  it("refuses attached images, because the V2 prompt body takes file references", async () => {
    const { fake, adapter: openCode } = adapter(() => jsonResponse({ data: { id: "ses-1" } }));
    await expect(openCode.create({
      sessionId: "conv-13",
      prompt: "look",
      images: [{ path: "/tmp/x.png", mime: "image/png" }],
    })).rejects.toThrow(/file references/);
    expect(fake.requests).toHaveLength(0);
  });

  it("cancels through interrupt and settles the turn locally", async () => {
    const stream = sseResponse();
    const fake = fakeFetch((request) => {
      if (request.url === `${BASE}/api/event`) return stream.response;
      if (request.url === `${BASE}/api/session`) return jsonResponse({ data: { id: "ses-1" } });
      if (request.url.includes("/interrupt")) return jsonResponse({ interrupted: true });
      return jsonResponse({ data: {} });
    });
    const openCode = new OpenCodeAdapter({ baseUrl: BASE, fetch: fake.fetch });
    const session = await openCode.create({ sessionId: "conv-14", prompt: "hi" });
    await session.cancel();
    expect(fake.requests.some((request) => request.url.includes("/interrupt"))).toBe(true);
    const events = await collectUntil(session.events(), (event) => event.type === "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true, stopReason: "cancelled" }));
  });
});
