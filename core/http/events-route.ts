import type { EventHub, Notification } from "../events/hub.ts";
import type { RequestContext, RouteResult } from "./context.ts";
import { ApiError } from "./errors.ts";
import type { Router } from "./router.ts";
import { SseStream } from "./sse.ts";

export interface EventsRouteOptions {
  readonly events: EventHub;
  readonly now: () => string;
  readonly heartbeatMs?: number;
  readonly retryMs?: number;
}

/** `GET /api/v1/events`, reachable with a device bearer or an events ticket.
 *
 * Reconnect order is: replay from `Last-Event-ID`, then live. When the cursor
 * is older than the retained window the server sends one `stream.resync` and
 * the client refetches a snapshot; the stream is never allowed to look
 * contiguous when it is not. */
export function registerEventsRoute(router: Router, options: EventsRouteOptions): void {
  router.streamGet("/api/v1/events", "readonly", (context) => openEventsStream(context, options));
}

function openEventsStream(context: RequestContext, options: EventsRouteOptions): RouteResult {
  if (!context.caller) throw new ApiError("unauthenticated", "a session is required", 401);
  const requested = lastEventId(context);
  const replay = options.events.replay(requested);
  const sse = new SseStream(context.res, {
    now: options.now,
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.retryMs !== undefined ? { retryMs: options.retryMs } : {}),
  });
  const untrack = context.track(sse);

  if (replay.resync) sse.resync(replay.cursor, "cursor_too_old");
  else for (const notification of replay.notifications) sse.send(notification);

  const subscription = options.events.subscribe((notification: Notification) => {
    sse.send(notification);
    if (notification.kind === "server.shutdown") sse.close();
  });
  context.res.on("close", () => subscription.close());
  context.res.on("close", untrack);
  return { status: 200, handled: true };
}

function lastEventId(context: RequestContext): string | undefined {
  const header = context.req.headers["last-event-id"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader !== undefined && fromHeader.length > 0) return fromHeader;
  const fromQuery = context.query.get("lastEventId");
  return fromQuery !== null && fromQuery.length > 0 ? fromQuery : undefined;
}
