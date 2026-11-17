/**
 * One attach stream: the first paint, then the program's raw output, with the
 * viewer's keys and size going the other way.
 *
 * Flow control: a stream starts with 256 KiB of credit and the viewer returns
 * CREDIT for the bytes it consumed. A viewer that never acknowledges stalls
 * only its own stream; channel 0 and other streams keep running. Past a 4 MiB
 * backlog the core stops sending the backlog and repaints instead, so this
 * client never needs to ask for one (herdr-core 0.1.21, `docs/api.md`,
 * "Attach streams").
 */

import { EventEmitter } from "node:events";

import type { HcConnection } from "./connection.ts";
import { ControlLease, type LeaseRole } from "./lease.ts";
import { RpcError, TransportError } from "./protocol.ts";
import type { AttachParams, AttachResult, Display, Terminal } from "./types.ts";
import {
  FrameKind,
  INITIAL_STREAM_CREDIT,
  creditPayload,
  decodeCloseReason,
  focusPayload,
  readResize,
  resizePayload,
  type Frame,
} from "./wire.ts";

export interface AttachOptions {
  readonly terminal: string;
  readonly cols: number;
  readonly rows: number;
  /** Scrollback lines to show first (main screen only). */
  readonly history?: number;
  readonly observe?: boolean;
  /** Observer understands core-to-viewer RESIZE before replacement paints. */
  readonly resizeNotifications?: boolean;
  readonly display?: Display;
  readonly caller?: string | null;
  /** Back after a dropped line: sets the size only once active again. */
  readonly resumed?: boolean;
  /** Holder id in the control lease; defaults to the terminal address. */
  readonly leaseId?: string;
  /** Bytes of output that may accumulate before CREDIT goes back; defaults to 256 KiB. */
  readonly creditBatch?: number;
}

export interface AttachEvents {
  /** The first paint and every later chunk of the program's output. */
  data: [Uint8Array];
  resize: [{ cols: number; rows: number }];
  /** The program ended, the core ended the stream, or the viewer detached. */
  close: [{ reason: unknown; detached: boolean }];
  /** The connection died under the stream; reattach after reconciling. */
  lost: [TransportError];
}

export class AttachStream extends EventEmitter<AttachEvents> {
  readonly #connection: HcConnection;
  readonly #options: AttachOptions;
  readonly #lease: ControlLease;
  readonly #creditBatch: number;

  #result: AttachResult | null = null;
  #channel: number | null = null;
  #closed = false;
  #detachedByViewer = false;
  /** Bytes received and not yet acknowledged with CREDIT. */
  #uncredited = 0;
  /** Bytes the core may still send before it needs more credit. */
  #window = INITIAL_STREAM_CREDIT;
  #paintReceived = false;
  /** The first paint can land before the caller has attached its listener. */
  readonly #early: Uint8Array[] = [];
  /** The reason a core-sent CLOSE carried, for a late `close` listener. */
  #closeReason: unknown = null;

  constructor(connection: HcConnection, options: AttachOptions, lease?: ControlLease) {
    super();
    this.#connection = connection;
    this.#options = options;
    this.#lease = lease ?? new ControlLease();
    this.#creditBatch = options.creditBatch ?? INITIAL_STREAM_CREDIT;
    if (!options.observe) {
      this.#lease.attach(options.leaseId ?? options.terminal, "control");
    } else {
      this.#lease.attach(options.leaseId ?? options.terminal, "observe");
    }
  }

  get result(): AttachResult | null {
    return this.#result;
  }

  get channel(): number | null {
    return this.#channel;
  }

  get terminal(): Terminal | null {
    return this.#result?.terminal ?? null;
  }

  get lease(): ControlLease {
    return this.#lease;
  }

  get role(): LeaseRole {
    return this.#lease.canControl(this.#leaseId) ? "control" : "observe";
  }

  get closed(): boolean {
    return this.#closed;
  }

  get paintReceived(): boolean {
    return this.#paintReceived;
  }

