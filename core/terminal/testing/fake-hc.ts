/**
 * A fake `herdr-core connect`: it speaks the real wire format over in-memory
 * pipes, so tests exercise the client's codec, multiplexing and stream
 * handling without a Rust binary or a user's machine.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { SpawnPlan, SpawnedProcess, Spawner } from "../transport.ts";
import {
  FrameDecoder,
  FrameKind,
  creditPayload,
  decodeCloseReason,
  encodeFrame,
  readCredit,
  readResize,
  resizePayload,
  type Frame,
} from "../wire.ts";
import type { Terminal } from "../types.ts";

export interface FakeFrame {
  readonly channel: number;
  readonly kind: number;
  readonly payload: Buffer;
}

export interface FakeTerminal extends Terminal {
  output: Buffer[];
}

export interface FakeHcOptions {
  readonly generation?: number;
  readonly version?: string;
  readonly features?: readonly string[];
  readonly methods?: readonly string[];
  readonly automaticInput?: boolean;
  readonly resizeNotifications?: boolean;
  /** Answer `hello` with an error instead of a result. */
  readonly helloError?: { code: number; message: string; kind: string; hint?: string };
  /** Do not answer `hello` at all, for a test that writes its own reply. */
  readonly silentHello?: boolean;
}

interface PendingCall {
  readonly id: number | string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const EMPTY_TERMINAL: Terminal = {
  address: "t1",
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
};

export class FakeHc extends EventEmitter {
  plan: SpawnPlan | null = null;
  spawnOptions: SpawnOptions | null = null;
  readonly framesIn: FakeFrame[] = [];
  readonly calls: PendingCall[] = [];
  readonly terminals = new Map<string, FakeTerminal>();
  readonly options: FakeHcOptions;

  #plain: Buffer = Buffer.alloc(0);
  #frames = new FrameDecoder();
  #framed = false;
  #mode: "plain" | "framed" = "plain";
  #nextChannel = 1;
  #seq = 0;
  #stdin!: PassThrough;
  #stdout!: PassThrough;
  #stderr!: PassThrough;
  #child!: EventEmitter & Partial<ChildProcess>;
  #closed = false;
  /** Channels the fake core still has open. */
  readonly openChannels = new Set<number>();
  /** Bytes queued per channel before the fake core needs credit. */
  readonly creditWindows = new Map<number, number>();
  readonly creditReceived = new Map<number, number>();
  readonly #pendingStream: Map<number, Buffer> = new Map();

  constructor(options: FakeHcOptions = {}) {
    super();
    this.options = options;
  }

  /** The spawner to hand to `HcConnection`. */
  get spawner(): Spawner {
    return (plan, spawnOptions) => {
      this.plan = plan;
      this.spawnOptions = spawnOptions;
      this.#start();
      return this.#spawned();
    };
  }

  get framed(): boolean {
    return this.#framed;
  }

