import { describe, expect, it } from "vitest";

import { TerminalRegistry } from "./registry.ts";
import type { Terminal } from "./types.ts";

function terminal(address: string, overrides: Partial<Terminal> = {}): Terminal {
  return {
    address,
    argv: ["sh"],
    cwd: "/home/me",
    state: "live",
    created_ms: 1,
    screen: "exact",
    cols: 80,
    rows: 24,
    labels: {},
    title: "",
    turn: 0,
    ...overrides,
  };
}

describe("snapshots", () => {
  it("replaces the whole view and reports what moved", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({ seq: 5, terminals: [terminal("t1"), terminal("t2")] });
    expect(registry.list().map((record) => record.address)).toEqual(["t1", "t2"]);
    expect(registry.seq).toBe(5);

    const result = registry.applySnapshot({ seq: 9, terminals: [terminal("t2", { title: "vim" }), terminal("t3")] });
    expect(result.added).toEqual(["t3"]);
    expect(result.removed).toEqual(["t1"]);
    expect(result.changed).toEqual(["t2"]);
    expect(registry.get("t1")).toBeNull();
    expect(registry.get("t2")?.title).toBe("vim");
  });

  it("bumps its epoch on every snapshot, so a stale replay is detectable", () => {
    const registry = new TerminalRegistry();
    const first = registry.epoch;
    registry.applySnapshot({ seq: 0, terminals: [] });
    expect(registry.epoch).toBe(first + 1);
    registry.applySnapshot({ seq: 0, terminals: [] });
    expect(registry.epoch).toBe(first + 2);
  });
});

describe("events", () => {
  it("drops an event at or below the snapshot's sequence", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({ seq: 10, terminals: [terminal("t1")] });
    expect(registry.applyEvent({ seq: 10, type: "title", terminal: "t1", data: { title: "stale" } })).toBe(false);
    expect(registry.applyEvent({ seq: 9, type: "title", terminal: "t1", data: { title: "older" } })).toBe(false);
    expect(registry.get("t1")?.title).toBe("");
    expect(registry.applyEvent({ seq: 11, type: "title", terminal: "t1", data: { title: "vim" } })).toBe(true);
    expect(registry.get("t1")?.title).toBe("vim");
  });

  it("adds a created record and replaces it on restarted", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({ seq: 0, terminals: [] });
    registry.applyEvent({ seq: 1, type: "created", terminal: "t7", data: terminal("t7") });
    expect(registry.get("t7")?.state).toBe("live");
    registry.applyEvent({ seq: 2, type: "restarted", terminal: "t7", data: terminal("t7", { pid: 42 }) });
    expect(registry.get("t7")?.pid).toBe(42);
  });

  it("keeps a lost terminal live and drops its pid and foreground", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({
      seq: 0,
      terminals: [
        terminal("t1", { pid: 10, foreground: { pid: 11, name: "node", argv: ["node"], cwd: "/x" } }),
      ],
    });
    registry.applyEvent({
      seq: 1,
      type: "lost",
      terminal: "t1",
      data: { reason: "signaled", exit_code: null, signal: 9, finished_ms: null },
    });
    const record = registry.get("t1")!;
    expect(record.state).toBe("live");
    expect(record.pid).toBeNull();
    expect(record.foreground).toBeNull();
    expect(record.reason).toBe("signaled");
    expect(record.signal).toBe(9);
  });

  it("marks a finished terminal finished and clears its status", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({
      seq: 0,
      terminals: [
        terminal("t1", {
          pid: 10,
          status: { state: "working" },
          foreground: { pid: 11, name: "node", argv: ["node"], cwd: "/x" },
        }),
      ],
    });
    registry.applyEvent({
      seq: 1,
      type: "finished",
      terminal: "t1",
      data: { reason: "exited", exit_code: 0, signal: null, finished_ms: 1000 },
    });
    const record = registry.get("t1")!;
    expect(record.state).toBe("finished");
    expect(record.exit_code).toBe(0);
    expect(record.finished_ms).toBe(1000);
    expect(record.status).toBeNull();
    expect(record.foreground).toBeNull();
  });

  it("replaces the status triple, the turn, the title and the size", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({ seq: 0, terminals: [terminal("t1")] });
    registry.applyEvent({
      seq: 1,
      type: "status",
      terminal: "t1",
      data: { status: { state: "blocked" }, records: { sub: { state: "working" } }, reported: true },
    });
    expect(registry.get("t1")?.status).toEqual({ state: "blocked" });
    expect(registry.get("t1")?.records).toEqual({ sub: { state: "working" } });
    expect(registry.get("t1")?.reported).toBe(true);

    registry.applyEvent({ seq: 2, type: "turn", terminal: "t1", data: { turn: 4, state: "done" } });
    expect(registry.get("t1")?.turn).toBe(4);
    registry.applyEvent({ seq: 3, type: "title", terminal: "t1", data: { title: "claude" } });
    expect(registry.get("t1")?.title).toBe("claude");
    registry.applyEvent({ seq: 4, type: "size", terminal: "t1", data: { cols: 120, rows: 40 } });
    expect(registry.get("t1")?.cols).toBe(120);
    expect(registry.get("t1")?.rows).toBe(40);
  });

  it("sets keep and foreground, including a null foreground", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({ seq: 0, terminals: [terminal("t1")] });
    registry.applyEvent({ seq: 1, type: "keep", terminal: "t1", data: { keep: true } });
    expect(registry.get("t1")?.keep).toBe(true);
    registry.applyEvent({
      seq: 2,
      type: "foreground",
      terminal: "t1",
      data: { pid: 22, name: "vim", argv: ["vim", "x"], cwd: "/home/me" },
    });
    expect(registry.get("t1")?.foreground).toEqual({ pid: 22, name: "vim", argv: ["vim", "x"], cwd: "/home/me" });
    registry.applyEvent({ seq: 3, type: "foreground", terminal: "t1", data: null });
    expect(registry.get("t1")?.foreground).toBeNull();
  });

  it("drops a removed terminal and adds a record a labels event newly matched", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({ seq: 0, terminals: [terminal("t1")] });
    registry.applyEvent({ seq: 1, type: "labels", terminal: "t1", data: { labels: { team: "a" } } });
    expect(registry.get("t1")?.labels).toEqual({ team: "a" });
    registry.applyEvent({
      seq: 2,
      type: "labels",
      terminal: "t2",
      data: { labels: { team: "a" }, record: terminal("t2", { labels: { team: "a" } }) },
    });
    expect(registry.get("t2")?.labels).toEqual({ team: "a" });
    registry.applyEvent({ seq: 3, type: "removed", terminal: "t1", data: {} });
    expect(registry.get("t1")).toBeNull();
  });

  it("does not invent a record for an event about a terminal it never saw", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({ seq: 0, terminals: [] });
    registry.applyEvent({ seq: 1, type: "finished", terminal: "t9", data: { reason: "exited" } });
    registry.applyEvent({ seq: 2, type: "status", terminal: "t9", data: { status: null } });
    expect(registry.get("t9")).toBeNull();
    expect(registry.seq).toBe(2);
  });

  it("tells listeners about a document event without a terminal", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({ seq: 0, terminals: [] });
    const seen: unknown[] = [];
    registry.subscribe((change) => seen.push(change));
    registry.applyEvent({ seq: 1, type: "doc", data: { name: "herdr-app", version: 2 } });
    expect(seen).toEqual([{ type: "doc" }]);
  });
});

