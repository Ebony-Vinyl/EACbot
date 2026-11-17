/** A React binding over `connectLiveEvents`: one stream for the workbench,
 * torn down with the component, that reports a version counter the caller can
 * use to refetch a snapshot. A `stream.resync` bumps the same counter, because
 * the only safe answer to a gap is a fresh read. */

import { useEffect, useRef, useState } from "react";
import type { Notification } from "./notifications.ts";
import { connectLiveEvents, type LiveEventStatus } from "./live.ts";

export interface LiveEventsState {
  readonly status: LiveEventStatus;
  /** Increments on every notification and on every resync. */
  readonly version: number;
  readonly lastEvent: Notification | null;
  readonly lastCursor: number | null;
}

export interface UseLiveEventsOptions {
  readonly enabled?: boolean;
  readonly onEvent?: (notification: Notification) => void;
  readonly onResync?: (reason: string | undefined) => void;
}

const IDLE: LiveEventsState = { status: "closed", version: 0, lastEvent: null, lastCursor: null };

export function useLiveEvents(options: UseLiveEventsOptions = {}): LiveEventsState {
  const { enabled = true } = options;
  const [state, setState] = useState<LiveEventsState>(IDLE);
  const handlers = useRef(options);
  handlers.current = options;

  useEffect(() => {
    if (!enabled) {
      setState((previous) => (previous.status === "closed" ? previous : { ...previous, status: "closed" }));
      return;
    }
    const handle = connectLiveEvents({
      onEvent: (notification) => {
        handlers.current.onEvent?.(notification);
        setState((previous) => ({
          status: "open",
          version: previous.version + 1,
          lastEvent: notification,
          lastCursor: notification.cursor,
        }));
      },
      onResync: (reason) => {
        handlers.current.onResync?.(reason);
        setState((previous) => ({
          status: "open",
          version: previous.version + 1,
          lastEvent: previous.lastEvent,
          lastCursor: previous.lastCursor,
        }));
      },
      onStatus: (status) => setState((previous) => ({ ...previous, status })),
    });
    return () => {
      handle.close();
      setState(IDLE);
    };
  }, [enabled]);

  return state;
}
