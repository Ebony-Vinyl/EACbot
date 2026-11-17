import { describe, expect, it } from "vitest";

import type { TerminalControl } from "../foundation/api.ts";
import { initialLease } from "./control-lease.ts";
import { leaseAfterStream } from "./terminal-registry.ts";

describe("the lease a stream implies", () => {
  it("keeps a watcher watching when the stream grants nothing", () => {
    expect(leaseAfterStream("live", false, initialLease(), false)).toEqual({ kind: "watching" });
  });

  it("grants control to a person who asked and a server that allowed it", () => {
    expect(leaseAfterStream("live", true, { kind: "requesting" }, true, 1_000)).toEqual({ kind: "controlling", since: 1_000 });
  });

  it("names the other holder when a person asked but the server refused", () => {
    expect(leaseAfterStream("live", false, { kind: "requesting" }, true)).toEqual({ kind: "held-by-other", holder: "Another viewer" });
  });

  it("never grants control nobody asked for", () => {
    expect(leaseAfterStream("live", true, initialLease(), false)).toEqual({ kind: "watching" });
  });

  it("drops control the moment the person releases it, even on a live stream", () => {
    expect(leaseAfterStream("live", true, { kind: "controlling", since: 1 }, false)).toEqual({ kind: "watching" });
  });

  it("asks again while reconnecting rather than claiming control", () => {
    expect(leaseAfterStream("reconnecting", false, { kind: "controlling", since: 1 }, true)).toEqual({ kind: "requesting" });
    expect(leaseAfterStream("reconnecting", false, { kind: "watching" }, true)).toEqual({ kind: "watching" });
  });

  it("releases on a stream that closed or exited", () => {
    expect(leaseAfterStream("closed", false, { kind: "controlling", since: 1 }, true)).toEqual({ kind: "watching" });
    expect(leaseAfterStream("exited", false, { kind: "controlling", since: 1 }, true)).toEqual({ kind: "watching" });
  });

  it("leaves a watcher alone through every phase", () => {
    for (const kind of ["connecting", "live", "reconnecting", "closed", "exited", "failed", "idle"]) {
      expect(leaseAfterStream(kind, false, initialLease(), false)).toEqual({ kind: "watching" });
    }
  });
});

describe("a control frame", () => {
  it("is what the transport reports, so the registry only reads it", () => {
    const ready: TerminalControl = { type: "ready", terminalId: "t", cols: 80, rows: 24, canControl: false };
    expect(ready.canControl).toBe(false);
  });
});
