import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import type { ComposedServer } from "../../bootstrap/server.ts";
import { composeServer } from "../../bootstrap/server.ts";
import { IdentityService } from "../../identity/service.ts";
import type { IssuedSession } from "../../identity/sessions.ts";
import { CountingRandom, ManualClock } from "../../identity/testing/fakes.ts";
import { FakeAgentCatalog, FakeEnvironments, FakeMissionPort, FakeTerminalStreams, FakeTerminals } from "./fakes.ts";

export interface HttpFixture {
  readonly identity: IdentityService;
  readonly missions: FakeMissionPort;
  readonly agents: FakeAgentCatalog;
  readonly environments: FakeEnvironments;
  readonly terminals: FakeTerminals;
  readonly streams: FakeTerminalStreams;
  readonly clock: ManualClock;
  readonly random: CountingRandom;
  readonly composed: ComposedServer;
  readonly server: Server;
  readonly base: string;
  session(scope?: "readonly" | "device" | "owner"): IssuedSession;
  request(path: string, init?: RequestInit & { token?: string }): Promise<Response>;
  /** Reads an SSE body until `predicate` is satisfied or the budget runs out. */
  readEvents(path: string, token: string, options?: { headers?: Record<string, string>; until?: (text: string) => boolean; signal?: AbortSignal }): Promise<string>;
  close(): Promise<void>;
}

export interface FixtureOptions {
  readonly cors?: { readonly enabled: boolean; readonly allowedOrigins?: readonly string[] };
  readonly replayLimit?: number;
}

/** A whole server on an ephemeral loopback port with every port faked. Nothing
 * reads `~/.eacbot`, a real mission database or a real terminal. */
export async function createHttpFixture(options: FixtureOptions = {}): Promise<HttpFixture> {
  const clock = new ManualClock();
  const random = new CountingRandom();
  const identity = new IdentityService({ clock, random });
  const missions = new FakeMissionPort();
  const agents = new FakeAgentCatalog();
  const environments = new FakeEnvironments();
  const terminals = new FakeTerminals();
  const streams = new FakeTerminalStreams();

  const composed = composeServer({
    missions,
    identity,
    agents,
    environments,
    terminals,
    terminalStreams: streams,
    now: () => new Date(clock.now()).toISOString(),
    version: "test",
    ...(options.cors !== undefined ? { cors: options.cors } : {}),
    ...(options.replayLimit !== undefined ? { replayLimit: options.replayLimit } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    composed.layer.server.once("error", reject);
    composed.layer.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = composed.layer.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const pairAs = (scope: "readonly" | "device" | "owner"): IssuedSession => {
    const code = identity.issuePairingCode();
    return identity.pair({ code: code.code, label: `test ${scope}`, loopback: true, requestedScope: scope });
  };

  return {
    identity,
    missions,
    agents,
    environments,
    terminals,
    streams,
    clock,
    random,
    composed,
    server: composed.layer.server,
    base,
    session: (scope = "device") => pairAs(scope),
    request: (path, init) => {
      const { token, headers, ...rest } = init ?? {};
      return fetch(`${base}${path}`, {
        ...rest,
        headers: {
          ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
          ...(headers as Record<string, string> | undefined),
        },
      });
    },
    readEvents: (path, token, readOptions) => readEvents(base, path, token, readOptions),
    async close() {
      await composed.shutdown();
    },
  };
}

/** Reads an event stream for a bounded time, so a test never hangs on an open
 * response. Returns whatever arrived. */
export async function readEvents(
  base: string,
  path: string,
  token: string,
  options: { headers?: Record<string, string>; until?: (text: string) => boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  let text = "";
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, ...options.headers },
      signal: controller.signal,
    });
    if (!response.body) return text;
    const decoder = new TextDecoder();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      text += decoder.decode(chunk, { stream: true });
      if (options.until?.(text) === true) break;
    }
  } catch {
    // An aborted read is how a stream test ends; what arrived is the result.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return text;
}
