/**
 * The herdr-core client: one framed connection, multiplexed requests, attach
 * streams and an event subscription reconciled against snapshots.
 *
 * Every mutation here is a terminal operation. Nothing in this module writes a
 * mission, an agent record or a task: terminal state is read-only to the rest
 * of the core, and OSC 7501 status is stored as the program reported it.
 */

import { EventEmitter } from "node:events";

import { AttachStream, type AttachOptions } from "./attach.ts";
import { HcConnection, type ConnectionOptions } from "./connection.ts";
import { ControlLease, type LeaseOptions } from "./lease.ts";
import { RpcError, TransportError } from "./protocol.ts";
import { TerminalRegistry } from "./registry.ts";
import { localConnectPlan, sshConnectPlan, type SpawnPlan, type SshConnectConfig } from "./transport.ts";
import type {
  AttachResult,
  EventParams,
  HeartbeatParams,
  HelloResult,
  InitialSize,
  InterruptResult,
  KeepParams,
  ListResult,
  MissedParams,
  RunParams,
  RunResult,
  SendParams,
  SendResult,
  SubscribeParams,
  SubscribeResult,
  Terminal,
} from "./types.ts";
import { FrameKind, creditPayload, decodeCloseReason } from "./wire.ts";

export interface HcClientOptions {
  /** `local` runs `hc connect`; `ssh` runs it on the target over ssh. */
  readonly transport:
    | { kind: "local"; session?: string | null; program?: string }
    | ({ kind: "ssh" } & SshConnectConfig);
  /** A ready plan, for a caller that built its own. */
  readonly plan?: SpawnPlan;
  readonly spawner?: ConnectionOptions["spawner"];
  readonly requestTimeoutMs?: number;
  readonly lease?: LeaseOptions;
}

export interface HcClientEvents {
  /** The core connection ended; everything read from it is stale. */
  disconnected: [TransportError | null];
  event: [EventParams];
  heartbeat: [HeartbeatParams];
  missed: [MissedParams];
}

export class HcClient extends EventEmitter<HcClientEvents> {
  readonly #connection: HcConnection;
  readonly #registry = new TerminalRegistry();
  readonly #lease: ControlLease;
  readonly #streams = new Set<AttachStream>();
  #subscribeChannel: number | null = null;

  constructor(options: HcClientOptions) {
    super();
    const plan = options.plan ?? planFor(options.transport);
    this.#connection = new HcConnection({
      plan,
      spawner: options.spawner,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    this.#lease = new ControlLease(options.lease);
    this.#connection.onNotification((method, params) => this.#onNotification(method, params));
    this.#connection.onClose((error) => this.#onDisconnected(error));
  }

  get connection(): HcConnection {
    return this.#connection;
  }

  get registry(): TerminalRegistry {
    return this.#registry;
  }

  get lease(): ControlLease {
    return this.#lease;
  }

  get hello(): HelloResult | null {
    return this.#connection.hello;
  }