  /** Bytes the core may still send before this viewer must acknowledge. */
  get window(): number {
    return this.#window;
  }

  /**
   * Subscribes to a stream event, replaying the ones that arrived before the
   * listener existed. The first paint and a fast close come with the attach
   * reply, so they can precede any caller-side listener.
   */
  override on(...args: Parameters<EventEmitter<AttachEvents>["on"]>): this {
    super.on(...args);
    this.#replay(args[0], args[1]);
    return this;
  }

  override once(...args: Parameters<EventEmitter<AttachEvents>["once"]>): this {
    super.once(...args);
    this.#replay(args[0], args[1]);
    return this;
  }

  get #leaseId(): string {
    return this.#options.leaseId ?? this.#options.terminal;
  }

  /** Delivers what arrived before this listener did, then drops it. */
  #replay(event: string | symbol, listener: (...args: never[]) => void): void {
    if (event === "data") {
      const deliver = listener as (bytes: Uint8Array) => void;
      for (const bytes of this.#early.splice(0)) deliver(bytes);
      return;
    }
    if (event === "close" && this.#closed && !this.#detachedByViewer) {
      const deliver = listener as (event: { reason: unknown; detached: boolean }) => void;
      deliver({ reason: this.#closeReason, detached: false });
    }
  }

  /** The channel this viewer writes on; a stream cannot be used before it opened. */
  #openChannel(): number {
    if (this.#channel === null) throw new TransportError("the attach stream is not open yet");
    return this.#channel;
  }

  /**
   * Opens the stream. The reply arrives before any stream frame, so the first
   * paint cannot race the channel number.
   */
  async open(): Promise<AttachResult> {
    if (this.#result !== null) throw new TransportError("attach already opened");
    if (this.#connection.mode !== "framed") {
      throw new RpcError(-32000, "attach needs a framed connection", {
        kind: "needs_framed",
        hint: "send hello with framed: true first",
      });
    }
    const params: AttachParams = {
      terminal: this.#options.terminal,
      cols: this.#options.cols,
      rows: this.#options.rows,
      history: this.#options.history ?? 0,
      observe: this.#options.observe ?? false,
      resize_notifications: this.#options.resizeNotifications ?? false,
    };
    if (this.#options.display) params.display = this.#options.display;
    if (this.#options.resumed) params.resumed = true;
    if (this.#options.caller !== undefined) params.caller = this.#options.caller;

    let result: AttachResult;
    try {
      result = await this.#connection.request<AttachResult>("terminal.attach", params);
    } catch (error) {
      this.#lease.detach(this.#leaseId);
      throw error;
    }
    this.#result = result;
    this.#channel = result.channel;
    this.#connection.registerChannel(result.channel, {
      onFrame: (frame) => this.#onFrame(frame),
      onChannelClosed: (error) => this.#onConnectionClosed(error),
    });
    return result;
  }

  /** Whether the whole path accepts AUTOMATIC_INPUT: both hello and attach must say so. */
  get automaticInputSupported(): boolean {
    return this.#connection.supports("automatic_input") && this.#result?.automatic_input === true;
  }

  /** Keys from a person, or from this client acting as one. */
  async sendInput(bytes: Uint8Array): Promise<void> {
    const channel = this.#openChannel();
    this.#assertCanType();
    await this.#connection.sendFrame(channel, FrameKind.DATA, bytes);
  }

  /**
   * Terminal-generated replies (query answers). Untagged input would take
   * display ownership and reset the human quiet period, so it is never sent as
   * DATA when the path supports the tag.
   */
  async sendAutomaticInput(bytes: Uint8Array): Promise<void> {
    // An observer never types, and a query answer is typing to the program.
    if (this.#options.observe) throw new TransportError("an observer never types into the terminal");
    const channel = this.#openChannel();
    if (this.automaticInputSupported) {
      await this.#connection.sendFrame(channel, FrameKind.AUTOMATIC_INPUT, bytes);
      return;
    }
    this.#assertCanType();
    await this.#connection.sendFrame(channel, FrameKind.DATA, bytes);
  }

  async resize(cols: number, rows: number): Promise<void> {
    const channel = this.#openChannel();
    this.#lease.assertCanResize(this.#leaseId);
    await this.#connection.sendFrame(channel, FrameKind.RESIZE, resizePayload(cols, rows));
  }

  async focus(focused: boolean): Promise<void> {
    await this.#connection.sendFrame(this.#openChannel(), FrameKind.FOCUS, focusPayload(focused));
  }

  async reportDisplayFacts(display: Display): Promise<void> {
    await this.#connection.sendFrame(
      this.#openChannel(),
      FrameKind.FACTS,
      Buffer.from(JSON.stringify(display), "utf8"),
    );
  }

  /**
   * A viewer detaches by sending CLOSE; the core answers with an empty CLOSE.
   * The stream is over either way, so it ends here rather than waiting.
   */
  async detach(): Promise<void> {
    if (this.#closed) return;
    this.#detachedByViewer = true;
    const channel = this.#channel;
    this.#finish({ reason: null, detached: true });
    if (channel !== null) {
      this.#connection.unregisterChannel(channel);
      try {
        await this.#connection.sendFrame(channel, FrameKind.CLOSE, Buffer.alloc(0));
      } catch {
        // A connection that died first has nothing left to close.
      }
    }
  }

  /** Gives control to another viewer without dropping this stream. */
  handOffControl(to: string): void {
    this.#lease.take(to);
  }

  /** Ends the stream as lost when the connection under it died. */
  handleConnectionLost(error: TransportError): void {
    if (this.#closed) return;
    this.#onConnectionClosed(error);
  }

  #assertCanType(): void {
    if (this.#options.observe) {
      throw new TransportError("an observer never types into the terminal");
    }
    this.#lease.assertCanInput(this.#leaseId);
  }

  #onFrame(frame: Frame): void {
    if (this.#closed) return;
    switch (frame.kind) {
      case FrameKind.DATA:
        this.#paintReceived = true;
        this.#consume(frame.payload);
        if (this.listenerCount("data") === 0) this.#early.push(new Uint8Array(frame.payload));
        else this.emit("data", new Uint8Array(frame.payload));
        return;
      case FrameKind.RESIZE: {
        const size = readResize(frame.payload);
        if (size) this.emit("resize", size);
        return;
      }
      case FrameKind.CLOSE:
        this.#connection.unregisterChannel(frame.channel);
        this.#finish({ reason: decodeCloseReason(frame.payload), detached: this.#detachedByViewer });
        return;
      default:
        return;
    }
  }

  /**
   * Credit returns bytes the core may send again. It goes back once a batch of
   * output is consumed, so a busy stream does not need a frame per chunk.
   */
  #consume(payload: Uint8Array): void {
    this.#uncredited += payload.byteLength;
    this.#window -= payload.byteLength;
    if (this.#uncredited >= this.#creditBatch) this.#flushCredit();
  }

  #flushCredit(): void {
    const bytes = this.#uncredited;
    if (bytes === 0 || this.#channel === null) return;
    this.#uncredited = 0;
    this.#window += bytes;
    void this.#connection.sendFrame(this.#channel, FrameKind.CREDIT, creditPayload(bytes)).catch(() => {
      // The stream is already gone if the connection refused the frame.
    });
  }

  #onConnectionClosed(error: TransportError | null): void {
    if (this.#closed) return;
    this.#connection.unregisterChannel(this.#channel ?? -1);
    const lost = error ?? new TransportError("the core connection ended");
    this.#finish(null);
    this.emit("lost", lost);
  }

  #finish(reason: { reason: unknown; detached: boolean } | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#uncredited = 0;
    if (this.#channel !== null) this.#connection.unregisterChannel(this.#channel);
    this.#lease.detach(this.#leaseId);
    if (reason !== null) {
      this.#closeReason = reason.reason;
      this.emit("close", reason);
    }
  }
}
