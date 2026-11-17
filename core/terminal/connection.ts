/**
 * One herdr-core connection: JSON-RPC multiplexed over channel 0, with the
 * optional framed mode for attach and event streams.
 *
 * A connection starts in plain mode (one JSON-RPC message per line). A
 * successful `hello` with `framed: true` switches it to frames after its reply
 * (herdr-core 0.1.21, `docs/api.md`).
 */

import type { SpawnOptions } from "node:child_process";
import type { Writable } from "node:stream";

import {
  PROTOCOL_GENERATION,
  RpcError,
  TransportError,
  isJsonRpcNotification,
  isJsonRpcResponse,
  parseMessage,
  rpcErrorFrom,
  type JsonRpcId,
} from "./protocol.ts";
import { defaultSpawner, SPAWN_OPTIONS, type SpawnPlan, type Spawner } from "./transport.ts";
import type { HelloResult } from "./types.ts";
import { FrameDecoder, FrameKind, encodeFrame, type Frame } from "./wire.ts";

export type ConnectionMode = "plain" | "framed";

export interface FrameSink {
  /** Receives every frame on this channel, in wire order. */
  onFrame(frame: Frame): void;
  /** The connection ended; nothing more arrives on this channel. */
  onChannelClosed?(error: TransportError | null): void;
}

export interface ConnectionOptions {
  readonly plan: SpawnPlan;
  readonly spawner?: Spawner;
  readonly spawnOptions?: SpawnOptions;
  /** Per-request timeout; a core answers fast unless the call itself waits. */
  readonly requestTimeoutMs?: number;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
}

type NotificationHandler = (method: string, params: unknown) => void;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout | null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const NEWLINE = 0x0a;
const MAX_STDERR_TAIL = 8 * 1024;
/** Frames held for a channel whose reply has not resolved yet. */
const ORPHAN_BYTE_LIMIT = 4 * 1024 * 1024;

export class HcConnection {
  readonly #plan: SpawnPlan;
  readonly #spawner: Spawner;
  readonly #spawnOptions: SpawnOptions;
  readonly #requestTimeoutMs: number;

  #stdin: Writable | null = null;
  #child: { kill(signal?: NodeJS.Signals): boolean } | null = null;

  #mode: ConnectionMode = "plain";
  #frames = new FrameDecoder();
  #readBuffer: Buffer = Buffer.alloc(0);

  #nextId = 1;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #sinks = new Map<number, FrameSink>();
  /**
   * Frames for a channel whose reply the caller has not returned from yet. The
   * core puts the attach reply before the first paint, but both can land in one
   * read, and the sink is registered after the reply resolves.
   */
  readonly #orphans = new Map<number, Frame[]>();
  #orphanBytes = 0;
  #notificationHandler: NotificationHandler | null = null;
  #closeHandler: ((error: TransportError | null) => void) | null = null;
  #stderrTail = "";