  /** Switches to reading frames, for a test that wrote the hello reply itself. */
  becomeFramed(): void {
    this.#framed = true;
    this.#mode = "framed";
    this.#plain = Buffer.alloc(0);
    this.#frames.reset();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Bytes the fake core queued on a channel and the client acknowledged. */
  credited(channel: number): number {
    return this.creditReceived.get(channel) ?? 0;
  }

  terminal(address = "t1", overrides: Partial<FakeTerminal> = {}): FakeTerminal {
    const record: FakeTerminal = {
      ...EMPTY_TERMINAL,
      address,
      output: [],
      ...overrides,
    };
    this.terminals.set(address, record);
    return record;
  }

  /** Sends one frame to the client, as the core's writer would. */
  sendFrame(channel: number, kind: number, payload: Uint8Array = Buffer.alloc(0)): void {
    if (this.#closed) return;
    this.#stdout.write(encodeFrame(channel, kind, payload));
  }

  /** A reply or notification: a plain line before the switch, a frame after it. */
  sendJson(message: unknown, channel = 0): void {
    const text = `${JSON.stringify(message)}\n`;
    if (this.#mode === "plain") {
      this.#stdout.write(Buffer.from(text, "utf8"));
      return;
    }
    this.sendFrame(channel, FrameKind.DATA, Buffer.from(JSON.stringify(message), "utf8"));
  }

  /** Raw bytes, for a test that wants to split a plain reply by hand. */
  sendRaw(bytes: Uint8Array): void {
    if (this.#closed) return;
    this.#stdout.write(Buffer.from(bytes));
  }

  /** A notification, which carries no id. */
  notify(method: string, params: unknown): void {
    this.sendJson({ jsonrpc: "2.0", method, params });
  }

  emitEvent(type: string, terminal: string, data: unknown): number {
    this.#seq += 1;
    this.notify("event", { seq: this.#seq, type, terminal, data });
    return this.#seq;
  }

  emitMissed(terminals: Terminal[]): number {
    this.#seq += 1;
    this.notify("missed", { seq: this.#seq, terminals });
    return this.#seq;
  }

  heartbeat(seq = this.#seq): void {
    this.notify("heartbeat", { seq });
  }

  /** Stream bytes to a viewer's attach channel. */
  streamData(channel: number, bytes: Uint8Array): void {
    this.#pendingStream.set(channel, Buffer.concat([this.#pendingStream.get(channel) ?? Buffer.alloc(0), Buffer.from(bytes)]));
    this.#flushStream(channel);
  }

  /** Ends the child, as a crashed core would. */
  crash(stderr = "the core died"): void {
    if (this.#closed) return;
    this.#stderr.write(stderr);
    this.#closed = true;
    this.#stdout.end();
    this.#stdin.end();
    this.#child.emit?.("exit", 1, null);
  }

  /** A call the client made, by method. */
  call(method: string): PendingCall | undefined {
    return this.calls.find((entry) => entry.method === method);
  }

  callsOf(method: string): PendingCall[] {
    return this.calls.filter((entry) => entry.method === method);
  }

  reply(call: PendingCall, result: unknown): void {
    this.sendJson({ jsonrpc: "2.0", id: call.id, result });
  }

  replyError(call: PendingCall, error: { code: number; message: string; kind: string; hint?: string }): void {
    this.sendJson({
      jsonrpc: "2.0",
      id: call.id,
      error: { code: error.code, message: error.message, data: { kind: error.kind, hint: error.hint ?? "" } },
    });
  }

  #flushStream(channel: number): void {
    const pending = this.#pendingStream.get(channel);
    if (!pending || pending.byteLength === 0) return;
    const window = this.creditWindows.get(channel) ?? 256 * 1024;
    if (window <= 0) return;
    const size = Math.min(window, 16 * 1024, pending.byteLength);
    const chunk = pending.subarray(0, size);
    this.#pendingStream.set(channel, pending.subarray(size));
    this.creditWindows.set(channel, window - size);
    this.sendFrame(channel, FrameKind.DATA, chunk);
  }

  #start(): void {
    this.#stdin = new PassThrough();
    this.#stdout = new PassThrough();
    this.#stderr = new PassThrough();
    this.#child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
    this.#child.kill = () => {
      this.crash("");
      return true;
    };
    this.#stdin.on("data", (chunk: Buffer) => this.#onClientBytes(chunk));
    this.#stdin.on("end", () => {
      if (!this.#closed) {
        this.#closed = true;
        this.#stdout.end();
        this.#child.emit?.("exit", 0, null);
      }
    });
    this.#stdout.on("error", () => {});
    this.#stderr.on("error", () => {});
    // Keep the pipes from keeping the process alive in tests.
    for (const stream of [this.#stdin, this.#stdout, this.#stderr]) {
      (stream as unknown as { setMaxListeners(n: number): void }).setMaxListeners(50);
      stream.resume?.();
    }
  }

  #spawned(): SpawnedProcess {
    return {
      child: this.#child as ChildProcess,
      stdin: this.#stdin,
      stdout: this.#stdout,
      stderr: this.#stderr,
    };
  }

  #onClientBytes(chunk: Buffer): void {
    if (this.#mode === "plain") {
      this.#plain = Buffer.concat([this.#plain, chunk]);
      let at = this.#plain.indexOf(0x0a);
      while (at !== -1) {
        const line = this.#plain.subarray(0, at).toString("utf8").trim();
        this.#plain = this.#plain.subarray(at + 1);
        if (line !== "") this.#onPlainMessage(line);
        at = this.#plain.indexOf(0x0a);
      }
      return;
    }
    for (const frame of this.#frames.push(chunk)) this.#onFrame(frame);
  }

  #onPlainMessage(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    this.#onCall(message);
  }

  #onFrame(frame: Frame): void {
    this.framesIn.push({ channel: frame.channel, kind: frame.kind, payload: Buffer.from(frame.payload) });
    if (frame.channel === 0 && frame.kind === FrameKind.DATA) {
      const text = Buffer.from(frame.payload).toString("utf8").trim();
      if (text === "") return;
      try {
        this.#onCall(JSON.parse(text) as Record<string, unknown>);
      } catch {
        // Not JSON: the client is at fault, and the test will see no reply.
      }
      return;
    }
    if (frame.kind === FrameKind.CREDIT) {
      const bytes = readCredit(frame.payload) ?? 0;
      this.creditReceived.set(frame.channel, this.credited(frame.channel) + bytes);
      this.creditWindows.set(frame.channel, (this.creditWindows.get(frame.channel) ?? 0) + bytes);
      this.#flushStream(frame.channel);
      return;
    }
    if (frame.kind === FrameKind.CLOSE) {
      this.openChannels.delete(frame.channel);
      this.sendFrame(frame.channel, FrameKind.CLOSE, Buffer.alloc(0));
      this.emit("viewerClosed", frame.channel);
      return;
    }
    this.emit("frame", { channel: frame.channel, kind: frame.kind, payload: Buffer.from(frame.payload) });
  }

  #onCall(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : "";
    if (method === "") return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const id = message.id as number | string | undefined;
    if (id === undefined) {
      this.emit("notification", method, params);
      return;
    }
    const call: PendingCall = { id, method, params };
    this.calls.push(call);
    // `hello` is always answered: every test needs a handshake first. Every
    // other call is the test's to answer, so it decides what the core says.
    if (call.method === "hello" && !this.options.silentHello) this.#answerHello(call);
    this.emit("call", call);
  }

