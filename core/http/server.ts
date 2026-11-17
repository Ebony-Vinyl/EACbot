import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "node:http";
import type { Duplex } from "node:stream";

import type { EventHub } from "../events/hub.ts";
import type { IdentityService } from "../identity/service.ts";
import type { PermissionScope } from "../identity/scopes.ts";
import { IdentityError } from "../identity/errors.ts";
import { applySecurityHeaders, reasonPhrase, requestPath, sendJson } from "./respond.ts";
import { ApiError, envelope, mapError } from "./errors.ts";
import { resolveRequestId } from "./request-id.ts";
import type { Caller, Closable, RequestContext, Route, RouteResult } from "./context.ts";
import { Router } from "./router.ts";

export interface HttpLayerOptions {
  readonly identity: IdentityService;
  readonly events: EventHub;
  readonly router: Router;
  readonly now: () => string;
  /** Refuse a non-loopback peer outright. A local server that answers a
   * remote address is one the person did not ask for. */
  readonly loopbackOnly?: boolean;
  readonly cors?: { readonly enabled: boolean; readonly allowedOrigins?: readonly string[] };
  /** Serves a path before the API router sees it. Returning true means the
   * response is already written. Static assets use this; `/api` paths are
   * never offered to it. */
  readonly beforeRoute?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  readonly log?: (line: string) => void;
  readonly onInternalError?: (error: unknown, context: string) => void;
}

export interface HttpLayer {
  readonly server: Server;
  readonly router: Router;
  readonly streams: Set<Closable>;
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  shutdown(): Promise<void>;
}

const SCOPE_RANK: Readonly<Record<PermissionScope, number>> = { readonly: 1, device: 2, owner: 3 };

/** The HTTP/SSE/WSS surface. It owns transport concerns only: routing,
 * authentication, the error envelope, body limits and stream lifecycle. Every
 * mutation is delegated to a port that already owns the durable state. */
export function createHttpLayer(options: HttpLayerOptions): HttpLayer {
  const streams = new Set<Closable>();
  /** Upgraded sockets, which `server.closeAllConnections` does not reach: once
   * a socket leaves the HTTP parser it is no longer one of the server's
   * connections, so shutdown must end it itself. */
  const upgraded = new Set<Duplex>();
  const server = new Server();
  const log = options.log ?? (() => {});
  const cors = options.cors ?? { enabled: false };

  const publish = (input: Parameters<EventHub["publish"]>[0]): void => {
    options.events.publish(input);
  };

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = resolveRequestId(req.headers["x-request-id"]);
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    applySecurityHeaders(res, { cors: cors.enabled, allowedOrigins: cors.allowedOrigins ?? [] }, origin);
    res.setHeader("x-request-id", requestId);

    try {
      guardOrigin(req, res, cors, origin);      if (res.headersSent) return;

      if (options.beforeRoute !== undefined && (await options.beforeRoute(req, res))) return;
      if (res.headersSent) return;

      const matched = options.router.match(req.method ?? "GET", requestPath(req));
      if (matched === undefined) throw new ApiError("not_found", "no such route", 404);
      if (matched === "method_not_allowed") throw new ApiError("method_not_allowed", "this path has no such method", 405);

      const loopback = isLoopback(req.socket.remoteAddress);
      if (options.loopbackOnly === true && !loopback) {
        throw new ApiError("forbidden", "this server only answers on loopback", 403);
      }

      const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      const caller = authenticate(options, matched.route, req, query);
      const context: RequestContext = {
        req,
        res,
        requestId,
        params: matched.params,
        query,
        caller,
        loopback,
        upgradeSocket: undefined,
        upgradeHead: undefined,
        publish,
        track: (closable) => {
          streams.add(closable);
          return () => void streams.delete(closable);
        },
      };
      const result = await matched.route.handler(context);
      if (res.headersSent) return;
      const response: RouteResult = result ?? { status: 204 };
      if (response.handled === true) return;
      sendJson(res, {
        status: response.status,
        ...(response.body !== undefined ? { body: response.body } : {}),
        ...(response.headers !== undefined ? { headers: response.headers } : {}),
      });
    } catch (error) {
      const mapped = mapError(error, requestId);
      if (mapped.internal) {
        log(`[${requestId}] internal error: ${describe(error)}`);
        options.onInternalError?.(error, `${req.method ?? "GET"} ${requestPath(req)}`);
      }
      if (!res.headersSent) sendJson(res, { status: mapped.status, body: mapped.envelope });
      else res.destroy();
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    void upgrade(req, socket, head).catch((error: unknown) => {
      const requestId = resolveRequestId(req.headers["x-request-id"]);
      const mapped = mapError(error, requestId);
      if (mapped.internal) log(`[${requestId}] upgrade error: ${describe(error)}`);
      socket.destroy();
    });
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const requestId = resolveRequestId(req.headers["x-request-id"]);
    try {
      const matched = options.router.matchUpgrade(requestPath(req));
      if (matched === undefined || matched === "method_not_allowed") {
        throw new ApiError("not_found", "no such upgrade route", 404);
      }
      const route = matched.route;
      if (route.auth !== "ticket") throw new ApiError("forbidden", "this route is not an upgrade route", 403);
      const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      const caller = authenticate(options, route, req, query);
      const peer = (socket as unknown as { remoteAddress?: string }).remoteAddress;
      const context: RequestContext = {
        req,
        res: undefined as unknown as ServerResponse,
        requestId,
        params: matched.params,
        query,
        caller,
        loopback: isLoopback(peer),
        upgradeSocket: socket,
        upgradeHead: head,
        publish,
        track: (closable) => {
          streams.add(closable);
          upgraded.add(socket);
          return () => void streams.delete(closable);
        },
      };
      const result = await route.handler(context);
      if (result === undefined) socket.destroy();
    } catch (error) {
      const mapped = mapError(error, requestId);
      if (mapped.internal) log(`[${requestId}] upgrade refused: ${describe(error)}`);
      writeRefusal(socket, mapped.status, mapped.envelope);
    }
  }

  async function shutdown(): Promise<void> {
    const open = Array.from(streams);
    for (const stream of open) {
      try {
        stream.close();
      } catch (error) {
        log(`stream close failed: ${describe(error)}`);
      }
    }
    streams.clear();
    for (const socket of upgraded) socket.destroy();
    upgraded.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  server.on("request", (req, res) => void handleRequest(req, res));
  server.on("upgrade", handleUpgrade);
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
  });

  return { server, router: options.router, streams, handleRequest, handleUpgrade, shutdown };
}

