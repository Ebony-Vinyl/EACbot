import { describe, expect, it } from "vitest";

import { AGENT_KINDS, CAPABILITY_NAMES, canSteer, type AgentCapabilities } from "../../packages/agent-protocol/agents.ts";
import { AGENT_REGISTRY } from "../agents/registry.ts";
import { coreAgentId } from "./bridge.ts";
import {
  assertAdapterEvent,
  assertEnvironmentRef,
  assertNoSecretFields,
  findSecretFields,
  isAdapterEvent,
  isTerminalStatusSignal,
} from "../../packages/agent-protocol/guards.ts";
import { PROTOCOL_VERSION } from "../../packages/agent-protocol/version.ts";
import { capabilitiesFor } from "./capabilities.ts";
import { environment } from "./fixture.ts";

const event = (overrides: Record<string, unknown> = {}) => ({
  source: "adapter" as const,
  type: "run.completed" as const,
  eventId: "evt-1",
  seq: 1,
  missionId: "m-1",
  runId: "r-1",
  at: "2026-01-01T00:00:01.000Z",
  outcome: "succeeded" as const,
  ...overrides,
});

describe("the wire contract", () => {
  it("pins protocol version 1 and every agent kind", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(AGENT_KINDS).toEqual(["hermes", "claudeCode", "codex", "openCode", "pi", "ohMyPi", "custom"]);
  });

  it("declares all ten capabilities for every kind", () => {
    for (const kind of AGENT_KINDS) {
      const capabilities: AgentCapabilities = capabilitiesFor(kind);
      expect(Object.keys(capabilities).sort()).toEqual([...CAPABILITY_NAMES].sort());
      expect(capabilities.events).toBe(true);
    }
  });

  it("reports each engine's steer mode instead of a bare yes/no", () => {
    expect(capabilitiesFor("hermes").steer.kind).toBe("next-boundary");
    expect(capabilitiesFor("codex").steer.kind).toBe("native");
    expect(capabilitiesFor("custom").steer.kind).toBe("none");
    expect(canSteer(capabilitiesFor("custom"))).toBe(false);
    expect(canSteer(capabilitiesFor("hermes"))).toBe(true);
  });

  it("matches core/agents on the capabilities both describe", () => {
    for (const kind of AGENT_KINDS) {
      const ours = capabilitiesFor(kind);
      const theirs = AGENT_REGISTRY[coreAgentId(kind)].capabilities;
      expect(ours.steer.kind, kind).toBe(theirs.steer.kind);
      expect(ours.interrupt, kind).toBe(theirs.interrupt);
      expect(ours.resume, kind).toBe(theirs.resume);
      expect(ours.cancel, kind).toBe(theirs.cancel);
      expect(ours.approval, kind).toBe(theirs.approvals);
      expect(ours.questions, kind).toBe(theirs.questions);
      expect(ours.images, kind).toBe(theirs.images);
      expect(ours.usage, kind).toBe(theirs.usage);
      expect(ours.nativeTui, kind).toBe(theirs.nativeTui);
    }
  });

  it("rejects a terminal status signal as an adapter event", () => {
    const terminal = { kind: "terminal.status", terminalId: "t-1", state: "exited", at: "2026-01-01T00:00:01.000Z", source: "osc7501" };
    expect(isTerminalStatusSignal(terminal)).toBe(true);
    expect(isAdapterEvent(terminal)).toBe(false);
    expect(() => assertAdapterEvent(terminal)).toThrow(/not an adapter event/);
  });

  it("rejects an adapter event missing its envelope", () => {
    expect(isAdapterEvent({ type: "run.completed" })).toBe(false);
    expect(() => assertAdapterEvent(event({ seq: 0 }))).toThrow(/seq/);
    expect(() => assertAdapterEvent(event({ missionId: "" }))).toThrow(/missionId/);
    expect(() => assertAdapterEvent(event({ at: "not a date" }))).toThrow(/timestamp/);
    expect(() => assertAdapterEvent(event({ type: "terminal.status" }))).toThrow(/unknown type/);
  });

  it("accepts a well-formed adapter event", () => {
    expect(isAdapterEvent(event())).toBe(true);
    expect(() => assertAdapterEvent(event())).not.toThrow();
  });

  it("finds secret fields anywhere in a nested environment reference", () => {
    const ref = { ...environment(), nested: { deeper: [{ privateKey: "-----BEGIN" }] }, token: "abc" };
    expect(findSecretFields(ref).sort()).toEqual(["nested.deeper[0].privateKey", "token"]);
    expect(() => assertNoSecretFields(ref)).toThrow(/privateKey/);
  });

  it("keeps a credential as a handle, and demands one for an apiKey environment", () => {
    expect(() => assertEnvironmentRef(environment())).not.toThrow();
    expect(() => assertEnvironmentRef(environment({ authMode: "apiKey" }))).toThrow(/credentialRef/);
    expect(() =>
      assertEnvironmentRef(environment({ authMode: "apiKey", credentialRef: "cred-1" as never })),
    ).not.toThrow();
    expect(() => assertEnvironmentRef({ ...environment(), privateKey: "x" } as never)).toThrow(/secret-bearing/);
  });
});
