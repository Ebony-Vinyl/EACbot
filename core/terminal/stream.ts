/**
 * The browser side of a terminal: the WebSocket protocol a viewer speaks, and
 * the port the HTTP layer reads its terminal list from.
 *
 * The server sends a JSON `ready` first, then the program's output as binary
 * frames. A viewer sends binary frames for keystrokes and JSON for control.
 * Credit is end to end: this stream starts with 256 KiB of window and the
 * viewer returns what xterm consumed, so a viewer that stops reading stalls
 * only its own stream and the core never buffers on our behalf.
 */

import type { DuplexLike, TerminalPort, TerminalStream, TerminalStreamHandler } from "../http/ports.ts";
import { encodeBinary, encodeText } from "../http/websocket.ts";
import { isPermissionScope, scopeSatisfies, type PermissionScope } from "../identity/scopes.ts";
import { TerminalService, terminalErrorCode, type TerminalAttachment, type TerminalServiceEvents } from "./service.ts";

export const DEFAULT_HISTORY_LINES = 1_000;

/** A control message is a small JSON object; anything else is program input. */
const MAX_CONTROL_BYTES = 4 * 1024;

/** Input that arrives before the attach resolved is held this long. A viewer
 * that types before `ready` is not typing into a terminal yet. */
const MAX_EARLY_INPUT_BYTES = 64 * 1024;

const CONTROL_TYPES = new Set(["resize", "credit", "close"]);

type ClientControl =
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | { readonly type: "credit"; readonly bytes: number }
  | { readonly type: "close" };

/** The HTTP layer hands a stream every payload it decoded, text and binary
 * alike, so the only way to tell a control message from keystrokes is the
 * payload itself: a JSON object with one of the three control types. */
export function parseControlMessage(payload: Uint8Array): ClientControl | null {
  if (payload.byteLength === 0 || payload.byteLength > MAX_CONTROL_BYTES) return null;
  if (payload[0] !== 0x7b) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string" || !CONTROL_TYPES.has(record.type)) return null;
  if (record.type === "resize") {
    return { type: "resize", cols: Number(record.cols), rows: Number(record.rows) };
  }
  if (record.type === "credit") return { type: "credit", bytes: Number(record.bytes) };
  return { type: "close" };
}

/** A viewer's scope decides whether it may type at all; a `readonly` session
 * only watches, whatever its browser asks for. */
export function mayControl(scope: string, observe: boolean): boolean {
  if (observe) return false;
  if (!isPermissionScope(scope)) return false;
  return scopeSatisfies(scope as PermissionScope, "device");
}

export interface TerminalStreamsOptions {
  readonly service: TerminalService;
  readonly history?: number;
}

/** The `TerminalStreamHandler` the HTTP layer composes. It owns no policy:
 * the service owns terminals, the lease and the core connection. */
export class TerminalStreams implements TerminalStreamHandler {
  readonly #service: TerminalService;
  readonly #history: number;

  constructor(options: TerminalStreamsOptions) {
    this.#service = options.service;
    this.#history = options.history ?? DEFAULT_HISTORY_LINES;
  }

  open(input: { terminalId: string; sessionId: string; scope: string; socket: DuplexLike }): TerminalStream {
    return new BrowserTerminalStream({
      service: this.#service,
      history: this.#history,
      terminalId: input.terminalId,
      viewerId: input.sessionId,
      canControl: mayControl(input.scope, false),
      socket: input.socket,
    });
  }
}

interface BrowserTerminalStreamOptions {
  readonly service: TerminalService;
  readonly history: number;
  readonly terminalId: string;
  readonly viewerId: string;
  readonly canControl: boolean;
  readonly socket: DuplexLike;
}

export class BrowserTerminalStream implements TerminalStream {
  readonly #service: TerminalService;
  readonly #history: number;
  readonly #terminalId: string;
  readonly #viewerId: string;
  readonly #socket: DuplexLike;
  #canControl: boolean;

