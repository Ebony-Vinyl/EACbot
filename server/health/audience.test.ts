// Health is one person's. The rule is pure, so these cases are the whole rule: a room's turn, another member's
// turn, and the owner's own turn.
import { describe, expect, it } from "vitest";

import { healthMayLeaveHost, mayReadHealth, mayWriteHealth } from "./audience.ts";

describe("who may read health", () => {
  it("lets the owner's own turn read it", () => {
    expect(mayReadHealth("owner", "team", null)).toEqual({ ok: true });
  });

  it("refuses a room's turn even for the owner", () => {
    const verdict = mayReadHealth("owner", "room:abc", "someone");
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ code: "room_turn" });
  });

  it("refuses another member's health to a member's turn", () => {
    const verdict = mayReadHealth("member:alice", "member:alice", "bob");
    expect(verdict).toMatchObject({ ok: false, code: "not_your_health" });
  });

  it("lets a member read their own", () => {
    expect(mayReadHealth("member:alice", "member:alice", "alice")).toEqual({ ok: true });
  });

  it("refuses a member's health on a shared team turn", () => {
    expect(mayReadHealth("member:alice", "team", "alice")).toMatchObject({ ok: false, code: "not_your_health" });
  });

  it("refuses when the turn's person is unknown", () => {
    expect(mayReadHealth("member:alice", "member:alice", null)).toMatchObject({ ok: false, code: "unknown_audience" });
  });

  it("refuses a room turn for a member", () => {
    expect(mayReadHealth("member:alice", "room:abc", "alice")).toMatchObject({ ok: false, code: "room_turn" });
  });
});

describe("who may write health", () => {
  it("lets the owner's own turn record a reading", () => {
    expect(mayWriteHealth("owner", "team", null)).toBe(true);
  });

  it("refuses a room turn", () => {
    expect(mayWriteHealth("owner", "room:abc", null)).toBe(false);
  });

  it("lets a member record their own", () => {
    expect(mayWriteHealth("member:alice", "member:alice", "alice")).toBe(true);
  });

  it("refuses another member's", () => {
    expect(mayWriteHealth("member:alice", "member:alice", "bob")).toBe(false);
  });
});

describe("whether health may leave the host", () => {
  it("is off unless the person turned it on", () => {
    expect(healthMayLeaveHost(undefined)).toBe(false);
    expect(healthMayLeaveHost({})).toBe(false);
    expect(healthMayLeaveHost({ shareWithModels: false })).toBe(false);
    expect(healthMayLeaveHost({ shareWithModels: true })).toBe(true);
  });
});
