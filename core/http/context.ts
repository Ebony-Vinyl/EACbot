import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { Notification } from "../events/hub.ts";
import type { PermissionScope } from "../identity/scopes.ts";
import type { TicketPurpose } from "../identity/tickets.ts";

/** Who a route acts as. A bearer session and a redeemed ticket both reduce to
 * this, so a handler never needs to know which one it got. */
export interface Caller {
  readonly sessionId: string;
  readonly scope: PermissionScope;
}

export interface Closable {
  close(): void;
}

/** How a route establishes who is calling.
 *
 * `ticket` exists because `EventSource` and `WebSocket` cannot set an
 * Authorization header; those routes take a short-lived single-use ticket in
 * the query string instead of the durable device bearer. `stream` accepts
 * either, so a native client keeps its bearer while a browser falls back to a
 * ticket. */
export type RouteAuth = "public" | "bearer" | "ticket" | "stream";

export interface RouteResult {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** The handler wrote the response itself (a stream) and the pipeline must
   * not write a body over it. */
  readonly handled?: boolean;
}

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly requestId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly caller: Caller | undefined;
  readonly loopback: boolean;
  /** The raw socket of an accepted upgrade; present only on an upgrade. */
  readonly upgradeSocket: Duplex | undefined;
  /** Bytes the client sent after the handshake request, already read off the
   * socket by Node. They must reach the stream or the first frame is lost. */
  readonly upgradeHead: Uint8Array | undefined;
  readonly publish: (input: { kind: Notification["kind"]; missionId?: string; runId?: string; revision?: number }) => void;
  /** Registers a stream the server must close on shutdown. Returns the
   * deregistration the stream calls when it ends on its own. */
  readonly track: (closable: Closable) => () => void;
}

export type RouteHandler = (context: RequestContext) => Promise<RouteResult | void> | RouteResult | void;

export interface Route {
  readonly method: "GET" | "POST" | "DELETE";
  readonly pattern: readonly string[];
  /** The scope a caller needs. A route cannot be added without naming one. */
  readonly scope: PermissionScope;
  readonly auth: RouteAuth;
  /** Set only with `auth: "ticket"` or `auth: "stream"`: which stream the
   * ticket must be for. */
  readonly ticketPurpose?: TicketPurpose;
  /** Only an `upgrade` route may be reached by a WebSocket handshake, and
   * only an `upgrade` route may be reached by a plain request. */
  readonly upgrade?: boolean;
  readonly handler: RouteHandler;
}