  #attachment: TerminalAttachment | null = null;
  #closed = false;
  #ended = false;
  /** Bytes sent to the viewer and not yet credited back to the core. */
  #unacked = 0;
  #earlyInput: Uint8Array[] = [];
  #earlyBytes = 0;
  #toldAboutControl = false;
  readonly #listeners: { event: string; listener: (...args: never[]) => void }[] = [];

  constructor(options: BrowserTerminalStreamOptions) {
    this.#service = options.service;
    this.#history = options.history;
    this.#terminalId = options.terminalId;
    this.#viewerId = options.viewerId;
    this.#canControl = options.canControl;
    this.#socket = options.socket;
    this.#subscribe();
    void this.#open();
  }

  /** True while the viewer holds control, which is what `ready` reported. */
  get canControl(): boolean {
    return this.#canControl;
  }

  get attachment(): TerminalAttachment | null {
    return this.#attachment;
  }

  receive(data: Uint8Array): void {
    if (this.#closed) return;
    const control = parseControlMessage(data);
    if (control === null) {
      this.#onInput(data);
      return;
    }
    if (control.type === "close") {
      void this.close();
      return;
    }
    if (control.type === "credit") {
      this.#onCredit(control.bytes);
      return;
    }
    void this.#onResize(control.cols, control.rows);
  }

  close(): Promise<void> | void {
    if (this.#closed) return;
    this.#closed = true;
    for (const { event, listener } of this.#listeners.splice(0)) {
      this.#service.off(event, listener as never);
    }
    this.#earlyInput = [];
    this.#earlyBytes = 0;
    const attachment = this.#attachment;
    this.#attachment = null;
    if (attachment) void attachment.stream.detach().catch(() => {});
  }

  async #open(): Promise<void> {
    let attachment: TerminalAttachment;
    try {
      attachment = await this.#service.attach({
        terminalId: this.#terminalId,
        viewerId: this.#viewerId,
        observe: !this.#canControl,
        history: this.#history,
        creditViewer: true,
      });
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (this.#closed) {
      void attachment.stream.detach().catch(() => {});
      return;
    }
    this.#attachment = attachment;
    this.#canControl = attachment.canControl;
    this.#send({
      type: "ready",
      terminalId: this.#terminalId,
      cols: attachment.cols,
      rows: attachment.rows,
      canControl: this.#canControl,
    });
    // After `ready`: a stream replays the first paint to its first `data`
    // listener, so the listener must not exist before the channel is announced.
    attachment.stream.on("data", (bytes) => this.#onData(bytes));
    attachment.stream.on("close", (event) => this.#onStreamClose(event.reason, event.detached));
    attachment.stream.on("lost", () => this.#onStreamLost());
    for (const bytes of this.#earlyInput.splice(0)) this.#onInput(bytes);
    this.#earlyBytes = 0;
  }

  #onData(bytes: Uint8Array): void {
    if (this.#closed) return;
    this.#unacked += bytes.byteLength;
    this.#socket.write(encodeBinary(bytes));
  }

  #onCredit(bytes: number): void {
    if (!Number.isInteger(bytes) || bytes <= 0) return;
    const granted = Math.min(bytes, this.#unacked);
    if (granted <= 0) return;
    this.#unacked -= granted;
    const attachment = this.#attachment;
    if (!attachment) return;
    void attachment.credit(granted).catch(() => {});
  }

  async #onResize(cols: number, rows: number): Promise<void> {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 65_535 || rows > 65_535) {
      this.#send({ type: "error", code: "invalid_params", message: `bad size ${cols}x${rows}` });
      return;
    }
    const attachment = this.#attachment;
    if (!attachment) return;
    if (attachment.stream.role !== "control") {
      this.#refuseControl("resize");
      return;
    }
    try {
      await attachment.stream.resize(cols, rows);
    } catch (error) {
      this.#send({ type: "error", code: terminalErrorCode(error), message: describe(error) });
    }
  }

  #onInput(bytes: Uint8Array): void {
    if (this.#closed) return;
    const attachment = this.#attachment;
    if (!attachment) {
      if (this.#earlyBytes + bytes.byteLength > MAX_EARLY_INPUT_BYTES) return;
      this.#earlyInput.push(new Uint8Array(bytes));
      this.#earlyBytes += bytes.byteLength;
      return;
    }
    if (attachment.stream.role !== "control") {
      this.#refuseControl("type");
      return;
    }
    void attachment.stream.sendInput(bytes).catch((error: unknown) => {
      this.#canControl = false;
      this.#send({ type: "error", code: terminalErrorCode(error), message: describe(error) });
    });
  }

  /** Control is not this viewer's, so it is told once and keeps its stream: it
   * still watches, and a fresh attach is how it takes control back. */
  #refuseControl(action: "type" | "resize"): void {
    this.#canControl = false;
    if (this.#toldAboutControl) return;
    this.#toldAboutControl = true;
    this.#send({ type: "error", code: "not_controller", message: `this viewer may watch but not ${action}: it does not hold control` });
  }

  #onStreamClose(reason: unknown, detached: boolean): void {
    if (detached || this.#ended) return;
    const detail = reasonDetail(reason);
    this.#ended = true;
    this.#send({ type: "exit", reason: detail.reason, exitCode: detail.exitCode });
  }

  /**
   * The core's line dropped under the stream. The terminal itself survives on
   * the core, so the viewer is told to attach again and gets a fresh paint
   * instead of a replay of its own old input.
   */
  #onStreamLost(): void {
    if (this.#ended || this.#closed) return;
    this.#ended = true;
    this.#send({ type: "resync", reason: "disconnected" });
    this.#socket.end();
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#send({ type: "error", code: terminalErrorCode(error), message: describe(error) });
    this.#socket.end();
  }

  #subscribe(): void {
    this.#listen("title", (event) => {
      if (event.terminalId === this.#terminalId) this.#send({ type: "title", title: event.title });
    });
    this.#listen("status", (event) => {
      if (event.terminalId === this.#terminalId) this.#send({ type: "status", status: event.status });
    });
    this.#listen("exit", (event) => {
      if (event.terminalId !== this.#terminalId || this.#ended) return;
      this.#ended = true;
      this.#send({ type: "exit", reason: event.reason, exitCode: event.exitCode });
    });
    this.#listen("resync", (event) => {
      if (event.terminalId !== this.#terminalId || this.#ended) return;
      this.#ended = true;
      this.#send({ type: "resync", reason: event.reason });
      this.#socket.end();
    });
  }

  #listen<E extends keyof TerminalServiceEvents>(
    event: E,
    listener: (...args: TerminalServiceEvents[E]) => void,
  ): void {
    this.#service.on(event, listener as never);
    this.#listeners.push({ event, listener: listener as never });
  }

  #send(message: Record<string, unknown>): void {
    if (this.#closed) return;
    this.#socket.write(encodeText(JSON.stringify(message)));
  }
}

