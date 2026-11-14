// A tiny health provider for tests: authorization-code + PKCE, a token endpoint that checks the verifier, and the
// two data shapes this build reads. No imports from the repo, so a test can start it as a bare node child.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeHealthProviderOptions {
  /** `withings` wraps every answer in `{status, body}`; the others answer flat. */
  shape?: "withings" | "oura";
  /** Refuse the code exchange, so a test can see the failure path. */
  denyToken?: boolean;
  /** Seconds an access token lives; a test uses a small value to exercise renewal. */
  expiresIn?: number;
  /** Hold the token answer, so a test can cancel a sign-in mid-flight. */
  tokenDelayMs?: number;
}

export interface FakeHealthProvider {
  origin: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** A valid access token, as if issued out of band. */
  mint(): string;
  counts: { authorize: number; token: number; refresh: number };
  lastAuthorize: URLSearchParams | null;
  /** Every access token the data endpoints were shown, in order. */
  seenTokens: string[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const DAY = 86_400_000;

/** Two days of readings, so a sync has something to write and a second sync has nothing new. */
function withingsMeasures(base: number) {
  return {
    measuregrps: [
      { grpid: 1, attrib: 0, date: Math.floor(base / 1000) - 86_400, created: Math.floor(base / 1000), category: 1, deviceid: "scale", measures: [{ value: 724, type: 1, unit: -1 }, { value: 212, type: 6, unit: -1 }] },
      { grpid: 2, attrib: 0, date: Math.floor(base / 1000) - 43_200, created: Math.floor(base / 1000), category: 1, deviceid: "scale", measures: [{ value: 721, type: 1, unit: -1 }, { value: 3_000, type: 77, unit: -1 }] },
      // A type this build does not name: it must be counted as skipped, never guessed at.
      { grpid: 3, attrib: 0, date: Math.floor(base / 1000) - 3_600, created: Math.floor(base / 1000), category: 1, deviceid: "scale", measures: [{ value: 1, type: 9999, unit: 0 }] },
    ],
    more: 0,
    offset: 0,
  };
}

function withingsActivity(base: number) {
  const today = new Date(base).toISOString().slice(0, 10);
  const yesterday = new Date(base - DAY).toISOString().slice(0, 10);
  return {
    activities: [
      { date: yesterday, steps: 8_400, distance: 6_100, calories: 320, totalcalories: 2_100, soft: 1_800, moderate: 900, intense: 300 },
      { date: today, steps: 3_200, distance: 2_300, calories: 120, totalcalories: 1_400, soft: 600, moderate: 0, intense: 0 },
    ],
    more: false,
    offset: 0,
  };
}

function ouraCollections(base: number) {
  const today = new Date(base).toISOString().slice(0, 10);
  return {
    "/v2/usercollection/daily_activity": {
      data: [{ day: today, steps: 9_100, active_calories: 410, total_calories: 2_300, equivalent_walking_distance: 7_200 }],
    },
    "/v2/usercollection/sleep": {
      data: [{
        day: today,
        total_sleep_duration: 26_400,
        deep_sleep_duration: 5_400,
        rem_sleep_duration: 6_000,
        light_sleep_duration: 15_000,
        awake_time: 1_200,
        lowest_heart_rate: 52,
        average_hrv: 48,
        average_breath: 14.2,
      }],
    },
    "/v2/usercollection/daily_sleep": { data: [{ day: today, score: 81 }] },
    "/v2/usercollection/daily_readiness": { data: [{ day: today, score: 77, temperature_deviation: 0.2 }] },
    "/v2/usercollection/daily_spo2": { data: [{ day: today, spo2_percentage: { average: 97.4 } }] },
  };
}

export async function startFakeHealthProvider(options: FakeHealthProviderOptions = {}): Promise<FakeHealthProvider> {
  const shape = options.shape ?? "withings";
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const counts = { authorize: 0, token: 0, refresh: 0 };
  const seenTokens: string[] = [];
  let origin = "";
  const fake: Partial<FakeHealthProvider> = { counts, seenTokens, lastAuthorize: null };
  const expiresIn = options.expiresIn ?? 3_600;
  const base = Date.parse("2026-11-14T09:00:00Z");

  const tokenResponse = (res: ServerResponse, tokens: { access: string; refresh: string }) => {
    const body = { access_token: tokens.access, refresh_token: tokens.refresh, expires_in: expiresIn, token_type: "bearer" };
    send(res, 200, shape === "withings" ? { status: 0, body } : body);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");

      if (url.pathname === "/authorize") {
        counts.authorize += 1;
        fake.lastAuthorize = url.searchParams;
        const state = url.searchParams.get("state") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        if (!state || !challenge || !redirectUri) {
          send(res, 400, { error: "invalid_request" });
          return;
        }
        const code = randomBytes(16).toString("base64url");
        codes.set(code, { challenge, redirectUri });
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", state);
        res.writeHead(302, { location: target.toString() }).end();
        return;
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        if (options.tokenDelayMs) await new Promise((resolve) => setTimeout(resolve, options.tokenDelayMs));
        const grant = form.get("grant_type");
        if (grant === "refresh_token") {
          counts.refresh += 1;
          const presented = form.get("refresh_token") ?? "";
          if (!refresh.has(presented)) {
            send(res, 400, shape === "withings" ? { status: 400, error: "invalid_grant" } : { error: "invalid_grant" });
            return;
          }
          const nextAccess = randomBytes(16).toString("base64url");
          access.add(nextAccess);
          // Withings keeps the refresh token; Oura rotates it. Both are exercised by the tests.
          const nextRefresh = shape === "withings" ? presented : randomBytes(16).toString("base64url");
          if (nextRefresh !== presented) { refresh.delete(presented); refresh.add(nextRefresh); }
          tokenResponse(res, { access: nextAccess, refresh: nextRefresh });
          return;
        }
        counts.token += 1;
        if (options.denyToken) {
          send(res, 400, shape === "withings" ? { status: 400, error: "invalid_request" } : { error: "invalid_grant" });
          return;
        }
        const code = form.get("code") ?? "";
        const verifier = form.get("code_verifier") ?? "";
        const pending = codes.get(code);
        if (!pending) {
          send(res, 400, shape === "withings" ? { status: 400, error: "invalid_grant" } : { error: "invalid_grant" });
          return;
        }
        codes.delete(code);
        const expected = createHash("sha256").update(verifier).digest("base64url");
        if (expected !== pending.challenge) {
          send(res, 400, shape === "withings" ? { status: 400, error: "invalid_grant" } : { error: "invalid_grant" });
          return;
        }
        const nextAccess = randomBytes(16).toString("base64url");
        const nextRefresh = randomBytes(16).toString("base64url");
        access.add(nextAccess);
        refresh.add(nextRefresh);
        tokenResponse(res, { access: nextAccess, refresh: nextRefresh });
        return;
      }

      // The data endpoints. A request without a token this server issued is a 401, which is how the adapter learns
      // that a sign-in has to be redone.
      const authorized = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
      if (authorized) seenTokens.push(authorized);
      if (!access.has(authorized)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }

      if (url.pathname === "/measure" && url.searchParams.get("action") === "getmeas") {
        send(res, 200, shape === "withings" ? { status: 0, body: withingsMeasures(base) } : withingsMeasures(base));
        return;
      }
      if (url.pathname === "/v2/measure" && url.searchParams.get("action") === "getactivity") {
        send(res, 200, shape === "withings" ? { status: 0, body: withingsActivity(base) } : withingsActivity(base));
        return;
      }
      const collections = ouraCollections(base) as Record<string, unknown>;
      if (Object.hasOwn(collections, url.pathname)) {
        send(res, 200, collections[url.pathname]);
        return;
      }
      send(res, 404, { error: "not_found" });
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: "fixture_failure" });
      else res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    authorizeUrl: `${origin}/authorize`,
    tokenUrl: `${origin}/token`,
    mint() {
      const token = randomBytes(16).toString("base64url");
      access.add(token);
      return token;
    },
    counts,
    seenTokens,
    get lastAuthorize() {
      return fake.lastAuthorize ?? null;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
