import { describe, expect, it } from "vitest";

import { parseActionResult, parseCapabilityCall } from "./rpc.ts";
import { parseDomainEvent } from "./events.ts";

const call = () => ({
  requestId: "req-1",
  traceId: "trace-1",
  capability: "music.playback.control",
  version: "1.0.0",
  arguments: { action: "play" },
  context: {
    workspaceId: "ws-1",
    installationId: "plg_1",
    botId: "bot-1",
    principalRef: "owner-1",
    audienceRef: "private-owner-1",
    grantRef: "grant-1",
    authorizationEpoch: 1,
  },
  deadline: "2026-11-07T01:00:00.000Z",
});

describe("plugin wire contracts", () => {
  it("accepts a capability call with host-injected context", () => {
    expect(parseCapabilityCall(call()).ok).toBe(true);
  });

  it("rejects a call that tries to add an unknown identity field", () => {
    expect(parseCapabilityCall({ ...call(), context: { ...call().context, owner: true } })).toMatchObject({ ok: false });
  });

  it("distinguishes success, failure, cancellation and an indeterminate effect", () => {
    expect(parseActionResult({ status: "succeeded", value: { playing: true } }).ok).toBe(true);
    expect(parseActionResult({ status: "failed", code: "UPSTREAM_UNAVAILABLE", message: "offline", retryable: true }).ok).toBe(true);
    expect(parseActionResult({ status: "cancelled", reason: "user stopped" }).ok).toBe(true);
    expect(parseActionResult({ status: "indeterminate", operationId: "op-1", verification: "pending" }).ok).toBe(true);
    expect(parseActionResult({ status: "ok", value: true }).ok).toBe(false);
  });

  it("requires an explicit verification state for indeterminate results", () => {
    expect(parseActionResult({ status: "indeterminate", operationId: "op-1" }).ok).toBe(false);
  });

  it("rejects events without a producer, scope or sequence", () => {
    const event = {
      eventId: "evt-1",
      schemaVersion: 1,
      type: "music.playback.started",
      occurredAt: "2026-11-07T01:00:00.000Z",
      producerInstallationId: "plg_1",
      workspaceId: "ws-1",
      traceId: "trace-1",
      streamId: "music:player-1",
      sequence: 1,
      payloadRef: "events/evt-1.json",
    };
    expect(parseDomainEvent(event).ok).toBe(true);
    expect(parseDomainEvent({ ...event, producerInstallationId: undefined }).ok).toBe(false);
    expect(parseDomainEvent({ ...event, sequence: -1 }).ok).toBe(false);
    expect(parseDomainEvent({ ...event, type: "Music Playback" }).ok).toBe(false);
  });
});
