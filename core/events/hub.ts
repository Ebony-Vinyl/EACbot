/** The notification a stream carries. It is deliberately thin: a client uses
 * it to learn *that* something moved and which mission moved, then reads the
 * authoritative snapshot over REST. Nothing here is task state. */
export const NOTIFICATION_KINDS = [
  "mission.updated",
  "run.updated",
  "approval.updated",
  "artifact.added",
  "environment.updated",
  "terminal.updated",
  "server.shutdown",
  "stream.resync",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface Notification {
  /** Monotonic per process, starting at 1. This is the SSE `id` and the value
   * a reconnecting client sends back as `Last-Event-ID`. */
  readonly cursor: number;
  readonly kind: NotificationKind;
  readonly at: string;
  readonly missionId?: string;
  readonly runId?: string;
  /** The mission revision the notification was emitted for. A client whose
   * snapshot shows an older revision knows it must refetch. */
  readonly revision?: number;
  /** Why a `stream.resync` was sent: the client's cursor is older than what
   * this process still holds. */
  readonly reason?: string;
}

export interface EventHubOptions {
  readonly now: () => string;
  /** Notifications retained for replay. A client further behind than this gets
   * a `stream.resync` instead of a gap. */
  readonly replayLimit?: number;
  readonly onListenerError?: (error: unknown) => void;
}

export interface Subscription {
  /** Delivers notifications from `cursor` onward, then live ones. Returns the
   * unsubscribe function. */
  readonly close: () => void;
}

export interface ReplayResult {
  readonly notifications: readonly Notification[];
  /** True when the requested cursor is too old to replay; the client must
   * discard its view and refetch. */
  readonly resync: boolean;
  /** The cursor a resync was computed at, so the client knows what to send
   * back. */
  readonly cursor: number;
}

const DEFAULT_REPLAY_LIMIT = 2_000;

/** A fan-out of notifications with a bounded replay window.
 *
 * The hub holds no mission state: a client that reconnects replays
 * notifications, then reads a snapshot over REST. That is why a dropped
 * notification costs a refetch, never a wrong view. */
export class EventHub {
  readonly #now: () => string;
  readonly #replayLimit: number;
  readonly #onListenerError: (error: unknown) => void;
  readonly #ring: Notification[] = [];
  readonly #listeners = new Set<(notification: Notification) => void>();
  #cursor = 0;
  #closed = false;

  constructor(options: EventHubOptions) {
    this.#now = options.now;
    this.#replayLimit = options.replayLimit ?? DEFAULT_REPLAY_LIMIT;
    this.#onListenerError = options.onListenerError ?? (() => {});
  }

  /** The last cursor this process emitted. A client that saw this value and
   * nothing later is up to date. */
  get cursor(): number {
    return this.#cursor;
  }

  get closed(): boolean {
    return this.#closed;
  }

  publish(input: { kind: NotificationKind; missionId?: string; runId?: string; revision?: number; reason?: string }): Notification {
    this.#cursor += 1;
    const notification: Notification = {
      cursor: this.#cursor,
      kind: input.kind,
      at: this.#now(),
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };
    this.#ring.push(notification);
    if (this.#ring.length > this.#replayLimit) this.#ring.shift();
    for (const listener of this.#listeners) {
      try {
        listener(notification);
      } catch (error) {
        this.#onListenerError(error);
      }
    }
    return notification;
  }

  /** What a reconnecting client gets before live notifications resume.
   *
   * `lastEventId` absent means "start from now": a first connection does not
   * need history, because the client has not read a snapshot yet. */
  replay(lastEventId: string | undefined): ReplayResult {
    if (lastEventId === undefined) return { notifications: [], resync: false, cursor: this.#cursor };
    const requested = parseCursor(lastEventId);
    if (requested === undefined) return { notifications: [], resync: true, cursor: this.#cursor };
    if (requested > this.#cursor) return { notifications: [], resync: true, cursor: this.#cursor };
    if (requested === this.#cursor) return { notifications: [], resync: false, cursor: this.#cursor };

    const oldest = this.#ring[0]?.cursor;
    if (oldest === undefined) {
      // Nothing is retained. A client that already saw this cursor needs
      // nothing; one that saw less has a gap it cannot close.
      return requested >= this.#cursor
        ? { notifications: [], resync: false, cursor: this.#cursor }
        : { notifications: [], resync: true, cursor: this.#cursor };
    }
    if (requested < oldest - 1) return { notifications: [], resync: true, cursor: this.#cursor };
    return {
      notifications: this.#ring.filter((notification) => notification.cursor > requested),
      resync: false,
      cursor: this.#cursor,
    };
  }

  subscribe(listener: (notification: Notification) => void): Subscription {
    if (this.#closed) return { close: () => {} };
    this.#listeners.add(listener);
    return { close: () => void this.#listeners.delete(listener) };
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Tells every stream the server is going, then refuses new subscribers. */
  close(reason = "server shutting down"): void {
    if (this.#closed) return;
    this.publish({ kind: "server.shutdown", reason });
    this.#closed = true;
    this.#listeners.clear();
  }
}

export function parseCursor(value: string): number | undefined {
  if (!/^\d{1,15}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