/** The port the HTTP layer reads. The service is the authority on which
 * terminals exist; this adapter keeps the HTTP types out of it. */
export class TerminalServicePort implements TerminalPort {
  readonly #service: TerminalService;

  constructor(service: TerminalService) {
    this.#service = service;
  }

  list() {
    return this.#service.list();
  }

  get(id: string) {
    return this.#service.get(id);
  }

  start(input: Parameters<TerminalPort["start"]>[0]) {
    return this.#service.start({
      environmentId: input.environmentId,
      tool: input.tool,
      missionId: input.missionId ?? "manual",
      runId: input.runId ?? "manual",
      ...(input.cols !== undefined ? { cols: input.cols } : {}),
      ...(input.rows !== undefined ? { rows: input.rows } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
    });
  }
}

function reasonDetail(reason: unknown): { reason: string; exitCode: number | null } {
  if (typeof reason === "object" && reason !== null) {
    const record = reason as { reason?: unknown; exit_code?: unknown; exitCode?: unknown };
    const exitCode =
      typeof record.exit_code === "number" ? record.exit_code : typeof record.exitCode === "number" ? record.exitCode : null;
    return { reason: typeof record.reason === "string" ? record.reason : "exited", exitCode };
  }
  if (typeof reason === "string" && reason !== "") return { reason, exitCode: null };
  return { reason: "exited", exitCode: null };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
