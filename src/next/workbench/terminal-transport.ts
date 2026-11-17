import { t } from "@/lib/i18n";
/** The connection abstraction the workbench components use, built on the
 * foundation's terminal transport.
 *
 * A component gets `open`, `resize`, `send`, `close` and `onData`, and never
 * touches a socket, a ticket or a frame: the protocol lives in
 * `foundation/api.ts`. This layer adds what the UI needs on top of it:
 *
 * - **Read-only is enforced here as well as in the chrome.** A watcher's
 *   `send` and `resize` return false without reaching the transport, so a
 *   stale component cannot type into a terminal it does not hold.
 * - **`ready` and `resync` are repaint boundaries.** Both mean the next bytes
 *   are a whole screen, so the surface clears before drawing them and a
 *   reconnect never doubles text.
 * - **A dropped stream is a visible state.** The last screen stays, the phase
 *   says Reconnecting with the attempt count, and `retry` starts a fresh
 *   stream. Input is never replayed.
 */

import { connectTerminal as connectWithFoundation, type TerminalControl } from "../foundation/api.ts";

export type LeaseRole = "control" | "observe";

/** Credit the server grants before any acknowledgement arrives. */
export const INITIAL_CREDIT_BYTES = 256 * 1024;

export type ConnectionState =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "live"; readonly canControl: boolean }
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly detail: string }
  | { readonly kind: "exited"; readonly reason: string; readonly exitCode?: number }
  | { readonly kind: "failed"; readonly message: string; readonly retryable: boolean }
  | { readonly kind: "closed" };

export type TerminalEvent =
  | { readonly type: "data"; readonly bytes: Uint8Array }
  /** The next bytes start a fresh screen. */
  | { readonly type: "repaint" }
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "status"; readonly status: string }
  | { readonly type: "exit"; readonly reason: string; readonly exitCode?: number }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "state"; readonly state: ConnectionState };

export interface TerminalConnection {
  readonly terminalId: string;
  readonly state: ConnectionState;
  /** The server's grant, not the person's choice: typing needs both. */
  readonly canControl: boolean;
  open(): void;
  /** Returns false when this viewer may not resize. */
  resize(cols: number, rows: number): boolean;
  /** Sends keystrokes. Returns false when this viewer may not type. */
  send(bytes: Uint8Array): boolean;
  /** Flow control, not input: a watcher acknowledges bytes too. */
  acknowledge(bytes: number): void;
  retry(): void;
  close(): void;
  onData(listener: (bytes: Uint8Array) => void): () => void;
  onEvent(listener: (event: TerminalEvent) => void): () => void;
}

/** The foundation transport, narrowed to what this layer calls. Injected in
 * tests, so a fake proves the lifecycle without a socket. */
export interface FoundationTerminal {
  sendInput(bytes: Uint8Array): void;
  sendResize(cols: number, rows: number): void;
  sendCredit(bytes: number): void;
  close(): void;
  isOpen(): boolean;
}

export interface FoundationConnectOptions {
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
  readonly onData: (bytes: Uint8Array) => void;
  readonly onControl: (control: TerminalControl) => void;
  readonly onExit: (reason: string, exitCode?: number) => void;
  readonly onError: (error: unknown) => void;
  readonly onReconnect?: () => void;
}

export type FoundationConnect = (options: FoundationConnectOptions) => FoundationTerminal;

export interface WatchClock {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realClock: WatchClock = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

export interface TerminalConnectionOptions {
  readonly terminalId: string;
  /** Read at every call, so taking or releasing control takes effect without
   * rebuilding the stream. */
  readonly getRole: () => LeaseRole;
  readonly cols?: number;
  readonly rows?: number;
  /** Drops before the connection offers a manual Retry. */
  readonly maxAttempts?: number;
  readonly watchMs?: number;
  readonly clock?: WatchClock;
  /** Injected in tests; defaults to the foundation's terminal transport. */
  readonly connect?: FoundationConnect;
}

export function createTerminalConnection(options: TerminalConnectionOptions): TerminalConnection {
  return new FoundationTerminalConnection(options);
}

class FoundationTerminalConnection implements TerminalConnection {
  readonly terminalId: string;
  readonly #getRole: () => LeaseRole;
  readonly #connect: FoundationConnect;
  readonly #maxAttempts: number;
  readonly #watchMs: number;
  readonly #clock: WatchClock;

  readonly #listeners = new Set<(event: TerminalEvent) => void>();
  readonly #dataListeners = new Set<(bytes: Uint8Array) => void>();

  #cols: number;
  #rows: number;
  #transport: FoundationTerminal | null = null;
  #watch: unknown = null;
  #state: ConnectionState = { kind: "idle" };
  #canControl = false;
  #attempt = 0;
  #stopped = true;
  #exited = false;
  #generation = 0;
  /** A drop was already reported for this stream. */
  #reportedDown = false;