function guardOrigin(
  req: IncomingMessage,
  res: ServerResponse,
  cors: { enabled: boolean; allowedOrigins?: readonly string[] },
  origin: string | undefined,
): void {
  if (req.method === "OPTIONS" && cors.enabled) {
    res.writeHead(204, {
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-request-id, last-event-id",
      "access-control-max-age": "600",
    });
    res.end();
    return;
  }
  if (origin === undefined) return;
  // Module scripts and stylesheet fetches carry `Origin` even same-origin. A
  // matching Host is the page this server is already serving, not a cross-site
  // request; every other origin still has to be on the CORS allow-list.
  if (sameHost(req, origin)) return;
  if (!cors.enabled) throw new ApiError("forbidden_origin", "cross-origin requests are disabled", 403);
  if (!(cors.allowedOrigins ?? []).includes(origin)) {
    throw new ApiError("forbidden_origin", "this origin is not allowed", 403);
  }
}

function sameHost(req: IncomingMessage, origin: string): boolean {
  try {
    const fromOrigin = new URL(origin).host.toLowerCase();
    const host = req.headers.host?.toLowerCase();
    return host !== undefined && fromOrigin === host;
  } catch {
    return false;
  }
}

function authenticate(options: HttpLayerOptions, route: Route, req: IncomingMessage, query: URLSearchParams): Caller | undefined {
  if (route.auth === "public") return undefined;

  const ticket = query.get("ticket");
  if (route.auth === "ticket" || (route.auth === "stream" && ticket !== null)) {
    if (route.ticketPurpose === undefined) throw new ApiError("forbidden", "this route has no ticket purpose", 403);
    if (ticket === null || ticket.length === 0) throw new IdentityError("unauthenticated", "a ticket is required");
    const grant = options.identity.redeemTicket(ticket, route.ticketPurpose);
    const caller: Caller = { sessionId: grant.sessionId, scope: grant.scope };
    requireScope(caller, route.scope);
    return caller;
  }

  const header = req.headers.authorization;
  const authenticated = options.identity.authenticateHeader(Array.isArray(header) ? header[0] : header);
  const caller: Caller = { sessionId: authenticated.session.id, scope: authenticated.scope };
  requireScope(caller, route.scope);
  return caller;
}

function requireScope(caller: Caller, required: PermissionScope): void {
  if (SCOPE_RANK[caller.scope] < SCOPE_RANK[required]) {
    throw new IdentityError("forbidden", `this call needs the ${required} scope`);
  }
}

export function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
}

function writeRefusal(socket: Duplex, status: number, body: ReturnType<typeof envelope>): void {
  const payload = JSON.stringify(body);
  const lines = [
    `HTTP/1.1 ${status} ${reasonPhrase(status)}`,
    "content-type: application/json; charset=utf-8",
    `content-length: ${Buffer.byteLength(payload)}`,
    "connection: close",
    "cache-control: no-store",
  ];
  socket.write(`${lines.join("\r\n")}\r\n\r\n${payload}`);
  socket.end();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
