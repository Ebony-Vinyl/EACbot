import { describe, expect, it } from "vitest";

import type { TerminalControl } from "../foundation/api.ts";
import {
  createTerminalConnection,
  INITIAL_CREDIT_BYTES,
  type FoundationConnectOptions,
  type FoundationTerminal,
  type LeaseRole,
  type TerminalEvent,
} from "./terminal-transport.ts";

/** A transport that records what the workbench sent and lets a test drive the
 * server side. Nothing opens a port: the contract is what is under test. */
class FakeTransport implements FoundationTerminal {
  readonly sent: Array<{ kind: "input" | "resize" | "credit" | "close"; value?: Uint8Array | number }> = [];
  closed = false;
  open = true;
  readonly handlers: FoundationConnectOptions;

  constructor(handlers: FoundationConnectOptions) {
    this.handlers = handlers;
  }

  sendInput(bytes: Uint8Array): void {
    this.sent.push({ kind: "input", value: bytes });
  }
  sendResize(cols: number, rows: number): void {
    this.sent.push({ kind: "resize", value: cols * 1_000 + rows });
  }
  sendCredit(bytes: number): void {
    this.sent.push({ kind: "credit", value: bytes });
  }
  close(): void {
    this.closed = true;
    this.open = false;
  }
  isOpen(): boolean {
    return this.open;
  }

  control(message: TerminalControl): void {
    this.handlers.onControl(message);
  }
  bytes(...values: number[]): void {
    this.handlers.onData(new Uint8Array(values));
  }
  dropped(): void {
    this.open = false;
    this.handlers.onError(new Error("socket closed"));
  }

  get inputs(): Uint8Array[] {
    return this.sent.filter((entry) => entry.kind === "input").map((entry) => entry.value as Uint8Array);
  }
}

class ManualClock {
  readonly timers = new Map<number, () => void>();
  #next = 1;
  setInterval(callback: () => void): unknown {
    const id = this.#next++;
    this.timers.set(id, callback);
    return id;
  }
  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  tick(): void {
    for (const callback of this.timers.values()) callback();
  }
  get running(): number {
    return this.timers.size;
  }
}

interface Harness {
  readonly transports: FakeTransport[];
  readonly events: TerminalEvent[];
  readonly data: Uint8Array[];
  readonly clock: ManualClock;
  role: LeaseRole;
  connection: ReturnType<typeof createTerminalConnection>;
}

function harness(options: { role?: LeaseRole; maxAttempts?: number } = {}): Harness {
  const clock = new ManualClock();
  const state: Harness = {
    transports: [],
    events: [],
    data: [],
    clock,
    role: options.role ?? "control",
    connection: null as unknown as Harness["connection"],
  };
  state.connection = createTerminalConnection({
    terminalId: "term-1",
    getRole: () => state.role,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    clock,
    connect: (handlers) => {
      const transport = new FakeTransport(handlers);
      state.transports.push(transport);
      return transport;
    },
  });
  state.connection.onEvent((event) => state.events.push(event));
  state.connection.onData((bytes) => state.data.push(bytes));
  return state;
}

function live(h: Harness, canControl = true): FakeTransport {
  h.connection.open();
  const transport = h.transports.at(-1)!;
  transport.control({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl });
  return transport;
}

describe("the stream contract", () => {
  it("starts idle and becomes live on ready", () => {
    const h = harness();
    expect(h.connection.state).toEqual({ kind: "idle" });
    live(h);
    expect(h.connection.state).toEqual({ kind: "live", canControl: true });
    expect(h.connection.canControl).toBe(true);
  });

  it("treats ready as a repaint boundary", () => {
    const h = harness();
    live(h);
    expect(h.events.filter((event) => event.type === "repaint")).toHaveLength(1);
  });

  it("passes raw terminal bytes through untouched", () => {
    const h = harness();
    live(h).bytes(0x1b, 0x5b, 0x33, 0x31);
    expect([...(h.data[0] as Uint8Array)]).toEqual([0x1b, 0x5b, 0x33, 0x31]);
  });

  it("never treats a text control message as terminal bytes", () => {
    const h = harness();
    live(h).control({ type: "title", title: "npm test" });
    expect(h.data).toHaveLength(0);
    expect(h.events).toContainEqual({ type: "title", title: "npm test" });
  });

  it("reports a status and an exit", () => {
    const h = harness();
    const transport = live(h);
    transport.control({ type: "status", status: "working" });
    expect(h.events).toContainEqual({ type: "status", status: "working" });
    transport.control({ type: "exit", reason: "exited", exitCode: 0 });
    expect(h.connection.state).toEqual({ kind: "exited", reason: "exited", exitCode: 0 });
    expect(h.events).toContainEqual({ type: "exit", reason: "exited", exitCode: 0 });
    expect(transport.closed).toBe(true);
  });

  it("repaints on resync without changing the connection state", () => {
    const h = harness();
    live(h).control({ type: "resync", cols: 120, rows: 40 });
    expect(h.events.filter((event) => event.type === "repaint")).toHaveLength(2);
    expect(h.connection.state.kind).toBe("live");
  });

  it("reports a server error as a retryable failure", () => {
    const h = harness();
    live(h).control({ type: "error", code: "forbidden", message: "no access" });
    expect(h.connection.state).toEqual({ kind: "failed", message: "no access", retryable: true });
    expect(h.events).toContainEqual({ type: "error", message: "no access" });
    expect(h.connection.canControl).toBe(false);
  });
});

