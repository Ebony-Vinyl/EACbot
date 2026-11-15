import { afterEach, describe, expect, it } from "vitest";

import { createHttpFixture, type HttpFixture } from "./testing/fixture.ts";

const open: HttpFixture[] = [];

async function fixture(options?: Parameters<typeof createHttpFixture>[0]): Promise<HttpFixture> {
  const created = await createHttpFixture(options);
  open.push(created);
  return created;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

describe("event stream", () => {
  it("refuses a ticket that is missing, unknown or replayed", async () => {
    const f = await fixture();
    expect((await f.request("/api/v1/events")).status).toBe(401);

    const session = f.session();
    const issued = f.identity.issueTicket({ sessionId: session.session.id, scope: "device" }, "events");
    const first = await fetch(`${f.base}/api/v1/events?ticket=${issued.ticket}`);
    expect(first.status).toBe(200);
    await first.body?.cancel();

    const replay = await fetch(`${f.base}/api/v1/events?ticket=${issued.ticket}`);
    expect(replay.status).toBe(401);
    const body = (await replay.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ticket_used");
  });

  it("refuses a terminal ticket on the events path", async () => {
    const f = await fixture();
    const session = f.session();
    const issued = f.identity.issueTicket({ sessionId: session.session.id, scope: "device" }, "terminal", "term-1");
    const response = await fetch(`${f.base}/api/v1/events?ticket=${issued.ticket}`);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ticket_purpose_mismatch");
  });

  it("refuses an expired ticket", async () => {
    const f = await fixture();
    const session = f.session();
    const issued = f.identity.issueTicket({ sessionId: session.session.id, scope: "device" }, "events");
    f.clock.advance(60_000);
    const response = await fetch(`${f.base}/api/v1/events?ticket=${issued.ticket}`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ticket_expired");
  });

  it("streams a notification with its cursor as the SSE id", async () => {
    const f = await fixture();
    const session = f.session();
    const reading = f.readEvents("/api/v1/events", session.token, {
      until: (text) => text.includes("mission.updated"),
    });
    await waitFor(() => f.composed.events.listenerCount === 1);
    f.composed.publish({ kind: "mission.updated", missionId: "m1", revision: 3 });
    const text = await reading;
    expect(text).toContain("retry: 3000");
    expect(text).toContain("id: 1");
    expect(text).toContain("event: mission.updated");
    expect(text).toContain('"missionId":"m1"');
    expect(text).toContain('"revision":3');
  });

  it("replays from Last-Event-ID so a reconnect loses nothing", async () => {
    const f = await fixture();
    const session = f.session();
    f.composed.publish({ kind: "mission.updated", missionId: "m1" });
    f.composed.publish({ kind: "mission.updated", missionId: "m2" });
    f.composed.publish({ kind: "mission.updated", missionId: "m3" });

    const text = await f.readEvents("/api/v1/events", session.token, {
      headers: { "last-event-id": "1" },
      until: (body) => body.includes('"missionId":"m3"'),
    });
    expect(text).not.toContain('"missionId":"m1"');
    expect(text).toContain('"missionId":"m2"');
    expect(text).toContain('"missionId":"m3"');
  });

  it("sends one resync event when the cursor is older than the window", async () => {
    const f = await fixture({ replayLimit: 2 });
    const session = f.session();
    for (let index = 0; index < 6; index += 1) f.composed.publish({ kind: "mission.updated", missionId: `m${index}` });

    const text = await f.readEvents("/api/v1/events", session.token, {
      headers: { "last-event-id": "1" },
      until: (body) => body.includes("stream.resync"),
    });
    expect(text).toContain("event: stream.resync");
    expect(text).toContain('"reason":"cursor_too_old"');
    expect(text).toContain("id: 6");
    expect(text).not.toContain("event: mission.updated");
  });

  it("resyncs on a malformed Last-Event-ID instead of guessing a position", async () => {
    const f = await fixture();
    const session = f.session();
    f.composed.publish({ kind: "mission.updated" });
    const text = await f.readEvents("/api/v1/events", session.token, {
      headers: { "last-event-id": "garbage" },
      until: (body) => body.includes("stream.resync"),
    });
    expect(text).toContain("event: stream.resync");
  });

  it("tells every stream the server is going before it closes", async () => {
    const f = await fixture();
    const session = f.session();
    const reading = f.readEvents("/api/v1/events", session.token, {
      until: (text) => text.includes("server.shutdown"),
    });
    await waitFor(() => f.composed.events.listenerCount === 1);
    await f.composed.shutdown();
    const text = await reading;
    expect(text).toContain("event: server.shutdown");
    expect(f.composed.events.listenerCount).toBe(0);
  });

  it("stops delivering after the client disconnects", async () => {
    const f = await fixture();
    const session = f.session();
    const controller = new AbortController();
    const reading = f.readEvents("/api/v1/events", session.token, {
      signal: controller.signal,
      until: () => false,
    });
    await waitFor(() => f.composed.events.listenerCount === 1);
    controller.abort();
    await reading;
    await waitFor(() => f.composed.events.listenerCount === 0);
    await waitFor(() => f.composed.layer.streams.size === 0);
    expect(f.composed.layer.streams.size).toBe(0);
  });
});

describe("terminal stream", () => {
  it("hands a ticket-authenticated upgrade to the abstract handler", async () => {
    const f = await fixture();
    const session = f.session();
    const issued = f.identity.issueTicket({ sessionId: session.session.id, scope: "device" }, "terminal", "term-1");

    const socket = await upgrade(f.base, `/api/v1/terminals/term-1/stream?ticket=${issued.ticket}`);
    expect(socket.response).toContain("101 Switching Protocols");
    expect(socket.response).toContain("sec-websocket-accept:");

    await waitFor(() => f.streams.opened.length === 1);
    expect(f.streams.opened[0]).toMatchObject({ terminalId: "term-1", scope: "device" });
    socket.close();
    await waitFor(() => f.streams.streams[0]?.closed === true);
    expect(f.composed.layer.streams.size).toBe(0);
  });

  it("refuses a ticket bound to another terminal", async () => {
    const f = await fixture();
    const session = f.session();
    const issued = f.identity.issueTicket({ sessionId: session.session.id, scope: "device" }, "terminal", "term-1");
    const response = await upgrade(f.base, `/api/v1/terminals/term-2/stream?ticket=${issued.ticket}`);
    expect(response.response).toContain("404");
    expect(f.streams.opened).toHaveLength(0);
  });

  it("refuses a plain GET on the upgrade path", async () => {
    const f = await fixture();
    const session = f.session();
    const response = await f.request("/api/v1/terminals/term-1/stream", { token: session.token });
    expect(response.status).toBe(404);
  });

  it("issues a ticket only for a terminal that exists", async () => {
    const f = await fixture();
    const session = f.session();
    expect(
      (
        await f.request("/api/v1/terminals/term-1/ticket", {
          method: "POST",
          token: session.token,
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await f.request("/api/v1/terminals/term-9/ticket", {
          method: "POST",
          token: session.token,
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  });

  it("refuses a readonly session the terminal ticket", async () => {
    const f = await fixture();
    const reader = f.session("readonly");
    const response = await f.request("/api/v1/terminals/term-1/ticket", {
      method: "POST",
      token: reader.token,
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });
});

describe("graceful shutdown", () => {
  it("closes the open streams and the listener", async () => {
    const f = await createHttpFixture();
    const session = f.session();
    const reading = f.readEvents("/api/v1/events", session.token, { until: (text) => text.includes("server.shutdown") });
    await waitFor(() => f.composed.events.listenerCount === 1);

    await f.composed.shutdown();
    const text = await reading;
    expect(text).toContain("event: server.shutdown");
    expect(f.composed.layer.streams.size).toBe(0);

    await expect(fetch(`${f.base}/api/v1/health`)).rejects.toThrow();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A raw WebSocket handshake, so the test sees the exact 101 or refusal a
 * browser would. */
async function upgrade(base: string, path: string): Promise<{ response: string; close: () => void }> {
  const { connect } = await import("node:net");
  const url = new URL(base);
  const socket = connect(Number(url.port), url.hostname);
  const response = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (buffer.includes("\r\n\r\n")) resolve(buffer);
    });
    socket.on("error", reject);
    socket.write(
      [
        `GET ${path} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
  });
  return { response, close: () => socket.destroy() };
}
