/** The workbench's live-event and terminal transports.
 *
 * `GET /api/v1/events` is a `text/event-stream`: every event carries its
 * cursor as the SSE `id`, so a reconnect replays from `Last-Event-ID` and the
 * server answers `stream.resync` when that cursor is too old to replay. A
 * `stream.resync` means the client's view may be wrong, so listeners refetch a
 * snapshot rather than treating the stream as contiguous (core/http/sse.ts,
 * core/events/hub.ts).
 *
 * A terminal is a WebSocket that a browser opens with a single-use ticket
 * because a `WebSocket` constructor cannot set an Authorization header
 * (core/http/routes.ts, core/http/terminal-stream.ts). */

import type { Notification, NotificationKind } from "./notifications.ts";
import { isNotification } from "./notifications.ts";
import { ApiError, apiClient, authToken, type ApiClient } from "./http.ts";

export const EVENTS_PATH = "/events";

export const INITIAL_TERMINAL_CREDIT = 256 * 1024;

export type LiveEventStatus = "connecting" | "open" | "retrying" | "closed";

export interface LiveEventsHandlers {
  /** One notification from the server. */
  readonly onEvent: (notification: Notification) => void;
  /** The server said the cursor was too old to replay: discard the view and
   * refetch a snapshot. */
  readonly onResync: (reason: string | undefined) => void;
  readonly onStatus?: (status: LiveEventStatus) => void;
  /** The server announced shutdown; a reconnect is still attempted. */
  readonly onShutdown?: (reason: string | undefined) => void;
}

export interface LiveEventsOptions extends LiveEventsHandlers {
  readonly client?: ApiClient;
  /** Injected for tests; defaults to `EventSource`. */
  readonly eventSource?: (url: string) => EventSource;
  /** Injected for tests; defaults to `setTimeout`. */
  readonly schedule?: (run: () => void, ms: number) => number;
  readonly cancel?: (handle: number) => void;
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
}

export interface LiveEventsHandle {
  readonly close: () => void;
  /** The cursor the client last saw, so a caller can persist it. */
  readonly lastEventId: () => string | null;
}

export interface EventSourceLike {
  close(): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  removeEventListener?(type: string, listener: (event: MessageEvent) => void): void;
}

const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 15_000;

/** Keeps the events stream open, reconnecting with `Last-Event-ID` after a
 * drop. Each attempt trades the bearer for a single-use `events` ticket,
 * because a browser's `EventSource` cannot set the Authorization header. */
export function connectLiveEvents(options: LiveEventsOptions): LiveEventsHandle {
  const client = options.client ?? apiClient();
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms) as unknown as number);
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle));
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const makeSource = options.eventSource ?? ((url) => new EventSource(url));

  let source: EventSourceLike | null = null;
  let closed = false;
  let attempt = 0;
  let timer: number | null = null;
  let lastEventId: string | null = null;

  const status = (next: LiveEventStatus): void => options.onStatus?.(next);

  const streamUrl = (ticket: string): string => {
    const url = new URL(`${client.baseUrl}${EVENTS_PATH}`, originOf(client.baseUrl));
    url.searchParams.set("ticket", ticket);
    if (lastEventId !== null) url.searchParams.set("lastEventId", lastEventId);
    return url.toString();
  };

  const open = (): void => {
    if (closed) return;
    status("connecting");
    if (authToken() === null) {
      options.onResync("a bearer is required to issue an events ticket");
      scheduleRetry();
      return;
    }
    void (async () => {
      let ticket: string;
      try {
        const issued = await client.request<{ ticket: string }>("/events/ticket", { method: "POST", body: {} });
        ticket = issued.ticket;
      } catch (error) {
        if (closed) return;
        options.onResync(error instanceof ApiError ? error.message : "the event ticket could not be issued");
        scheduleRetry();
        return;
      }
      if (closed) return;

      const created = makeSource(streamUrl(ticket)) as unknown as EventSourceLike;
      source = created;
      created.addEventListener("open", () => {
        attempt = 0;
        status("open");
      });
      created.addEventListener("error", () => {
        if (closed) return;
        status("retrying");
        created.close();
        if (source === created) source = null;
        scheduleRetry();
      });
      created.addEventListener("message", (event: MessageEvent) => {
        const id = typeof event.lastEventId === "string" && event.lastEventId.length > 0 ? event.lastEventId : null;
        if (id !== null) lastEventId = id;
        const parsed = parseNotification(event.data);
        if (parsed === undefined) return;
        if (parsed.kind === "stream.resync") {
          options.onResync(parsed.reason);
          return;
        }
        if (parsed.kind === "server.shutdown") options.onShutdown?.(parsed.reason);
        options.onEvent(parsed);
      });
    })();
  };

  const scheduleRetry = (): void => {
    if (closed || timer !== null) return;
    const delay = Math.min(maxRetryMs, retryMs * 2 ** attempt);
    attempt += 1;
    timer = schedule(() => {
      timer = null;
      open();
    }, delay);
  };

  open();

  return {
    close: () => {
      closed = true;
      status("closed");
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      source?.close();
      source = null;
    },
    lastEventId: () => lastEventId,
  };
}

