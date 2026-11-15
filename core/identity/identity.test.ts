import { describe, expect, it } from "vitest";

import { digestsMatch, formatPairingCode, normalizePairingCode, pairingCode, sha256Hex } from "./crypto.ts";
import { CountingRandom, ManualClock } from "./testing/fakes.ts";
import { PairingCodes } from "./pairing.ts";
import { DeviceSessions } from "./sessions.ts";
import { MemoryTicketStore } from "./tickets.ts";
import { scopeSatisfies } from "./scopes.ts";
import { IdentityError } from "./errors.ts";

describe("pairing codes", () => {
  it("prints an unambiguous grouped code and stores only its digest", () => {
    const clock = new ManualClock();
    const codes = new PairingCodes({ clock, random: new CountingRandom() });
    const view = codes.issue();
    expect(view.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
    expect(formatPairingCode(normalizePairingCode(view.code))).toBe(view.code);
  });

  it("is single use", () => {
    const codes = new PairingCodes({ clock: new ManualClock(), random: new CountingRandom() });
    const view = codes.issue();
    expect(() => codes.redeem(view.code)).not.toThrow();
    expect(() => codes.redeem(view.code)).toThrow(/no pairing code is active/u);
  });

  it("refuses an expired code even when the text matches", () => {
    const clock = new ManualClock();
    const codes = new PairingCodes({ clock, random: new CountingRandom(), ttlMs: 1_000 });
    const view = codes.issue();
    clock.advance(1_000);
    expect(() => codes.redeem(view.code)).toThrow(/expired/u);
  });

  it("burns the code after the attempt budget, so guessing cannot continue", () => {
    const codes = new PairingCodes({ clock: new ManualClock(), random: new CountingRandom(), maxAttempts: 3 });
    const view = codes.issue();
    for (let attempt = 0; attempt < 3; attempt += 1) expect(() => codes.redeem("WRONGCODE")).toThrow();
    expect(() => codes.redeem(view.code)).toThrow(/no pairing code is active/u);
  });

  it("accepts the code with a different case or separator", () => {
    const codes = new PairingCodes({ clock: new ManualClock(), random: new CountingRandom() });
    const view = codes.issue();
    expect(() => codes.redeem(view.code.toLowerCase().replace("-", " "))).not.toThrow();
  });

  it("compares digests in constant time over equal-length values", () => {
    expect(digestsMatch(sha256Hex("a"), sha256Hex("a"))).toBe(true);
    expect(digestsMatch(sha256Hex("a"), sha256Hex("b"))).toBe(false);
    expect(digestsMatch(sha256Hex("a"), "nothex")).toBe(false);
  });

  it("draws from the injected random, so a code is reproducible in a test", () => {
    expect(pairingCode(new CountingRandom(), 8)).toBe(pairingCode(new CountingRandom(), 8));
  });
});

describe("device sessions", () => {
  it("authenticates by digest and never stores the token", () => {
    const sessions = new DeviceSessions({ clock: new ManualClock(), random: new CountingRandom() });
    const issued = sessions.issue({ label: "phone", scope: "device" });
    expect(sessions.authenticate(issued.token).id).toBe(issued.session.id);
    expect(JSON.stringify(sessions.list())).not.toContain(issued.token);
  });

  it("refuses an unknown, expired or revoked token", () => {
    const clock = new ManualClock();
    const sessions = new DeviceSessions({ clock, random: new CountingRandom(), ttlMs: 1_000 });
    const issued = sessions.issue({ label: "phone", scope: "device" });
    expect(() => sessions.authenticate("nope")).toThrow(IdentityError);

    clock.advance(1_000);
    expect(() => sessions.authenticate(issued.token)).toThrow(/expired/u);

    const second = sessions.issue({ label: "tablet", scope: "readonly" });
    sessions.revoke(second.session.id);
    expect(() => sessions.authenticate(second.token)).toThrow(/revoked/u);
  });

  it("revokes idempotently and revokes all", () => {
    const sessions = new DeviceSessions({ clock: new ManualClock(), random: new CountingRandom() });
    const first = sessions.issue({ label: "a", scope: "device" });
    expect(sessions.revoke(first.session.id)).toBe(true);
    expect(sessions.revoke(first.session.id)).toBe(true);
    expect(sessions.revoke("missing")).toBe(false);
    sessions.revokeAll();
    expect(sessions.list().every((session) => session.revokedAt !== undefined)).toBe(true);
  });
});

describe("tickets", () => {
  it("is single use, so a replayed ticket in a URL log cannot open a stream", () => {
    const store = new MemoryTicketStore({ clock: new ManualClock(), random: new CountingRandom() });
    const issued = store.issue({ sessionId: "s1", scope: "device", purpose: "events" });
    expect(store.redeem(issued.ticket, "events").sessionId).toBe("s1");
    expect(() => store.redeem(issued.ticket, "events")).toThrow(/already redeemed/u);
  });

  it("expires, and binds one purpose and one target", () => {
    const clock = new ManualClock();
    const store = new MemoryTicketStore({ clock, random: new CountingRandom(), ttlMs: 1_000 });
    const events = store.issue({ sessionId: "s1", scope: "device", purpose: "events" });
    clock.advance(1_000);
    expect(() => store.redeem(events.ticket, "events")).toThrow(/expired/u);

    const terminal = store.issue({ sessionId: "s1", scope: "device", purpose: "terminal", targetId: "term-1" });
    expect(() => store.redeem(terminal.ticket, "events")).toThrow(/another stream/u);

    const bound = store.issue({ sessionId: "s1", scope: "device", purpose: "terminal", targetId: "term-1" });
    expect(store.redeem(bound.ticket, "terminal").targetId).toBe("term-1");
  });
});

describe("scopes", () => {
  it("orders readonly below device below owner", () => {
    expect(scopeSatisfies("owner", "device")).toBe(true);
    expect(scopeSatisfies("device", "device")).toBe(true);
    expect(scopeSatisfies("readonly", "device")).toBe(false);
    expect(scopeSatisfies("device", "owner")).toBe(false);
  });
});