describe("input, resize and credit", () => {
  it("sends input bytes from a controlling viewer", () => {
    const h = harness({ role: "control" });
    const transport = live(h, true);
    expect(h.connection.send(new Uint8Array([0x61]))).toBe(true);
    expect([...(transport.inputs[0] as Uint8Array)]).toEqual([0x61]);
  });

  it("refuses input from a watcher and sends nothing", () => {
    const h = harness({ role: "observe" });
    const transport = live(h, true);
    expect(h.connection.send(new Uint8Array([0x61]))).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses input when the server did not grant control", () => {
    const h = harness({ role: "control" });
    const transport = live(h, false);
    expect(h.connection.send(new Uint8Array([0x61]))).toBe(false);
    expect(h.connection.resize(80, 24)).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses input before the stream is live", () => {
    const h = harness({ role: "control" });
    h.connection.open();
    expect(h.connection.send(new Uint8Array([0x61]))).toBe(false);
    expect(h.connection.resize(80, 24)).toBe(false);
  });

  it("honours a role change without rebuilding the stream", () => {
    const h = harness({ role: "control" });
    const transport = live(h, true);
    h.role = "observe";
    expect(h.connection.send(new Uint8Array([0x61]))).toBe(false);
    h.role = "control";
    expect(h.connection.send(new Uint8Array([0x61]))).toBe(true);
    expect(h.transports).toHaveLength(1);
    expect(transport.inputs).toHaveLength(1);
  });

  it("sends a resize with whole numbers", () => {
    const h = harness({ role: "control" });
    const transport = live(h);
    expect(h.connection.resize(80.7, 24.2)).toBe(true);
    expect(transport.sent).toContainEqual({ kind: "resize", value: 80 * 1_000 + 24 });
  });

  it("keeps a watcher from resizing", () => {
    const h = harness({ role: "observe" });
    const transport = live(h);
    expect(h.connection.resize(80, 24)).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it("credits bytes even for a watcher, because credit is flow control", () => {
    const h = harness({ role: "observe" });
    const transport = live(h);
    h.connection.acknowledge(INITIAL_CREDIT_BYTES);
    expect(transport.sent).toContainEqual({ kind: "credit", value: INITIAL_CREDIT_BYTES });
  });

  it("sends no credit for nothing or a fraction", () => {
    const h = harness();
    const transport = live(h);
    h.connection.acknowledge(0);
    h.connection.acknowledge(-4);
    h.connection.acknowledge(Number.NaN);
    expect(transport.sent).toHaveLength(0);
  });
});

describe("losing the stream", () => {
  it("reports Reconnecting, keeps no control, and starts a fresh stream on retry", () => {
    const h = harness({ role: "control" });
    const first = live(h);
    expect(h.connection.send(new Uint8Array([0x61]))).toBe(true);

    first.dropped();
    expect(h.connection.state).toMatchObject({ kind: "reconnecting", attempt: 1 });
    expect(h.connection.canControl).toBe(false);
    expect(h.connection.send(new Uint8Array([0x62]))).toBe(false);

    h.connection.retry();
    expect(h.transports).toHaveLength(2);
    const second = h.transports.at(-1)!;
    expect(second.inputs).toHaveLength(0);
    second.control({ type: "ready", terminalId: "term-1", cols: 100, rows: 30, canControl: true });
    expect(h.connection.state.kind).toBe("live");
    expect(h.data).toHaveLength(0);
  });

  it("notices a transport that went down between frames", () => {
    const h = harness();
    const transport = live(h);
    transport.open = false;
    h.clock.tick();
    expect(h.connection.state).toMatchObject({ kind: "reconnecting" });
  });

  it("offers Retry instead of promising a return forever", () => {
    const h = harness({ maxAttempts: 0 });
    live(h).dropped();
    expect(h.connection.state).toMatchObject({ kind: "failed", retryable: true });
    expect(h.clock.running).toBe(0);
    h.connection.retry();
    expect(h.transports).toHaveLength(2);
    expect(h.connection.state.kind).not.toBe("failed");
  });

  it("retries immediately when asked", () => {
    const h = harness();
    live(h).dropped();
    h.connection.retry();
    expect(h.transports).toHaveLength(2);
  });

  it("stops watching once closed", () => {
    const h = harness();
    const transport = live(h);
    h.connection.close();
    expect(transport.closed).toBe(true);
    expect(h.connection.state).toEqual({ kind: "closed" });
    expect(h.clock.running).toBe(0);
    transport.dropped();
    expect(h.connection.state.kind).toBe("closed");
  });

  it("ignores a transport that was replaced", () => {
    const h = harness();
    const first = live(h);
    h.connection.close();
    first.bytes(0x41);
    expect(h.data).toHaveLength(0);
  });

  it("lets a listener unsubscribe without disturbing the stream", () => {
    const h = harness();
    const transport = live(h);
    const seen: Uint8Array[] = [];
    const off = h.connection.onData((bytes) => seen.push(bytes));
    transport.bytes(1);
    off();
    transport.bytes(2);
    expect(seen).toHaveLength(1);
  });
});
