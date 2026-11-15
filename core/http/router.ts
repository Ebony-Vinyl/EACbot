import type { PermissionScope } from "../identity/scopes.ts";
import type { Route, RouteAuth, RouteHandler } from "./context.ts";

export interface Match {
  readonly route: Route;
  readonly params: Readonly<Record<string, string>>;
}

export type MatchResult = Match | "method_not_allowed" | undefined;

/** A route table over exact path segments. `:name` matches one non-empty
 * segment; nothing else is a wildcard, so an unknown path is a 404 rather than
 * a handler guessing. */
export class Router {
  readonly #routes: Route[] = [];

  add(route: Route): this {
    this.#routes.push(route);
    return this;
  }

  get(pattern: string, scope: PermissionScope, handler: RouteHandler, auth: RouteAuth = "bearer"): this {
    return this.add({ method: "GET", pattern: segments(pattern), scope, auth, handler });
  }

  post(pattern: string, scope: PermissionScope, handler: RouteHandler, auth: RouteAuth = "bearer"): this {
    return this.add({ method: "POST", pattern: segments(pattern), scope, auth, handler });
  }

  delete(pattern: string, scope: PermissionScope, handler: RouteHandler, auth: RouteAuth = "bearer"): this {
    return this.add({ method: "DELETE", pattern: segments(pattern), scope, auth, handler });
  }

  /** A stream a browser reaches with a ticket and a native client with its
   * bearer: both are accepted on the same path. */
  streamGet(pattern: string, scope: PermissionScope, handler: RouteHandler): this {
    return this.add({ method: "GET", pattern: segments(pattern), scope, auth: "stream", ticketPurpose: "events", handler });
  }

  /** A WebSocket upgrade. The route is matched on the GET path the client
   * upgraded, and only a ticket is accepted because a `WebSocket` constructor
   * cannot set an Authorization header. */
  upgradeGet(pattern: string, scope: PermissionScope, handler: RouteHandler): this {
    return this.add({ method: "GET", pattern: segments(pattern), scope, auth: "ticket", ticketPurpose: "terminal", upgrade: true, handler });
  }

  match(method: string, path: string): MatchResult {
    return this.#match(method, path, false);
  }

  /** Only routes declared as upgrades can be reached by a handshake. */
  matchUpgrade(path: string): MatchResult {
    return this.#match("GET", path, true);
  }

  #match(method: string, path: string, upgrade: boolean): MatchResult {
    const parts = segments(path);
    let pathMatched = false;
    for (const route of this.#routes) {
      if ((route.upgrade === true) !== upgrade) continue;
      const params = matchPattern(route.pattern, parts);
      if (params === undefined) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? "method_not_allowed" : undefined;
  }

  get routes(): readonly Route[] {
    return this.#routes;
  }
}

export function segments(path: string): string[] {
  return path.split("/").filter((part) => part.length > 0);
}

function matchPattern(pattern: readonly string[], parts: readonly string[]): Record<string, string> | undefined {
  if (pattern.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] as string;
    const actual = parts[index] as string;
    if (expected.startsWith(":")) {
      if (actual.length === 0) return undefined;
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
}
