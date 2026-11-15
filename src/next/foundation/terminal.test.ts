// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { connectTerminal, INITIAL_TERMINAL_CREDIT, parseTerminalControl } from "./live.ts";
import { createApiClient, saveSession } from "./http.ts";

/** The terminal contract, driven from both sides: a fake ticket route, a fake
 * socket, and the frames a real server sends. Nothing opens a port. */

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly sent: Array<string | Uint8Array> = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  binaryType = "blob";
  readyState = 0;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(type: string, event: Partial<MessageEvent> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event } as MessageEvent);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  text(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  bytes(...values: number[]): void {
    this.emit("message", { data: new Uint8Array(values).buffer });
  }

  drop(): void {
    this.readyState = 3;
    this.emit("close");
  }

  get texts(): unknown[] {
    return this.sent.filter((entry): entry is string => typeof entry === "string").map((entry) => JSON.parse(entry));
  }

  get binary(): Uint8Array[] {
    return this.sent.filter((entry): entry is Uint8Array => typeof entry !== "string");
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness(tickets = ["t1", "t2", "t3"]) {
  FakeSocket.instances = [];
  saveSession("tok", { id: "s", label: "T", scope: "device", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  let issued = 0;
  const requests: string[] = [];
  const client = createApiClient({
    fetchImpl: (async (url: string) => {
      requests.push(String(url));
      const ticket = tickets[Math.min(issued, tickets.length - 1)]!;
      issued += 1;
      return new Response(
        JSON.stringify({
          ticket,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          path: "/api/v1/terminals/term-1/stream",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });

  const timers: Array<() => void> = [];
  const data: Uint8Array[] = [];
  const controls: string[] = [];
  const exits: Array<{ reason: string; exitCode?: number }> = [];
  const errors: string[] = [];
  let reconnects = 0;

  const connection = connectTerminal({
    terminalId: "term-1",
    cols: 100,
    rows: 30,
    client,
    webSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    schedule: (run) => {
      timers.push(run);
      return timers.length;
    },
    cancel: () => {},
    onData: (bytes) => data.push(bytes),
    onControl: (control) => controls.push(control.type),
    onExit: (reason, exitCode) => exits.push({ reason, ...(exitCode !== undefined ? { exitCode } : {}) }),
    onError: (error) => errors.push(error.code),
    onReconnect: () => {
      reconnects += 1;
    },
  });

  return {
    connection,
    client,
    requests,
    timers,
    data,
    controls,
    exits,
    errors,
    reconnects: () => reconnects,
    socket: () => FakeSocket.instances.at(-1)!,
  };
}

describe("the terminal ticket", () => {
  it("asks the ticket route, then upgrades the same path with the ticket in the query", async () => {
    const h = harness();
    await flush();
    expect(h.requests[0]).toBe("/api/v1/terminals/term-1/ticket");
    const socket = h.socket();
    expect(socket.url).toContain("/api/v1/terminals/term-1/stream");
    expect(socket.url).toContain("ticket=t1");
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("reports its size once the socket opens, so the program knows the grid", async () => {
    const h = harness();
    await flush();
    h.socket().open();
    expect(h.socket().texts).toContainEqual({ type: "resize", cols: 100, rows: 30 });
  });
});

describe("the terminal frames", () => {
  it("treats binary frames as raw program bytes", async () => {
    const h = harness();
    await flush();
    h.socket().open();
    h.socket().text({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl: true });
    h.socket().bytes(27, 91, 50, 74);
    expect(h.data.map((bytes) => [...bytes])).toEqual([[27, 91, 50, 74]]);
  });

  it("decodes every control message the server can send", () => {
    expect(parseTerminalControl(JSON.stringify({ type: "ready", terminalId: "t", cols: 80, rows: 24, canControl: false }))).toEqual({
      type: "ready",
      terminalId: "t",
      cols: 80,
      rows: 24,
      canControl: false,
    });
    expect(parseTerminalControl(JSON.stringify({ type: "title", title: "vim" }))).toEqual({ type: "title", title: "vim" });
    expect(parseTerminalControl(JSON.stringify({ type: "status", status: "running" }))).toEqual({ type: "status", status: "running" });
    expect(parseTerminalControl(JSON.stringify({ type: "exit", reason: "done", exitCode: 0 }))).toEqual({ type: "exit", reason: "done", exitCode: 0 });
    expect(parseTerminalControl(JSON.stringify({ type: "error", code: "e", message: "m" }))).toEqual({ type: "error", code: "e", message: "m" });
    expect(parseTerminalControl(JSON.stringify({ type: "resync", cols: 120, rows: 40 }))).toEqual({ type: "resync", cols: 120, rows: 40 });
  });

  it("drops a control message it cannot read instead of treating it as data", () => {
    expect(parseTerminalControl("not json")).toBeUndefined();
    expect(parseTerminalControl(JSON.stringify({ type: "invented" }))).toBeUndefined();
    expect(parseTerminalControl(JSON.stringify({ type: "ready", terminalId: "t" }))).toBeUndefined();
  });

  it("reports an exit and stops sending input", async () => {
    const h = harness();
    await flush();
    h.socket().open();
    h.socket().text({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl: true });
    h.socket().text({ type: "exit", reason: "done", exitCode: 0 });
    h.connection.sendInput(new Uint8Array([97]));
    expect(h.exits).toEqual([{ reason: "done", exitCode: 0 }]);
    expect(h.socket().binary).toHaveLength(0);
  });
});

describe("terminal input and flow control", () => {
  it("sends input as binary only while the server granted control", async () => {
    const h = harness();
    await flush();
    h.socket().open();
    h.socket().text({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl: false });
    h.connection.sendInput(new Uint8Array([97]));
    expect(h.socket().binary).toHaveLength(0);

    h.socket().text({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl: true });
    h.connection.sendInput(new Uint8Array([98, 99]));
    expect(h.socket().binary.map((bytes) => [...bytes])).toEqual([[98, 99]]);
  });

  it("starts with 256 KiB of credit and returns only what was drawn", async () => {
    expect(INITIAL_TERMINAL_CREDIT).toBe(256 * 1024);
    const h = harness();
    await flush();
    h.connection.sendCredit(0);
    h.connection.sendCredit(-5);
    expect(h.socket().sent).toHaveLength(0);
  });

  it("sends a credit frame for the bytes a write callback reports", async () => {
    const h = harness();
    await flush();
    h.socket().open();
    h.socket().text({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl: true });
    h.connection.sendCredit(4096);
    expect(h.socket().texts).toContainEqual({ type: "credit", bytes: 4096 });
  });

  it("sends a resize and a close as text", async () => {
    const h = harness();
    await flush();
    h.socket().open();
    h.connection.sendResize(140, 44);
    h.connection.close();
    expect(h.socket().texts).toContainEqual({ type: "resize", cols: 140, rows: 44 });
    expect(h.socket().texts).toContainEqual({ type: "close" });
  });
});

describe("a dropped terminal", () => {
  it("mints a fresh ticket and reattaches without replaying input", async () => {
    const h = harness();
    await flush();
    h.socket().open();
    h.socket().text({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl: true });
    h.connection.sendInput(new Uint8Array([97]));
    expect(h.requests).toHaveLength(1);

    h.socket().drop();
    expect(h.timers).toHaveLength(1);
    h.timers[0]!();
    await flush();

    expect(h.requests).toHaveLength(2);
    const second = h.socket();
    expect(second.url).toContain("ticket=t2");
    expect(second.binary).toHaveLength(0);

    second.open();
    expect(second.texts).toContainEqual({ type: "resize", cols: 100, rows: 30 });
    second.text({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl: true });
    expect(h.reconnects()).toBe(1);
  });

  it("keeps retrying after a second drop, with a fresh ticket each time", async () => {
    const h = harness();
    await flush();
    h.socket().open();
    h.socket().text({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl: true });
    h.socket().drop();
    h.timers[0]!();
    await flush();
    h.socket().open();
    h.socket().text({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl: true });
    h.socket().drop();
    expect(h.timers).toHaveLength(2);
    h.timers[1]!();
    await flush();
    expect(h.requests).toHaveLength(3);
    expect(h.socket().url).toContain("ticket=t3");
  });

  it("stops after close, even if the socket then drops", async () => {
    const h = harness();
    await flush();
    h.socket().open();
    h.socket().text({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl: true });
    h.connection.close();
    h.socket().drop();
    expect(h.timers).toHaveLength(0);
  });
});
