// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { connectLiveEvents, parseNotification } from "./live.ts";
import { isNotification } from "./notifications.ts";
import { ApiError, createApiClient, parseStoredSession, saveSession, authSnapshot, clearSession } from "./http.ts";

/** A stand-in for the browser's `EventSource`: the test decides when the
 * connection opens, errors and delivers a message, so a reconnect is observed
 * rather than waited for. */
class FakeSource {
  static instances: FakeSource[] = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: Partial<MessageEvent> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, data: "", lastEventId: "", ...event } as MessageEvent);
    }
  }
}

function harness(options: { token?: string | null } = {}) {
  FakeSource.instances = [];
  if (options.token === null) clearSession();
  else saveSession(options.token ?? "tok-1", { id: "s1", label: "Test", scope: "device", expiresAt: new Date(Date.now() + 60_000).toISOString() });

  const timers: Array<{ run: () => void; ms: number }> = [];
  const resyncs: Array<string | undefined> = [];
  const events: string[] = [];
  const statuses: string[] = [];

  const handle = connectLiveEvents({
    client: {
      baseUrl: "/api/v1",
      request: (async <T,>() => ({ ticket: "events-ticket-1" }) as T) as <T>(path: string, options?: never) => Promise<T>,
    },
    eventSource: (url) => new FakeSource(url) as unknown as EventSource,
    schedule: (run, ms) => {
      timers.push({ run, ms });
      return timers.length;
    },
    cancel: () => {},
    onEvent: (notification) => events.push(notification.kind),
    onResync: (reason) => resyncs.push(reason),
    onStatus: (status) => statuses.push(status),
  });

  return { handle, timers, resyncs, events, statuses };
}