  constructor(options: TerminalConnectionOptions) {
    this.terminalId = options.terminalId;
    this.#getRole = options.getRole;
    this.#maxAttempts = options.maxAttempts ?? 6;
    this.#watchMs = options.watchMs ?? 500;
    this.#clock = options.clock ?? realClock;
    this.#cols = options.cols ?? 80;
    this.#rows = options.rows ?? 24;
    this.#connect = options.connect ?? ((input) => connectWithFoundation({
      terminalId: input.terminalId,
      cols: input.cols,
      rows: input.rows,
      onData: input.onData,
      onControl: input.onControl,
      onExit: input.onExit,
      onError: input.onError,
      ...(input.onReconnect !== undefined ? { onReconnect: input.onReconnect } : {}),
    }));
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get canControl(): boolean {
    return this.#canControl;
  }

  open(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#exited = false;
    this.#attempt = 0;
    this.#start();
  }

  retry(): void {
    if (this.#state.kind !== "reconnecting" && this.#state.kind !== "failed") return;
    this.#teardown();
    this.#attempt = 0;
    this.#stopped = false;
    this.#start();
  }

  close(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#teardown();
    this.#setState({ kind: "closed" });
  }

  resize(cols: number, rows: number): boolean {
    if (!this.#mayWrite() || !Number.isFinite(cols) || !Number.isFinite(rows)) return false;
    this.#cols = Math.max(1, Math.floor(cols));
    this.#rows = Math.max(1, Math.floor(rows));
    this.#transport?.sendResize(this.#cols, this.#rows);
    return true;
  }

  send(bytes: Uint8Array): boolean {
    if (!this.#mayWrite() || bytes.byteLength === 0) return false;
    this.#transport?.sendInput(bytes);
    return true;
  }

  acknowledge(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.#transport?.sendCredit(Math.floor(bytes));
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  onEvent(listener: (event: TerminalEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #mayWrite(): boolean {
    return this.#getRole() === "control" && this.#canControl && this.#state.kind === "live";
  }

  #start(): void {
    const generation = ++this.#generation;
    this.#reportedDown = false;
    this.#setState(this.#attempt === 0
      ? { kind: "connecting", attempt: 0 }
      : { kind: "reconnecting", attempt: this.#attempt, detail: t("workspaceUi.freshStream") });
    let transport: FoundationTerminal;
    try {
      transport = this.#connect({
        terminalId: this.terminalId,
        cols: this.#cols,
        rows: this.#rows,
        onData: (bytes) => {
          if (generation === this.#generation) this.#onData(bytes);
        },
        onControl: (control) => {
          if (generation === this.#generation) this.#onControl(control);
        },
        onExit: (reason, exitCode) => {
          if (generation === this.#generation) this.#onExit(reason, exitCode);
        },
        onError: (error) => {
          if (generation === this.#generation) this.#onDrop(describe(error));
        },
        onReconnect: () => {
          if (generation === this.#generation) this.#emit({ type: "repaint" });
        },
      });
    } catch (error) {
      this.#onDrop(describe(error));
      return;
    }
    if (generation !== this.#generation || this.#stopped) {
      transport.close();
      return;
    }
    this.#transport = transport;
    this.#startWatch(generation);
  }

  /** The foundation retries on its own, so the only way to know the stream is
   * down between `ready` frames is to ask it. A closed transport becomes the
   * visible Reconnecting state instead of a screen that silently stops. */
  #startWatch(generation: number): void {
    if (this.#watch !== null) return;
    this.#watch = this.#clock.setInterval(() => {
      if (generation !== this.#generation || this.#stopped || this.#exited) return;
      if (this.#state.kind !== "live" && this.#state.kind !== "reconnecting") return;
      if (this.#transport?.isOpen() === true) return;
      this.#onDrop("the stream closed");
    }, this.#watchMs);
  }

  #stopWatch(): void {
    if (this.#watch === null) return;
    this.#clock.clearInterval(this.#watch);
    this.#watch = null;
  }

  #onData(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#emit({ type: "data", bytes });
    for (const listener of this.#dataListeners) listener(bytes);
  }

  #onControl(control: TerminalControl): void {
    switch (control.type) {
      case "ready":
        this.#canControl = control.canControl;
        this.#attempt = 0;
        this.#reportedDown = false;
        this.#setState({ kind: "live", canControl: this.#canControl });
        this.#emit({ type: "repaint" });
        return;
      case "resync":
        this.#emit({ type: "repaint" });
        return;
      case "title":
        this.#emit({ type: "title", title: control.title });
        return;
      case "status":
        this.#emit({ type: "status", status: control.status });
        return;
      case "exit":
        this.#onExit(control.reason, control.exitCode);
        return;
      case "error":
        this.#emit({ type: "error", message: control.message });
        this.#fail(control.message);
        return;
      default:
        return;
    }
  }

  #onExit(reason: string, exitCode?: number): void {
    this.#exited = true;
    this.#canControl = false;
    this.#setState(exitCode === undefined ? { kind: "exited", reason } : { kind: "exited", reason, exitCode });
    this.#emit(exitCode === undefined ? { type: "exit", reason } : { type: "exit", reason, exitCode });
    this.#teardown();
  }

  /** One drop, counted once per stream. The foundation retries on its own, so
   * both the error callback and the watch can see the same drop; only the
   * first one moves the attempt count. */
  #onDrop(detail: string): void {
    if (this.#stopped || this.#exited || this.#reportedDown) return;
    if (this.#state.kind === "failed") return;
    this.#reportedDown = true;
    this.#canControl = false;
    this.#attempt += 1;
    if (this.#attempt > this.#maxAttempts) {
      this.#fail(detail);
      return;
    }
    this.#setState({ kind: "reconnecting", attempt: this.#attempt, detail });
  }

  #fail(message: string): void {
    this.#canControl = false;
    this.#stopWatch();
    this.#setState({ kind: "failed", message, retryable: true });
  }

  #teardown(): void {
    this.#stopWatch();
    const transport = this.#transport;
    this.#transport = null;
    this.#generation += 1;
    this.#canControl = false;
    if (!transport) return;
    try {
      transport.close();
    } catch {
      // A transport that already died has nothing left to release.
    }
  }

  #setState(state: ConnectionState): void {
    this.#state = state;
    this.#emit({ type: "state", state });
  }

  #emit(event: TerminalEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function describe(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "the terminal stream could not be reached";
}