  #hello: HelloResult | null = null;
  #closed = false;
  #closing: TransportError | null = null;
  #spawnError: TransportError | null = null;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: ConnectionOptions) {
    this.#plan = options.plan;
    this.#spawner = options.spawner ?? defaultSpawner;
    this.#spawnOptions = options.spawnOptions ?? SPAWN_OPTIONS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get mode(): ConnectionMode {
    return this.#mode;
  }

  get hello(): HelloResult | null {
    return this.#hello;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get plan(): SpawnPlan {
    return this.#plan;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  open(): this {
    if (this.#stdin !== null) throw new TransportError("connection already open");
    let spawned;
    try {
      spawned = this.#spawner(this.#plan, this.#spawnOptions);
    } catch (cause) {
      throw new TransportError(`cannot start ${this.#plan.command}: ${describeCause(cause)}`, { cause });
    }
    this.#child = spawned.child;
    this.#stdin = spawned.stdin;
    spawned.stdout.on("data", (chunk: Buffer) => this.#onBytes(chunk));
    spawned.stdout.on("end", () => this.#end(null));
    spawned.stdout.on("error", (error: Error) => this.#end(new TransportError(`stdout: ${error.message}`)));
    spawned.stdin.on("error", (error: Error) => {
      if (this.#stderrTail === "") this.#stderrTail = `stdin: ${error.message}`;
    });
    spawned.stderr.on("data", (chunk: Buffer) => {
      this.#stderrTail = (this.#stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_TAIL);
    });
    spawned.child.on("exit", () => this.#end(null));
    // A missing binary fails after `spawn` returns; the connection must hear it.
    spawned.spawnFailure?.catch((error: unknown) => {
      const failure = error instanceof TransportError ? error : new TransportError(describeCause(error));
      this.#spawnError = failure;
      this.#end(failure);
    });
    return this;
  }

  /**
   * Switches to framed mode. The core switches after the `hello` reply, so
   * anything still buffered is already frames.
   */
  useFramedMode(): void {
    if (this.#mode === "framed") return;
    this.#mode = "framed";
    this.#frames.reset();
  }

  /**
   * Handshake: protocol generation 1, and framed mode when the caller wants
   * streams. Refuses a core that speaks another generation.
   */
  async handshake(
    options: { framed?: boolean; features?: readonly string[]; core?: { id: string; name: string } } = {},
  ): Promise<HelloResult> {
    const framed = options.framed ?? false;
    const params: Record<string, unknown> = { generation: PROTOCOL_GENERATION, framed };
    if (options.features) params.features = [...options.features];
    if (options.core) params.core = options.core;
    const result = await this.request<HelloResult>("hello", params);
    if (result.generation !== PROTOCOL_GENERATION) {
      throw new RpcError(-32000, `the core speaks generation ${result.generation}`, {
        kind: "unsupported_generation",
        hint: `this client speaks generation ${PROTOCOL_GENERATION}`,
      });
    }
    this.#hello = result;
    if (framed) this.useFramedMode();
    return result;
  }

  /** Whether the core advertised a feature in `hello.features`. */
  supports(feature: string): boolean {
    return this.#hello?.features.includes(feature) ?? false;
  }

  onNotification(handler: NotificationHandler | null): void {
    this.#notificationHandler = handler;
  }

  onClose(handler: ((error: TransportError | null) => void) | null): void {
    this.#closeHandler = handler;
  }

  registerChannel(channel: number, sink: FrameSink): void {
    if (this.#sinks.has(channel)) throw new TransportError(`channel ${channel} already in use`);
    this.#sinks.set(channel, sink);
    const orphans = this.#orphans.get(channel);
    if (orphans) {
      this.#orphans.delete(channel);
      for (const frame of orphans) {
        this.#orphanBytes -= frame.payload.byteLength;
        try {
          sink.onFrame(frame);
        } catch {
          // One stream's consumer must not take the whole connection down.
        }
      }
    }
  }

  unregisterChannel(channel: number): void {
    this.#sinks.delete(channel);
    const orphans = this.#orphans.get(channel);
    if (orphans) {
      this.#orphans.delete(channel);
      for (const frame of orphans) this.#orphanBytes -= frame.payload.byteLength;
    }
  }

  async request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.#closed) throw this.#closing ?? new TransportError("the connection is closed");
    const id = this.#nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new TransportError(`${method} got no answer within ${timeoutMs} ms`));
            }, timeoutMs)
          : null;
      timer?.unref?.();
      this.#pending.set(id, { method, resolve, reject, timer });
    });
    // A reply can be rejected while its own frame is still being written (the
    // connection died first). This handler makes that rejection observed; the
    // `await` below still delivers it to the caller.
    reply.catch(() => {});
    try {
      await this.#send(message);
    } catch (cause) {
      this.#settle(id);
      throw cause;
    }
    return (await reply) as T;
  }

  /** Writes one frame on a channel: viewer input, credit, control frames. */
  sendFrame(channel: number, kind: number, payload: Uint8Array = Buffer.alloc(0)): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closing ?? new TransportError("the connection is closed"));
    return this.#write(encodeFrame(channel, kind, payload));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = new TransportError("the connection was closed");
    this.#failPending(this.#closing);
    this.#notifyChannelsClosed(this.#closing);
    const stdin = this.#stdin;
    this.#stdin = null;
    try {
      stdin?.end();
    } catch {
      // A child that already exited closes its own pipes.
    }
    try {
      this.#child?.kill();
    } catch {
      // Nothing left to end.
    }
    this.#closeHandler?.(null);
  }

  #settle(id: JsonRpcId): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
  }

  #failPending(error: TransportError): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  #notifyChannelsClosed(error: TransportError | null): void {
    const sinks = [...this.#sinks.values()];
    this.#sinks.clear();
    for (const sink of sinks) sink.onChannelClosed?.(error);
  }

  #send(message: string): Promise<void> {
    const bytes = Buffer.from(`${message}\n`, "utf8");
    if (this.#mode === "framed") return this.#write(encodeFrame(0, FrameKind.DATA, bytes));
    return this.#write(bytes);
  }

  #write(bytes: Uint8Array): Promise<void> {
    const stdin = this.#stdin;
    if (!stdin) return Promise.reject(this.#closing ?? new TransportError("the connection is closed"));
    const chunk = Buffer.from(bytes);
    const write = new Promise<void>((resolve, reject) => {
      stdin.write(chunk, (error) => {
        if (!error) {
          resolve();
          return;
        }
        // A pipe breaks because the program is not there: the spawn error says
        // which program and why, so let it win over "EPIPE".
        setImmediate(() => reject(this.#spawnError ?? new TransportError(`cannot write to ${this.#plan.command}: ${error.message}`)));
      });
    });
    // The chain itself must never carry an unhandled rejection: a write that
    // fails is reported to its own caller, not to the process.
    const next = this.#writeChain.then(
      () => write,
      () => write,
    );
    this.#writeChain = next.catch(() => {});
    return next;
  }

  #onBytes(chunk: Buffer): void {
    this.#readBuffer = this.#readBuffer.byteLength === 0 ? chunk : Buffer.concat([this.#readBuffer, chunk]);
    if (this.#mode === "plain") this.#drainPlain();
    else this.#drainFrames();
  }

  #drainPlain(): void {
    while (this.#mode === "plain") {
      const at = this.#readBuffer.indexOf(NEWLINE);
      if (at === -1) return;
      const line = this.#readBuffer.subarray(0, at).toString("utf8").trim();
      this.#readBuffer = this.#readBuffer.subarray(at + 1);
      if (line !== "") this.#onMessage(line);
    }
    // The hello reply switched the connection: what is left is frames.
    this.#drainFrames();
  }

  #drainFrames(): void {
    if (this.#readBuffer.byteLength === 0) return;
    let frames: Frame[];
    try {
      frames = this.#frames.push(this.#readBuffer);
    } catch (cause) {
      this.#end(new TransportError(cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    this.#readBuffer = Buffer.alloc(0);
    for (const frame of frames) this.#onFrame(frame);
  }

  #onMessage(line: string): void {
    const message = parseMessage(line);
    if (message === null) {
      this.#end(new TransportError(`the core sent a line that is not JSON: ${line.slice(0, 200)}`));
      return;
    }
    this.#dispatch(message);
  }

  #onFrame(frame: Frame): void {
    if (frame.channel === 0) {
      if (frame.kind !== FrameKind.DATA) return;
      const message = parseMessage(frame.payload);
      if (message === null) {
        this.#end(new TransportError("the core sent a channel-0 frame that is not JSON"));
        return;
      }
      this.#dispatch(message);
      return;
    }
    const sink = this.#sinks.get(frame.channel);
    if (!sink) {
      // The attach reply may still be resolving, and its first paint can share
      // the same read. Held under a byte cap until the channel is registered.
      if (frame.kind === FrameKind.CLOSE || this.#orphanBytes + frame.payload.byteLength > ORPHAN_BYTE_LIMIT) return;
      const queued = this.#orphans.get(frame.channel);
      this.#orphanBytes += frame.payload.byteLength;
      if (queued) queued.push(frame);
      else this.#orphans.set(frame.channel, [frame]);
      return;
    }
    try {
      sink.onFrame(frame);
    } catch {
      // One stream's consumer must not take the whole connection down.
    }
  }

  #dispatch(message: unknown): void {
    if (isJsonRpcResponse(message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#settle(message.id);
      if ("error" in message) {
        pending.reject(rpcErrorFrom(message));
        return;
      }
      // The core switches mode after its hello reply: the next bytes are frames.
      if (pending.method === "hello" && (message.result as { framed?: unknown } | null)?.framed === true) {
        this.useFramedMode();
      }
      pending.resolve(message.result);
      return;
    }
    if (isJsonRpcNotification(message)) this.#notificationHandler?.(message.method, message.params);
  }

  #end(error: TransportError | null): void {
    if (this.#closed) return;
    this.#closed = true;
    const tail = this.#stderrTail.trim();
    const detail = error ? `: ${error.message}` : tail === "" ? "" : `: ${tail.split("\n").at(-1) ?? ""}`;
    this.#closing = this.#spawnError ?? new TransportError(`the core connection ended${detail}`);
    this.#failPending(this.#closing);
    this.#notifyChannelsClosed(this.#closing);
    this.#stdin = null;
    this.#closeHandler?.(this.#closing);
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