  /** Streams this client opened, so a disconnect can end all of them. */
  get streams(): AttachStream[] {
    return [...this.#streams];
  }

  /** Starts the child and performs the handshake, framed when streams are wanted. */
  async connect(options: { framed?: boolean; features?: readonly string[]; core?: { id: string; name: string } } = {}): Promise<HelloResult> {
    this.#connection.open();
    return this.#connection.handshake({ framed: options.framed ?? true, ...options });
  }

  close(): void {
    for (const stream of this.#streams) void stream.detach();
    this.#streams.clear();
    this.#connection.close();
  }

  /**
   * Starts a program. Only the fields the caller set are sent: the core has
   * its own defaults, and an omitted `cwd`, `line` or `size` is not a null.
   *
   * `cols` and `rows` travel as `size`; `env` overrides the core's environment
   * and terminal identity; `keep` replaces a lost program with a shell in place.
   */
  async run(params: RunParams): Promise<RunResult> {
    const request: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      request[key] = key === "size" ? validateInitialSize(value as InitialSize) : value;
    }
    return this.#connection.request<RunResult>("terminal.run", request);
  }

  async list(options: { all?: boolean; labels?: Record<string, string> } = {}): Promise<ListResult> {
    const result = await this.#connection.request<ListResult>("terminal.list", {
      all: options.all ?? false,
      labels: options.labels ?? {},
    });
    return result;
  }

  async get(terminal: string, caller?: string | null): Promise<Terminal> {
    const params: Record<string, unknown> = { terminal };
    if (caller !== undefined) params.caller = caller;
    return this.#connection.request<Terminal>("terminal.get", params);
  }

  async kill(terminal: string, caller?: string | null): Promise<Terminal> {
    const params: Record<string, unknown> = { terminal };
    if (caller !== undefined) params.caller = caller;
    return this.#connection.request<Terminal>("terminal.kill", params);
  }

  async keep(terminal: string, keep: boolean): Promise<Terminal> {
    const params: KeepParams = { terminal, keep };
    return this.#connection.request<Terminal>("terminal.keep", params);
  }

  async send(params: SendParams): Promise<SendResult> {
    return this.#connection.request<SendResult>("terminal.send", params);
  }

  async interrupt(terminal: string, timeout?: number | null): Promise<InterruptResult> {
    const params: Record<string, unknown> = { terminal };
    if (timeout !== undefined && timeout !== null) params.timeout = timeout;
    return this.#connection.request<InterruptResult>("terminal.interrupt", params);
  }

  /**
   * Opens a raw stream. The reply precedes every stream frame, so the first
   * paint can never arrive before the channel is known.
   */
  async attach(options: AttachOptions): Promise<AttachStream> {
    const stream = new AttachStream(this.#connection, options, this.#lease);
    this.#streams.add(stream);
    const forget = () => this.#streams.delete(stream);
    stream.once("close", forget);
    stream.once("lost", forget);
    try {
      await stream.open();
    } catch (error) {
      forget();
      throw error;
    }
    return stream;
  }

  /**
   * Subscribes to facts: a snapshot, then every change in order. In framed mode
   * the events ride their own channel with credit; a slow reader gets `missed`
   * and a fresh snapshot rather than a backlog.
   */
  async subscribe(params: SubscribeParams = {}): Promise<{ result: SubscribeResult; reconciled: boolean }> {
    const request: SubscribeParams = {};
    if (params.terminal !== undefined) request.terminal = params.terminal;
    if (params.children_of !== undefined) request.children_of = params.children_of;
    if (params.labels !== undefined) request.labels = params.labels;
    if (params.docs !== undefined) request.docs = params.docs;
    const result = await this.#connection.request<SubscribeResult>("events.subscribe", request);
    this.#registry.applySnapshot({ seq: result.seq, terminals: result.terminals });
    if (this.#connection.mode === "framed" && typeof result.channel === "number") {
      this.#subscribeChannel = result.channel;
      this.#connection.registerChannel(result.channel, {
        onFrame: (frame) => this.#onEventFrame(frame.kind, frame.payload),
        onChannelClosed: () => {
          this.#subscribeChannel = null;
        },
      });
    }
    return { result, reconciled: true };
  }

  /**
   * Reconciles after a reconnect: a fresh subscription snapshot replaces the
   * view wholesale. `seq` restarts with each core process, so nothing from
   * before the break is replayed.
   */
  async resync(params: SubscribeParams = {}): Promise<SubscribeResult> {
    this.#registry.markDisconnected(null);
    const { result } = await this.subscribe(params);
    return result;
  }

  #onEventFrame(kind: number, payload: Uint8Array): void {
    if (kind === FrameKind.CLOSE) {
      const reason = decodeCloseReason(payload);
      this.emit("disconnected", new TransportError(`the event stream ended: ${JSON.stringify(reason)}`));
      return;
    }
    if (kind !== FrameKind.DATA) return;
    if (this.#subscribeChannel !== null) {
      void this.#connection
        .sendFrame(this.#subscribeChannel, FrameKind.CREDIT, creditPayload(payload.byteLength))
        .catch(() => {});
    }
    for (const line of Buffer.from(payload).toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(trimmed) as unknown;
      } catch {
        continue;
      }
      this.#onNotification(
        typeof (message as { method?: unknown }).method === "string"
          ? ((message as { method: string }).method)
          : "",
        (message as { params?: unknown }).params,
      );
    }
  }

  #onNotification(method: string, params: unknown): void {
    if (method === "event") {
      const event = params as EventParams;
      this.#registry.applyEvent(event);
      this.emit("event", event);
      return;
    }
    if (method === "heartbeat") {
      this.emit("heartbeat", params as HeartbeatParams);
      return;
    }
    if (method === "missed") {
      const missed = params as MissedParams;
      this.#registry.applySnapshot({ seq: missed.seq, terminals: missed.terminals });
      this.emit("missed", missed);
    }
  }

  #onDisconnected(error: TransportError | null): void {
    // A dropped line makes every fact suspect, whether or not a subscription
    // was live: `seq` restarts with the core, so nothing can be ordered.
    this.#registry.markDisconnected(error);
    this.#subscribeChannel = null;
    for (const stream of this.#streams) {
      if (!stream.closed) stream.handleConnectionLost(error ?? new TransportError("the core connection ended"));
    }
    this.#streams.clear();
    this.emit("disconnected", error);
  }
}

/** The core refuses a size below 1 in either dimension; say so before sending. */
function validateInitialSize(size: InitialSize): InitialSize {
  for (const [name, value] of [
    ["cols", size.cols],
    ["rows", size.rows],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new TransportError(`size.${name} must be an integer 1-65535, got ${value}`);
    }
  }
  return size;
}

export function planFor(transport: HcClientOptions["transport"]): SpawnPlan {
  if (transport.kind === "ssh") {
    const { kind, ...config } = transport;
    void kind;
    return sshConnectPlan(config);
  }
  return localConnectPlan({ program: transport.program, session: transport.session });
}

export { RpcError, TransportError };
export type { AttachResult };
