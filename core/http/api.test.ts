import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHttpFixture, type HttpFixture } from "./testing/fixture.ts";
import { CommandError } from "../../packages/agent-protocol/commands.ts";
import { HostKeyConfirmationRequiredError } from "../environments/errors.ts";

const open: HttpFixture[] = [];

async function fixture(): Promise<HttpFixture> {
  const created = await createHttpFixture();
  open.push(created);
  return created;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

describe("authentication", () => {
  let f: HttpFixture;

  beforeEach(async () => {
    f = await fixture();
  });

  it("answers health without a session", async () => {
    const response = await f.request("/api/v1/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; version: string; cursor: number };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("test");
    expect(body.cursor).toBe(0);
  });

  it("refuses a route with no Authorization header", async () => {
    const response = await f.request("/api/v1/agents");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; details: { requestId: string } } };
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.details.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("refuses a token in the query string, because a URL is logged", async () => {
    const session = f.session();
    const response = await f.request(`/api/v1/agents?access_token=${session.token}`);
    expect(response.status).toBe(401);
  });

  it("refuses a bearer with the wrong scheme or an empty token", async () => {
    const session = f.session();
    expect((await f.request("/api/v1/agents", { headers: { authorization: `Basic ${session.token}` } })).status).toBe(401);
    expect((await f.request("/api/v1/agents", { headers: { authorization: "Bearer " } })).status).toBe(401);
  });

  it("refuses an unknown route with the same envelope", async () => {
    const session = f.session();
    const response = await f.request("/api/v1/nope", { token: session.token });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("names the method when the path exists but the method does not", async () => {
    const session = f.session();
    const response = await f.request("/api/v1/health", { method: "POST", token: session.token });
    expect(response.status).toBe(405);
  });

  it("does not leak which part of a token failed", async () => {
    const session = f.session();
    const tampered = `${session.token.slice(0, -4)}AAAA`;
    const response = await f.request("/api/v1/agents", { token: tampered });
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.message).not.toContain(tampered);
  });

  it("refuses a revoked device immediately", async () => {
    const session = f.session();
    expect((await f.request("/api/v1/agents", { token: session.token })).status).toBe(200);
    f.identity.revokeSession(session.session.id);
    expect((await f.request("/api/v1/agents", { token: session.token })).status).toBe(401);
  });

  it("echoes a well-formed request id and replaces a hostile one", async () => {
    const session = f.session();
    const echoed = await f.request("/api/v1/health", { headers: { "x-request-id": "abc-12345678" } });
    expect(echoed.headers.get("x-request-id")).toBe("abc-12345678");

    const replaced = await f.request("/api/v1/health", { headers: { "x-request-id": "bad id with spaces" } });
    expect(replaced.headers.get("x-request-id")).not.toBe("bad id with spaces");
    expect(replaced.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(session.token.length).toBeGreaterThan(0);
  });
});

describe("scopes", () => {
  let f: HttpFixture;

  beforeEach(async () => {
    f = await fixture();
  });

  it("lets readonly read and refuses it a mutation", async () => {
    const reader = f.session("readonly");
    expect((await f.request("/api/v1/agents", { token: reader.token })).status).toBe(200);
    const response = await f.request("/api/v1/missions/m1/steer", {
      method: "POST",
      token: reader.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "c1", expectedRevision: 1, input: "go" }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
    expect(f.missions.state.commands).toHaveLength(0);
  });

  it("refuses device the owner-only environment mutation", async () => {
    const device = f.session("device");
    const response = await f.request("/api/v1/environments", {
      method: "POST",
      token: device.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "box", host: "127.0.0.1", user: "me", hostKeyFingerprint: "SHA256:abc" }),
    });
    expect(response.status).toBe(403);
    expect(f.environments.created).toHaveLength(0);
  });

  it("lets owner create an environment and runs the port's check", async () => {
    const owner = f.session("owner");
    const created = await f.request("/api/v1/environments", {
      method: "POST",
      token: owner.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "box", host: "127.0.0.1", user: "me", hostKeyFingerprint: "SHA256:abc" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { environment: { id: string; status: string } };
    expect(body.environment.status).toBe("unknown");

    f.environments.checkResult = { reachable: false, detail: "connection refused" };
    const tested = await f.request(`/api/v1/environments/${body.environment.id}/test`, {
      method: "POST",
      token: owner.token,
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(tested.status).toBe(200);
    const checked = (await tested.json()) as { reachable: boolean; detail: string };
    expect(checked.reachable).toBe(false);
    expect(checked.detail).toBe("connection refused");

    const list = await f.request("/api/v1/environments", { token: owner.token });
    const listed = (await list.json()) as { environments: { lastTest?: { reachable: boolean } }[] };
    expect(listed.environments[0]?.lastTest?.reachable).toBe(false);
  });

  it("answers a failed create with the environment layer's own kind", async () => {
    const owner = f.session("owner");
    f.environments.createFailure = new HostKeyConfirmationRequiredError("box.example", ["SHA256:scanned"]);
    const response = await f.request("/api/v1/environments", {
      method: "POST",
      token: owner.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "box", host: "box.example", user: "me", hostKeyFingerprint: "SHA256:abc" }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("hostKeyConfirmationRequired");
    expect(f.environments.list()).toHaveLength(0);
  });

  it("refuses a test of an environment that does not exist", async () => {
    const owner = f.session("owner");
    const response = await f.request("/api/v1/environments/env-9/test", {
      method: "POST",
      token: owner.token,
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("removes the record and answers 204", async () => {
    const owner = f.session("owner");
    const created = await f.request("/api/v1/environments", {
      method: "POST",
      token: owner.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "box", host: "box.example", user: "me", hostKeyFingerprint: "SHA256:abc" }),
    });
    const body = (await created.json()) as { environment: { id: string } };
    const removed = await f.request(`/api/v1/environments/${body.environment.id}`, { method: "DELETE", token: owner.token });
    expect(removed.status).toBe(204);
    expect(f.environments.removed).toEqual([body.environment.id]);
    expect((await f.request("/api/v1/environments", { token: owner.token })).status).toBe(200);
  });

  it("refuses a secret field in an environment", async () => {
    const owner = f.session("owner");
    const response = await f.request("/api/v1/environments", {
      method: "POST",
      token: owner.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "box", host: "box.example", user: "me", hostKeyFingerprint: "SHA256:abc", privateKey: "-----BEGIN" }),
    });
    expect(response.status).toBe(400);
    expect(f.environments.created).toHaveLength(0);
  });

  it("refuses a create field the route does not read", async () => {
    const owner = f.session("owner");
    const response = await f.request("/api/v1/environments", {
      method: "POST",
      token: owner.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "box", host: "box.example", user: "me", hostKeyFingerprint: "SHA256:abc", password: "hunter2" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details: { fields: string[] } } };
    expect(body.error.details.fields).toEqual(["password"]);
    expect(f.environments.created).toHaveLength(0);
  });

  it("never echoes a secret a create carried", async () => {
    const owner = f.session("owner");
    const response = await f.request("/api/v1/environments", {
      method: "POST",
      token: owner.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "box", host: "box.example", user: "me", hostKeyFingerprint: "SHA256:abc", passphrase: "hunter2" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("hunter2");
  });
});

describe("pairing", () => {
  it("issues a session once and never again for the same code", async () => {
    const f = await fixture();
    const code = f.identity.issuePairingCode();
    const body = { code: code.code, label: "my phone" };

    const first = await f.request("/api/v1/pairing/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const issued = (await first.json()) as { token: string; session: { scope: string } };
    expect(issued.session.scope).toBe("device");
    expect((await f.request("/api/v1/agents", { token: issued.token })).status).toBe(200);

    const second = await f.request("/api/v1/pairing/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(401);
  });

  it("refuses an expired pairing code", async () => {
    const f = await fixture();
    const code = f.identity.issuePairingCode();
    f.clock.advance(11 * 60_000);
    const response = await f.request("/api/v1/pairing/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.code, label: "late" }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("pairing_expired");
  });

  it("clamps a non-loopback pairing to the device scope", async () => {
    const f = await fixture();
    const code = f.identity.issuePairingCode();
    const issued = f.identity.pair({ code: code.code, label: "remote", loopback: false, requestedScope: "device" });
    expect(issued.session.scope).toBe("device");
  });

  it("refuses owner to a non-loopback pairing", async () => {
    const f = await fixture();
    const code = f.identity.issuePairingCode();
    expect(() => f.identity.pair({ code: code.code, label: "remote", loopback: false, requestedScope: "owner" })).toThrow(
      /loopback/u,
    );
  });

  it("requires a content-type before reading a pairing body", async () => {
    const f = await fixture();
    const response = await f.request("/api/v1/pairing/claim", { method: "POST", body: "code=x" });
    expect(response.status).toBe(415);
  });
});

describe("body limits and content type", () => {
  let f: HttpFixture;

  beforeEach(async () => {
    f = await fixture();
  });

  it("refuses a body over the limit before buffering it", async () => {
    const session = f.session();
    const response = await f.request("/api/v1/missions", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "c1", title: "t", prompt: "x".repeat(70_000), agent: "hermes", environment: env() }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string; details: { maxBytes: number } } };
    expect(body.error.code).toBe("payload_too_large");
    expect(body.error.details.maxBytes).toBe(64 * 1024);
    expect(f.missions.state.commands).toHaveLength(0);
  });

  it("refuses a form-encoded body", async () => {
    const session = f.session();
    const response = await f.request("/api/v1/missions", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "commandId=c1",
    });
    expect(response.status).toBe(415);
  });

  it("refuses invalid JSON and an unknown field", async () => {
    const session = f.session();
    const invalid = await f.request("/api/v1/missions", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(invalid.status).toBe(400);

    const unknown = await f.request("/api/v1/missions", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "c1", title: "t", prompt: "p", agent: "hermes", environment: env(), extra: 1 }),
    });
    expect(unknown.status).toBe(400);
    const body = (await unknown.json()) as { error: { details: { fields: string[] } } };
    expect(body.error.details.fields).toEqual(["extra"]);
  });
});

describe("missions delegate to the authority", () => {
  let f: HttpFixture;

  beforeEach(async () => {
    f = await fixture();
  });

  it("creates a mission through execute and answers 201 once", async () => {
    const session = f.session();
    const payload = { commandId: "create-1", title: "t", prompt: "p", agent: "hermes", environment: env() };

    const first = await f.request("/api/v1/missions", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);

    const replay = await f.request("/api/v1/missions", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(replay.status).toBe(200);
    expect(f.missions.attempts).toHaveLength(2);
    expect(f.missions.state.commands).toHaveLength(1);
    const body = (await replay.json()) as { replayed: boolean };
    expect(body.replayed).toBe(true);
  });

  it("takes the mission id from the path, not from the body", async () => {
    const session = f.session();
    const response = await f.request("/api/v1/missions/from-path/interrupt", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "c1", expectedRevision: 1, missionId: "from-body" }),
    });
    expect(response.status).toBe(400);
    expect(f.missions.state.commands).toHaveLength(0);
  });

  it("maps a revision conflict to 409 with the current revision", async () => {
    const session = f.session();
    f.missions.failWith = new CommandError("revision_conflict", "mission moved on", 7);
    const response = await f.request("/api/v1/missions/m1/interrupt", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "c1", expectedRevision: 3 }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; details: { currentRevision: number } } };
    expect(body.error.code).toBe("revision_conflict");
    expect(body.error.details.currentRevision).toBe(7);
  });

  it("maps an unknown mission to 404 and hides an internal failure", async () => {
    const session = f.session();
    f.missions.failWith = new CommandError("not_found", "no mission m1");
    expect(
      (
        await f.request("/api/v1/missions/m1/steer", {
          method: "POST",
          token: session.token,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId: "c1", expectedRevision: 1, input: "x" }),
        })
      ).status,
    ).toBe(404);

    f.missions.failWith = new Error("a path leaked: /home/me/.ssh/id_ed25519");
    const internal = await f.request("/api/v1/missions/m1/steer", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "c1", expectedRevision: 1, input: "x" }),
    });
    expect(internal.status).toBe(500);
    const text = await internal.text();
    expect(text).not.toContain("id_ed25519");
    expect(JSON.parse(text).error.code).toBe("internal_error");
  });

  it("resolves an approval with the path's approval id", async () => {
    const session = f.session();
    const response = await f.request("/api/v1/missions/m1/approvals/a1/resolve", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "c1", expectedRevision: 1, decision: "allow" }),
    });
    expect(response.status).toBe(200);
    const command = f.missions.state.commands[0] as { approvalId: string; decision: string };
    expect(command.approvalId).toBe("a1");
    expect(command.decision).toBe("allow");
  });

  it("refuses an agent the protocol does not name", async () => {
    const session = f.session();
    const response = await f.request("/api/v1/missions", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "c1", title: "t", prompt: "p", agent: "notAnAgent", environment: env() }),
    });
    expect(response.status).toBe(400);
  });

  it("lists agents and reports a missing catalog as unreported", async () => {
    const session = f.session();
    const hermes = await f.request("/api/v1/agents/hermes/models", { token: session.token });
    const hermesBody = (await hermes.json()) as { reported: boolean; models: unknown[] };
    expect(hermesBody.reported).toBe(true);
    expect(hermesBody.models).toHaveLength(1);

    const custom = await f.request("/api/v1/agents/custom/models", { token: session.token });
    const customBody = (await custom.json()) as { reported: boolean };
    expect(customBody.reported).toBe(false);

    const missing = await f.request("/api/v1/agents/codex", { token: session.token });
    expect(missing.status).toBe(404);
  });

  it("answers a mission tree and history from the store", async () => {
    const session = f.session();
    expect((await f.request("/api/v1/missions/m1/tree", { token: session.token })).status).toBe(404);

    f.missions.state.missions.set("m1", mission("m1"));
    f.missions.state.events.set("m1", [
      { seq: 1, eventId: "e1", missionId: "m1", at: "2026-01-01T00:00:00.000Z", source: "authority", type: "mission.accepted", payload: {} },
    ]);
    const history = await f.request("/api/v1/missions/m1/history", { token: session.token });
    expect(history.status).toBe(200);
    const body = (await history.json()) as { events: unknown[]; nextSeq: number };
    expect(body.events).toHaveLength(1);
    expect(body.nextSeq).toBe(1);
  });
});