describe("reconnect", () => {
  it("keeps the old view only until the snapshot that replaces it", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({ seq: 400, terminals: [terminal("t1"), terminal("t2")] });
    const epoch = registry.epoch;
    registry.markDisconnected(null);
    expect(registry.stale).toBe(true);
    expect(registry.seq).toBe(0);
    expect(registry.epoch).toBe(epoch + 1);
  });

  it("ignores every event between the break and its snapshot", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({ seq: 400, terminals: [terminal("t1")] });
    registry.markDisconnected(null);
    expect(registry.applyEvent({ seq: 401, type: "title", terminal: "t1", data: { title: "late" } })).toBe(false);
    expect(registry.get("t1")?.title).toBe("");
  });

  it("reconciles a reconnect from a fresh snapshot, not from replayed events", () => {
    const registry = new TerminalRegistry();
    registry.applySnapshot({ seq: 400, terminals: [terminal("t1"), terminal("t2")] });
    registry.markDisconnected(null);
    // The core restarted: t2 is gone, t1 came back with a new pid, t3 is new.
    const result = registry.applySnapshot({
      seq: 3,
      terminals: [terminal("t1", { pid: 99 }), terminal("t3")],
    });
    expect(result.added).toEqual(["t3"]);
    expect(result.removed).toEqual(["t2"]);
    expect(result.changed).toEqual(["t1"]);
    expect(registry.seq).toBe(3);
    expect(registry.stale).toBe(false);
    // A late event from before the break must not resurrect the old view.
    expect(registry.applyEvent({ seq: 2, type: "created", terminal: "t2", data: terminal("t2") })).toBe(false);
  });
});