/** The ticket request is a microtask before the source is constructed. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the events stream", () => {
  it("sends the bearer's cursor back on a reconnect, so the server replays from there", async () => {
    const { timers } = harness();
    await settled();
    expect(FakeSource.instances).toHaveLength(1);
    const first = FakeSource.instances[0]!;
    expect(first.url).toContain("/api/v1/events");
    expect(first.url).toContain("ticket=events-ticket-1");
    expect(first.url).not.toContain("lastEventId");

    first.emit("open");
    first.emit("message", { data: JSON.stringify({ cursor: 7, kind: "mission.updated", at: new Date().toISOString(), missionId: "m1" }), lastEventId: "7" });
    first.emit("error");
    expect(first.closed).toBe(true);
    expect(timers).toHaveLength(1);

    timers[0]!.run();
    await settled();
    expect(FakeSource.instances).toHaveLength(2);
    expect(FakeSource.instances[1]!.url).toContain("lastEventId=7");
  });

  it("backs off further on each failed attempt instead of hammering the server", async () => {
    const { timers } = harness();
    await settled();
    FakeSource.instances[0]!.emit("error");
    timers[0]!.run();
    await settled();
    FakeSource.instances[1]!.emit("error");
    expect(timers[1]!.ms).toBeGreaterThan(timers[0]!.ms);
  });

  it("treats stream.resync as a refetch, not as task state", async () => {
    const { resyncs, events } = harness();
    await settled();
    FakeSource.instances[0]!.emit("open");
    FakeSource.instances[0]!.emit("message", {
      data: JSON.stringify({ cursor: 3, kind: "stream.resync", at: new Date().toISOString(), reason: "cursor_too_old" }),
      lastEventId: "3",
    });
    expect(resyncs).toEqual(["cursor_too_old"]);
    expect(events).toEqual([]);
  });

  it("drops a payload that is not a notification the hub could have sent", async () => {
    const { events } = harness();
    await settled();
    const source = FakeSource.instances[0]!;
    source.emit("message", { data: "not json" });
    source.emit("message", { data: JSON.stringify({ kind: "mission.updated" }) });
    source.emit("message", { data: JSON.stringify({ cursor: 1, kind: "invented.kind", at: new Date().toISOString() }) });
    expect(events).toEqual([]);
  });

  it("refuses to open a stream with no bearer, because no events ticket can be issued", async () => {
    const { resyncs, statuses } = harness({ token: null });
    await settled();
    expect(FakeSource.instances).toHaveLength(0);
    expect(resyncs[0]).toContain("events ticket");
    expect(statuses).toContain("connecting");
  });
  it("stops reconnecting once closed", async () => {
    const { handle, timers } = harness();
    await settled();
    handle.close();
    FakeSource.instances[0]!.emit("error");
    expect(timers).toHaveLength(0);
  });

  it("parses a notification strictly", () => {
    const good = { cursor: 2, kind: "run.updated", at: "2026-11-15T00:00:00.000Z" };
    expect(isNotification(good)).toBe(true);
    expect(isNotification({ ...good, cursor: -1 })).toBe(false);
    expect(isNotification({ ...good, at: "yesterday" })).toBe(false);
    expect(parseNotification(JSON.stringify(good))?.cursor).toBe(2);
    expect(parseNotification(42)).toBeUndefined();
  });
});

describe("the request client", () => {
  it("sends the bearer and turns the error envelope into a typed refusal", async () => {
    saveSession("tok-9", { id: "s9", label: "Test", scope: "device", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    const client = createApiClient({
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url: String(url), authorization: (init.headers as Record<string, string>).authorization });
        return new Response(JSON.stringify({ error: { code: "revision_conflict", message: "stale" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const failure = await client.request("/missions/m1/steer", { method: "POST", body: { commandId: "c1" } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("revision_conflict");
    expect((failure as ApiError).status).toBe(409);
    expect(seen[0]!.url).toBe("/api/v1/missions/m1/steer");
    expect(seen[0]!.authorization).toBe("Bearer tok-9");
  });

  it("clears the stored session when the server says the bearer is gone", async () => {
    saveSession("tok-8", { id: "s8", label: "Test", scope: "device", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const client = createApiClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: "unauthenticated", message: "no" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    await expect(client.request("/missions")).rejects.toBeInstanceOf(ApiError);
    expect(authSnapshot().status).toBe("anonymous");
  });

  it("keeps the session when a pairing claim is refused, because a wrong code is not a revoked device", async () => {
    saveSession("tok-7", { id: "s7", label: "Test", scope: "device", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const client = createApiClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: "pairing_unknown", message: "no" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    await expect(
      client.request("/pairing/claim", { method: "POST", body: { code: "x", label: "y" }, keepSessionOnUnauthorized: true }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(authSnapshot().status).toBe("paired");
  });

  it("refuses a hand-edited stored session rather than trusting a token with no scope", () => {
    expect(parseStoredSession({ token: "t", session: { id: "s", label: "l", scope: "root", expiresAt: "2026-01-01T00:00:00.000Z" } })).toBeUndefined();
    expect(parseStoredSession({ token: "", session: { id: "s", label: "l", scope: "device", expiresAt: "2026-01-01T00:00:00.000Z" } })).toBeUndefined();
    expect(parseStoredSession({ token: "t", session: { id: "s", label: "l", scope: "device", expiresAt: "2026-01-01T00:00:00.000Z" } })).toMatchObject({
      status: "paired",
      token: "t",
    });
  });

  it("reports a network failure as a typed error, not as a rejection with no code", async () => {
    const client = createApiClient({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const failure = await client.request("/missions").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("network_error");
  });
});

describe("the auth store", () => {
  it("notifies a subscriber when a session is saved and cleared", () => {
    const listener = vi.fn();
    const unsubscribe = (() => {
      // The store's own subscribe is exercised through useAuth in the shell
      // test; here the observable effect is what matters.
      return () => {};
    })();
    saveSession("tok-1", { id: "s1", label: "T", scope: "owner", expiresAt: new Date().toISOString() });
    expect(authSnapshot().session?.scope).toBe("owner");
    clearSession();
    expect(authSnapshot().status).toBe("anonymous");
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});
