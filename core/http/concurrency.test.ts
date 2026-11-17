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

const environment = { id: "env-1", label: "box", kind: "ssh", authMode: "subscription" };

describe("concurrent commands", () => {
  it("applies one command id once when the same request arrives twice at once", async () => {
    const f = await fixture();
    const session = f.session();
    const payload = JSON.stringify({ commandId: "same", title: "t", prompt: "p", agent: "hermes", environment });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        f.request("/api/v1/missions", {
          method: "POST",
          token: session.token,
          headers: { "content-type": "application/json" },
          body: payload,
        }),
      ),
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200)).toHaveLength(4);
    expect(f.missions.state.commands).toHaveLength(1);
    expect(f.composed.events.cursor).toBe(5);
  });

  it("keeps distinct command ids distinct", async () => {
    const f = await fixture();
    const session = f.session();
    await Promise.all(
      ["a", "b", "c"].map((commandId) =>
        f.request("/api/v1/missions", {
          method: "POST",
          token: session.token,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId, title: "t", prompt: "p", agent: "hermes", environment }),
        }),
      ),
    );
    expect(f.missions.state.commands.map((command) => command.commandId).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("event stream reconnect", () => {
  it("sends nothing before the first notification, then resumes exactly where the client was", async () => {
    const f = await fixture();
    const session = f.session();

    const first = f.readEvents("/api/v1/events", session.token, {
      until: (text) => text.includes('"missionId":"m2"'),
    });
    await waitFor(() => f.composed.events.listenerCount === 1);
    f.composed.publish({ kind: "mission.updated", missionId: "m1" });
    f.composed.publish({ kind: "mission.updated", missionId: "m2" });
    const firstText = await first;
    expect(firstText).toContain("id: 1");
    expect(firstText).toContain("id: 2");

    const second = f.readEvents("/api/v1/events", session.token, {
      headers: { "last-event-id": "2" },
      until: (text) => text.includes('"missionId":"m3"'),
    });
    await waitFor(() => f.composed.events.listenerCount === 1);
    f.composed.publish({ kind: "mission.updated", missionId: "m3" });
    const secondText = await second;
    expect(secondText).not.toContain('"missionId":"m1"');
    expect(secondText).not.toContain('"missionId":"m2"');
    expect(secondText).toContain("id: 3");
  });

  it("treats a cursor at the current position as up to date rather than a gap", async () => {
    const f = await fixture();
    const session = f.session();
    f.composed.publish({ kind: "mission.updated", missionId: "m1" });

    const reading = f.readEvents("/api/v1/events", session.token, {
      headers: { "last-event-id": "1" },
      until: (body) => body.includes('"missionId":"m2"'),
    });
    await waitFor(() => f.composed.events.listenerCount === 1);
    f.composed.publish({ kind: "mission.updated", missionId: "m2" });
    const text = await reading;
    expect(text).not.toContain("stream.resync");
    expect(text).not.toContain('"missionId":"m1"');
    expect(text).toContain("id: 2");
  });

  it("refuses a revoked session on the stream path", async () => {
    const f = await fixture();
    const session = f.session();
    f.identity.revokeSession(session.session.id);
    const response = await fetch(`${f.base}/api/v1/events`, { headers: { authorization: `Bearer ${session.token}` } });
    expect(response.status).toBe(401);
  });

  it("refuses a ticket issued for a revoked session, because the ticket dies with it", async () => {
    const f = await fixture();
    const session = f.session();
    const issued = f.identity.issueTicket({ sessionId: session.session.id, scope: "device" }, "events");
    f.identity.revokeSession(session.session.id);
    const response = await fetch(`${f.base}/api/v1/events?ticket=${issued.ticket}`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("session_revoked");
  });
});

describe("session management", () => {
  it("lists sessions without a token and revokes one", async () => {
    const f = await fixture();
    const session = f.session();
    const listed = await f.request("/api/v1/sessions", { token: session.token });
    const body = (await listed.json()) as { sessions: { id: string; scope: string }[] };
    expect(body.sessions).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(session.token);

    const revoked = await f.request(`/api/v1/sessions/${session.session.id}`, { method: "DELETE", token: session.token });
    expect(revoked.status).toBe(204);
    expect((await f.request("/api/v1/agents", { token: session.token })).status).toBe(401);
  });

  it("refuses revoke-all to a device session and allows owner", async () => {
    const f = await fixture();
    const device = f.session("device");
    const owner = f.session("owner");
    expect((await f.request("/api/v1/sessions/revoke-all", { method: "POST", token: device.token })).status).toBe(403);
    expect((await f.request("/api/v1/sessions/revoke-all", { method: "POST", token: owner.token })).status).toBe(204);
    expect((await f.request("/api/v1/agents", { token: device.token })).status).toBe(401);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