describe("security headers and CORS", () => {
  it("sets no-store and the hardening headers on a success and an error", async () => {
    const f = await fixture();
    for (const path of ["/api/v1/health", "/api/v1/nope"]) {
      const response = await f.request(path);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("refuses a cross-origin request when CORS is off", async () => {
    const f = await fixture();
    const response = await f.request("/api/v1/health", { headers: { origin: "https://evil.example" } });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden_origin");
  });

  it("accepts the same Host with an Origin header, as a module script sends", async () => {
    const f = await fixture();
    const response = await f.request("/api/v1/health", { headers: { origin: f.base } });
    expect(response.status).toBe(200);
  });

  it("answers a preflight and grants only a listed origin when CORS is on", async () => {
    const f = await createHttpFixture({ cors: { enabled: true, allowedOrigins: ["http://localhost:5173"] } });
    try {
      const preflight = await fetch(`${f.base}/api/v1/agents`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");

      const allowed = await f.request("/api/v1/health", { headers: { origin: "http://localhost:5173" } });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

      const refused = await f.request("/api/v1/health", { headers: { origin: "https://evil.example" } });
      expect(refused.status).toBe(403);
    } finally {
      await f.close();
    }
  });
});

describe("starting an agent terminal", () => {
  it("starts the native TUI on a named computer and returns a separate terminal id", async () => {
    const f = await fixture();
    const session = f.session();
    const response = await f.request("/api/v1/terminals", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentId: "env-1", tool: "hermes", missionId: "m1", runId: "r1", cols: 120, rows: 30 }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { terminal: { id: string; kind: string; missionId: string } };
    expect(body.terminal.kind).toBe("nativeTui");
    expect(body.terminal.missionId).toBe("m1");
    expect(body.terminal.id).not.toBe("r1");
  });

  it("refuses an unknown tool before a terminal exists", async () => {
    const f = await fixture();
    const session = f.session();
    const response = await f.request("/api/v1/terminals", {
      method: "POST",
      token: session.token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentId: "env-1", tool: "not-an-agent" }),
    });
    expect(response.status).toBe(400);
  });
});

function env(): Record<string, unknown> {
  return { id: "env-1", label: "box", kind: "ssh", authMode: "subscription" };
}

function mission(id: string) {
  return {
    protocolVersion: 1 as const,
    id,
    rootMissionId: id,
    depth: 0,
    title: "t",
    prompt: "p",
    agent: "hermes" as const,
    environment: { id: "env-1", label: "box", kind: "ssh" as const, authMode: "subscription" as const },
    status: "running" as const,
    revision: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acceptedAt: "2026-01-01T00:00:00.000Z",
    runIds: [],
    childIds: [],
    artifactIds: [],
    approvalIds: [],
    wakeGeneration: 0,
  };
}
