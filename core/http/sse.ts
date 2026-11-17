import type { ServerResponse } from "node:http";

import type { Notification } from "../events/hub.ts";

export interface SseStreamOptions {
  readonly heartbeatMs?: number;
  /** How long the browser waits before reconnecting. */
  readonly retryMs?: number;
  readonly now: () => string;
}

/** One `text/event-stream` response.
 *
 * Every event carries `id: <cursor>`, so a browser's automatic reconnect sends
 * `Last-Event-ID` and the server can replay from exactly there. */
export class SseStream {
  readonly #res: ServerResponse;
  readonly #now: () => string;
  readonly #heartbeat: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(res: ServerResponse, options: SseStreamOptions) {
    this.#res = res;
    this.#now = options.now;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`retry: ${options.retryMs ?? 3_000}\n\n`);
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    if (heartbeatMs > 0) {
      this.#heartbeat = setInterval(() => this.comment("keepalive"), heartbeatMs);
      this.#heartbeat.unref();
    }
    res.on("close", () => this.#finish());
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(notification: Notification): void {
    if (this.#closed) return;
    this.#res.write(`id: ${notification.cursor}\nevent: ${notification.kind}\ndata: ${JSON.stringify(notification)}\n\n`);
  }

  /** Sent when a client's cursor is too old to replay. The client discards its
   * view and refetches a snapshot; it is not a task event. */
  resync(cursor: number, reason: string): void {
    if (this.#closed) return;
    const payload = JSON.stringify({ kind: "stream.resync", cursor, reason, at: this.#now() });
    this.#res.write(`id: ${cursor}\nevent: stream.resync\ndata: ${payload}\n\n`);
  }

  comment(text: string): void {
    if (this.#closed) return;
    this.#res.write(`: ${text}\n\n`);
  }

  close(): void {
    if (this.#closed) return;
    this.#finish();
    this.#res.end();
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
  }
}