  /** The handshake reply, which is the only call the fake answers by itself. */
  #answerHello(call: PendingCall): void {
    const framed = call.params.framed === true;
    if (this.options.helloError) {
      this.replyError(call, this.options.helloError);
      return;
    }
    this.#framed = framed;
    this.reply(call, {
      generation: this.options.generation ?? 1,
      version: this.options.version ?? "0.1.21",
      core: { id: "core-1", name: "rohan" },
      framed,
      methods: this.options.methods ?? ["hello", "terminal.list", "terminal.attach", "events.subscribe"],
      features: this.options.features ?? ["framed", "attach", "events", "automatic_input", "resize_notifications"],
      keeps_running_after_logout: null,
      logout_linger_user: null,
    });
    // The core switches after the reply, so the reply itself is still a line.
    this.#mode = framed ? "framed" : "plain";
  }

  /** Answers `terminal.list` with the terminals this fake holds. */
  answerList(call: PendingCall, overrides: { hidden_finished?: number } = {}): void {
    this.reply(call, {
      terminals: [...this.terminals.values()].map(({ output, ...record }) => {
        void output;
        return record;
      }),
      hidden_finished: overrides.hidden_finished ?? 0,
      machines: [],
    });
  }

  /** Answers `terminal.attach`, opening a channel and streaming its paint. */
  answerAttach(
    call: PendingCall,
    overrides: { automatic_input?: boolean; resize_notifications?: boolean; paint?: Uint8Array } = {},
  ): number {
    const channel = this.#nextChannel++;
    this.openChannels.add(channel);
    this.creditWindows.set(channel, 256 * 1024);
    const address = String(call.params.terminal ?? "t1");
    const record = this.terminals.get(address) ?? this.terminal(address);
    const { output, ...terminal } = record;
    void output;
    this.reply(call, {
      channel,
      terminal,
      automatic_input: overrides.automatic_input ?? this.options.automaticInput ?? true,
      resize_notifications: overrides.resize_notifications ?? this.options.resizeNotifications ?? false,
    });
    if (overrides.paint) this.streamData(channel, overrides.paint);
    this.emit("attached", { channel, params: call.params });
    return channel;
  }

  /** Answers `events.subscribe` with a snapshot and an event channel. */
  answerSubscribe(call: PendingCall, options: { seq?: number; channel?: number | null } = {}): number | null {
    const channel = options.channel === undefined ? this.#nextChannel++ : options.channel;
    if (channel !== null) {
      this.openChannels.add(channel);
      this.creditWindows.set(channel, 256 * 1024);
    }
    this.#seq = options.seq ?? 0;
    this.reply(call, {
      seq: this.#seq,
      terminals: [...this.terminals.values()].map(({ output, ...record }) => {
        void output;
        return record;
      }),
      channel,
    });
    this.emit("subscribed", { channel, params: call.params });
    return channel;
  }
}

/** Convenience: a fake core plus the client's transport plan. */
export function fakeHc(options: FakeHcOptions = {}): FakeHc {
  return new FakeHc(options);
}

/** Parses what a viewer sent, for assertions on RESIZE/FOCUS/FACTS. */
export function viewerFrames(fake: FakeHc, channel: number): FakeFrame[] {
  return fake.framesIn.filter((frame) => frame.channel === channel);
}

export function viewerResize(frame: FakeFrame): { cols: number; rows: number } | null {
  return readResize(frame.payload);
}

export function viewerClose(frame: FakeFrame): unknown {
  return decodeCloseReason(frame.payload);
}

export { FrameKind, creditPayload, encodeFrame, resizePayload };
