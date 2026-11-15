import { describe, expect, it } from "vitest";

import {
  describeLease,
  initialLease,
  leaseCopy,
  mayResize,
  maySendInput,
  reduceLease,
  type LeaseAction,
  type LeaseState,
} from "./control-lease.ts";

const run = (actions: readonly LeaseAction[], from: LeaseState = initialLease()): LeaseState =>
  actions.reduce(reduceLease, from);

describe("the control lease", () => {
  it("starts watching, which may not type", () => {
    const state = initialLease();
    expect(state.kind).toBe("watching");
    expect(maySendInput(state)).toBe(false);
    expect(mayResize(state)).toBe(false);
    expect(describeLease(state)).toMatchObject({ canSend: false, canAcquire: true, role: "watch" });
  });

  it("goes from watching to requesting to controlling", () => {
    const state = run([{ type: "request" }, { type: "granted", since: 1_000 }]);
    expect(state).toEqual({ kind: "controlling", since: 1_000 });
    expect(maySendInput(state)).toBe(true);
    expect(mayResize(state)).toBe(true);
    expect(describeLease(state).role).toBe("control");
  });

  it("ignores a grant nobody asked for", () => {
    expect(run([{ type: "granted", since: 5 }])).toEqual(initialLease());
  });

  it("does not re-request while a request is in flight", () => {
    const requesting = run([{ type: "request" }]);
    expect(run([{ type: "request" }], requesting)).toBe(requesting);
  });

  it("names whoever else holds control and offers a way back", () => {
    const state = run([{ type: "held-by-other", holder: "Ada's phone" }]);
    expect(state).toEqual({ kind: "held-by-other", holder: "Ada's phone" });
    expect(maySendInput(state)).toBe(false);
    expect(describeLease(state).canAcquire).toBe(true);
    expect(leaseCopy(state).title).toContain("Ada's phone");
    expect(run([{ type: "request" }, { type: "granted", since: 7 }], state)).toEqual({ kind: "controlling", since: 7 });
  });

  it("never lets a control holder be quietly downgraded by a stale message", () => {
    const controlling = run([{ type: "request" }, { type: "granted", since: 1 }]);
    expect(run([{ type: "held-by-other", holder: "someone" }], controlling)).toBe(controlling);
  });

  it("releases back to watching", () => {
    const controlling = run([{ type: "request" }, { type: "granted", since: 1 }]);
    expect(run([{ type: "release" }], controlling)).toEqual({ kind: "watching" });
    expect(run([{ type: "release" }])).toEqual(initialLease());
  });

  it("reports a revocation with its reason and stops typing", () => {
    const controlling = run([{ type: "request" }, { type: "granted", since: 1 }]);
    const revoked = run([{ type: "revoked", reason: "Ada took control" }], controlling);
    expect(revoked).toEqual({ kind: "released", reason: "Ada took control" });
    expect(maySendInput(revoked)).toBe(false);
    expect(leaseCopy(revoked).detail).toBe("Ada took control");
  });

  it("ignores a revocation it was not holding", () => {
    expect(run([{ type: "revoked", reason: "x" }])).toEqual(initialLease());
  });

  it("reports a refusal with its reason and allows another attempt", () => {
    const denied = run([{ type: "request" }, { type: "denied", reason: "not allowed" }]);
    expect(denied).toEqual({ kind: "denied", reason: "not allowed" });
    expect(describeLease(denied).canAcquire).toBe(true);
    expect(maySendInput(denied)).toBe(false);
  });

  it("has words for every state", () => {
    const states: LeaseState[] = [
      initialLease(),
      { kind: "requesting" },
      { kind: "controlling", since: 0 },
      { kind: "held-by-other", holder: "Ada" },
      { kind: "released", reason: "gone" },
      { kind: "denied", reason: "no" },
    ];
    for (const state of states) {
      const copy = leaseCopy(state);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.detail.length).toBeGreaterThan(0);
    }
  });
});