function originOf(baseUrl: string): string {
  if (/^https?:\/\//u.test(baseUrl)) return new URL(baseUrl).origin;
  const origin = globalThis.location?.origin;
  if (origin !== undefined && origin !== "null" && origin.length > 0) return origin;
  try {
    return new URL(baseUrl, "http://127.0.0.1").origin;
  } catch {
    return "http://127.0.0.1";
  }
}

/** Parses one SSE `data:` payload. Anything that is not a notification the
 * hub could have sent is dropped, not guessed at. */
export function parseNotification(data: unknown): Notification | undefined {
  if (typeof data !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  return isNotification(parsed) ? parsed : undefined;
}

export function notificationKinds(): readonly NotificationKind[] {
  return NOTIFICATION_KIND_VALUES;
}

const NOTIFICATION_KIND_VALUES: readonly NotificationKind[] = [
  "mission.updated",
  "run.updated",
  "approval.updated",
  "artifact.added",
  "environment.updated",
  "terminal.updated",
  "server.shutdown",
  "stream.resync",
];

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export interface TerminalTicket {
  readonly ticket: string;
  readonly expiresAt: string;
  readonly path: string;
}

export interface TerminalReadyControl {
  readonly type: "ready";
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
  readonly canControl: boolean;
}

export type TerminalControl =
  | TerminalReadyControl
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "status"; readonly status: string }
  | { readonly type: "exit"; readonly reason: string; readonly exitCode?: number }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "resync"; readonly cols: number; readonly rows: number };

export interface TerminalHandlers {
  /** Raw program output. The caller writes it and then reports the consumed
   * bytes through `sendCredit` from the terminal's write callback. */
  readonly onData: (bytes: Uint8Array) => void;
  readonly onControl: (control: TerminalControl) => void;
  readonly onExit: (reason: string, exitCode?: number) => void;
  readonly onError: (error: ApiError) => void;
  /** Called after a reconnect with a fresh ticket, so the caller can reattach
   * rather than replay input it already sent. */
  readonly onReconnect?: () => void;
}

export interface TerminalConnectionOptions extends TerminalHandlers {
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
  readonly client?: ApiClient;
  /** Injected for tests; defaults to `WebSocket`. */
  readonly webSocket?: (url: string) => WebSocket;
  readonly schedule?: (run: () => void, ms: number) => number;
  readonly cancel?: (handle: number) => void;
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
}

export interface TerminalConnection {
  readonly sendInput: (bytes: Uint8Array) => void;
  readonly sendResize: (cols: number, rows: number) => void;
  readonly sendCredit: (bytes: number) => void;
  readonly close: () => void;
  readonly isOpen: () => boolean;
}

interface WireMessage {
  readonly type: string;
  readonly [field: string]: unknown;
}

const DEFAULT_TERMINAL_RETRY_MS = 500;
const DEFAULT_TERMINAL_MAX_RETRY_MS = 10_000;

/** Opens a terminal: ask for a single-use ticket, then upgrade the same path
 * with it in the query string.
 *
 * Frame contract (fixed by core/http/terminal-stream.ts and the terminal
 * layer): the server's first text frame is `{type:"ready",…}`; after that a
 * binary frame is raw program output and a text frame is one of the control
 * messages above. The client sends raw input as binary (only while
 * `ready.canControl`), and `resize` / `credit` / `close` as text. A dropped
 * socket mints a new ticket and reattaches: input is never replayed. */
