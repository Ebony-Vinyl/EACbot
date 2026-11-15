import { EventHub } from "../events/hub.ts";
import type { NotificationKind } from "../events/hub.ts";
import type { IdentityService } from "../identity/service.ts";
import { Router } from "../http/router.ts";
import { createHttpLayer, type HttpLayer } from "../http/server.ts";
import { createStaticHandler } from "../http/static.ts";
import { registerRoutes, type RouteDeps } from "../http/routes.ts";
import { registerEventsRoute } from "../http/events-route.ts";
import { registerTerminalStreamRoute } from "../http/terminal-stream.ts";
import type { AgentCatalogPort, EnvironmentPort, MissionPort, TerminalPort, TerminalStreamHandler } from "../http/ports.ts";

export const SERVER_VERSION = "0.2.0-core.1";

export interface ServerComposition {
  readonly missions: MissionPort;
  readonly identity: IdentityService;
  readonly agents: AgentCatalogPort;
  readonly environments: EnvironmentPort;
  readonly terminals: TerminalPort;
  readonly terminalStreams: TerminalStreamHandler;
  readonly now?: () => string;
  readonly version?: string;
  readonly cors?: { readonly enabled: boolean; readonly allowedOrigins?: readonly string[] };
  /** A built workbench directory to serve beside `/api`. Omitted in tests and
   * in a headless process, where the API is the whole surface. */
  readonly staticRoot?: string;
  readonly replayLimit?: number;
  readonly log?: (line: string) => void;
  readonly onError?: (error: unknown, context: string) => void;
}

export interface ComposedServer {
  readonly layer: HttpLayer;
  readonly events: EventHub;
  readonly router: Router;
  /** Publishes a mission notification. The composition calls this after a
   * durable write; the HTTP layer only reads it. */
  readonly publish: (input: { kind: NotificationKind; missionId?: string; runId?: string; revision?: number }) => void;
  /** Closes the event stream, then the HTTP layer. Ordered so a client sees
   * `server.shutdown` before its connection drops. */
  shutdown(): Promise<void>;
}

/** Wires the layers without owning any of them. Nothing here decides policy:
 * scopes live in identity, commands in the mission runtime, and this file only
 * states which port each route reads. */
export function composeServer(composition: ServerComposition): ComposedServer {
  const now = composition.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const onError = composition.onError ?? (() => {});
  const events = new EventHub({
    now,
    ...(composition.replayLimit !== undefined ? { replayLimit: composition.replayLimit } : {}),
    onListenerError: (error) => onError(error, "event listener"),
  });
  const router = new Router();

  const deps: RouteDeps = {
    router,
    missions: composition.missions,
    agents: composition.agents,
    environments: composition.environments,
    terminals: composition.terminals,
    identity: composition.identity,
    now,
    cursor: () => events.cursor,
    version: composition.version ?? SERVER_VERSION,
    startedAt,
  };
  registerRoutes(deps);
  registerEventsRoute(router, { events, now });
  registerTerminalStreamRoute(router, { terminals: composition.terminals, handler: composition.terminalStreams });

  const layer = createHttpLayer({
    identity: composition.identity,
    events,
    router,
    now,
    loopbackOnly: true,
    ...(composition.staticRoot !== undefined
      ? { beforeRoute: createStaticHandler({ root: composition.staticRoot, entryFile: "index.html" }) }
      : {}),
    ...(composition.cors !== undefined ? { cors: composition.cors } : {}),
    ...(composition.log !== undefined ? { log: composition.log } : {}),
    onInternalError: (error, context) => onError(error, context),
  });

  return {
    layer,
    events,
    router,
    publish: (input) => void events.publish(input),
    async shutdown() {
      events.close();
      await layer.shutdown();
    },
  };
}