export function connectTerminal(options: TerminalConnectionOptions): TerminalConnection {
  const client = options.client ?? apiClient();
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms) as unknown as number);
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle));
  const makeSocket = options.webSocket ?? ((url) => new WebSocket(url));
  const retryMs = options.retryMs ?? DEFAULT_TERMINAL_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? DEFAULT_TERMINAL_MAX_RETRY_MS;

  let socket: WebSocket | null = null;
  let closed = false;
  let ready = false;
  let canControl = false;
  let exited = false;
  let attempt = 0;
  let timer: number | null = null;
  let connectedOnce = false;
  let size = { cols: options.cols, rows: options.rows };

  const sendText = (message: WireMessage): void => {
    if (socket === null || socket.readyState !== 1) return;
    socket.send(JSON.stringify(message));
  };

  const sendBinary = (bytes: Uint8Array): void => {
    if (socket === null || socket.readyState !== 1) return;
    socket.send(bytes);
  };

  const open = async (): Promise<void> => {
    if (closed) return;
    let ticket: TerminalTicket;
    try {
      ticket = await client.request<TerminalTicket>(`/terminals/${encodeURIComponent(options.terminalId)}/ticket`, {
        method: "POST",
        body: {},
      });
    } catch (error) {
      options.onError(toApiError(error));
      scheduleRetry();
      return;
    }
    if (closed) return;

    const url = new URL(ticket.path, originOf(client.baseUrl));
    url.searchParams.set("ticket", ticket.ticket);

    const created = makeSocket(url.toString());
    created.binaryType = "arraybuffer";
    socket = created;

    created.addEventListener("open", () => {
      attempt = 0;
      sendText({ type: "resize", cols: size.cols, rows: size.rows });
    });

    created.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") {
        const control = parseTerminalControl(event.data);
        if (control === undefined) return;
        if (control.type === "ready") {
          ready = true;
          canControl = control.canControl;
          size = { cols: control.cols, rows: control.rows };
          if (connectedOnce) options.onReconnect?.();
          connectedOnce = true;
        }
        if (control.type === "exit") {
          exited = true;
          ready = false;
          canControl = false;
          options.onExit(control.reason, control.exitCode);
        }
        options.onControl(control);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        options.onData(new Uint8Array(event.data));
        return;
      }
      if (event.data instanceof Uint8Array) {
        options.onData(event.data);
      }
    });

    created.addEventListener("close", () => {
      if (closed) return;
      ready = false;
      canControl = false;
      if (socket === created) socket = null;
      scheduleRetry();
    });

    created.addEventListener("error", () => {
      if (closed) return;
      options.onError(new ApiError("terminal_socket_error", "the terminal socket reported an error", 0));
    });
  };

  const scheduleRetry = (): void => {
    if (closed || timer !== null) return;
    const delay = Math.min(maxRetryMs, retryMs * 2 ** attempt);
    attempt += 1;
    timer = schedule(() => {
      timer = null;
      void open();
    }, delay);
  };

  void open();

  return {
    sendInput: (bytes) => {
      if (!ready || !canControl || exited) return;
      sendBinary(bytes);
    },
    sendResize: (cols, rows) => {
      size = { cols, rows };
      sendText({ type: "resize", cols, rows });
    },
    sendCredit: (bytes) => {
      if (bytes <= 0) return;
      sendText({ type: "credit", bytes });
    },
    close: () => {
      if (closed) return;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      sendText({ type: "close" });
      closed = true;
      socket?.close();
      socket = null;
    },
    isOpen: () => ready,
  };
}

/** Decodes one text frame from the terminal stream. An unknown `type` is
 * dropped: a control message this client does not understand is not data. */
export function parseTerminalControl(data: string): TerminalControl | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const message = parsed as Record<string, unknown>;
  switch (message.type) {
    case "ready":
      return typeof message.terminalId === "string" &&
        typeof message.cols === "number" &&
        typeof message.rows === "number" &&
        typeof message.canControl === "boolean"
        ? { type: "ready", terminalId: message.terminalId, cols: message.cols, rows: message.rows, canControl: message.canControl }
        : undefined;
    case "title":
      return typeof message.title === "string" ? { type: "title", title: message.title } : undefined;
    case "status":
      return typeof message.status === "string" ? { type: "status", status: message.status } : undefined;
    case "exit":
      return typeof message.reason === "string"
        ? { type: "exit", reason: message.reason, ...(typeof message.exitCode === "number" ? { exitCode: message.exitCode } : {}) }
        : undefined;
    case "error":
      return typeof message.code === "string" && typeof message.message === "string"
        ? { type: "error", code: message.code, message: message.message }
        : undefined;
    case "resync":
      return typeof message.cols === "number" && typeof message.rows === "number"
        ? { type: "resync", cols: message.cols, rows: message.rows }
        : undefined;
    default:
      return undefined;
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError("terminal_ticket_failed", error instanceof Error ? error.message : "the ticket request failed", 0);
}
