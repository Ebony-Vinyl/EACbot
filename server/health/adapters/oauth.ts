// OAuth 2.0 authorization-code + PKCE for a health provider. Separate from server/mcp-oauth.ts on purpose: that one
// speaks RFC 9728 resource metadata and dynamic client registration for MCP servers, while a health provider is a
// plain authorization server with an app registered in advance. Sharing it would mean carrying MCP vocabulary into
// a place that has none.
//
// Facts forced by providers, each checked against their published documentation:
// - Withings returns the token in a `body` field of a 200 response, not in an OAuth error envelope.
// - Oura, Polar and Fitbit answer a form-encoded token request, like RFC 6749 §4.1.3.
// - Only Oura accepts a `scope` on the refresh request; the others reject an unknown parameter.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

export type HealthOAuthProvider = "withings" | "oura" | "polar" | "fitbit";

export interface HealthOAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  /** Where the person is sent to take access away. Absent when the provider has none. */
  revokeUrl?: string;
  scope: string;
}

/** What a person has to paste once: the app they registered with the provider. */
export interface HealthOAuthClient {
  clientId: string;
  /** Public clients (PKCE only) have none. */
  clientSecret?: string;
  /** Overridden for a self-hosted or test endpoint; the production values live in PROVIDER_ENDPOINTS. */
  endpoints?: HealthOAuthEndpoints;
}

export interface HealthOAuthTokens {
  access: string;
  refresh?: string;
  /** Epoch ms. Absent when the provider states no lifetime. */
  expiresAt?: number;
  scope?: string;
}

export interface HealthOAuthRecord {
  provider: HealthOAuthProvider;
  sourceId: string;
  clientId: string;
  tokens: HealthOAuthTokens;
  /** Kept so a refresh can send the same redirect URI, which providers bind the refresh token to. */
  redirectUri: string;
  /** The provider's own user id, when it sends one: two accounts of the same provider must not overwrite each other. */
  account?: string;
}

export type HealthOAuthPhase = "waiting" | "succeeded" | "failed" | "cancelled" | "expired";

export interface HealthOAuthStatus {
  phase: HealthOAuthPhase;
  flowId: string;
  authorizationUrl: string | null;
  expiresAt: string;
  message?: string;
}

export class HealthOAuthError extends Error {
  readonly code: "unknown_provider" | "no_client" | "port_busy" | "refused" | "expired";
  constructor(code: HealthOAuthError["code"], message: string) {
    super(message);
    this.name = "HealthOAuthError";
    this.code = code;
  }
}

export const HEALTH_OAUTH_CALLBACK_PATH = "/api/health/oauth/callback";

/**
 * Each provider's published endpoints and scopes. A person who runs their own instance can override the endpoints
 * in config; the scope is what this build reads, and asking for more would be asking for data nothing here uses.
 */
export const PROVIDER_ENDPOINTS: Readonly<Record<HealthOAuthProvider, HealthOAuthEndpoints>> = {
  withings: {
    authorizeUrl: "https://account.withings.com/oauth2_user/authorize2",
    tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
    scope: "user.metrics,user.activity",
  },
  oura: {
    authorizeUrl: "https://cloud.ouraring.com/oauth/authorize",
    tokenUrl: "https://api.ouraring.com/oauth/token",
    revokeUrl: "https://api.ouraring.com/oauth/revoke",
    scope: "daily heartrate personal workout session spo2",
  },
  polar: {
    authorizeUrl: "https://flow.polar.com/oauth2/authorization",
    tokenUrl: "https://polarremote.com/v2/oauth2/token",
    scope: "accesslink.read_all",
  },
  fitbit: {
    authorizeUrl: "https://www.fitbit.com/oauth2/authorize",
    tokenUrl: "https://api.fitbit.com/oauth2/token",
    revokeUrl: "https://api.fitbit.com/oauth2/revoke",
    scope: "activity heartrate sleep weight profile",
  },
};

/** Oura rotates the refresh token and may expire the old one at once; the others do not say, so a missing one is kept. */
const ROTATES_REFRESH: ReadonlySet<HealthOAuthProvider> = new Set(["oura"]);

const DEFAULT_LIFETIME_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface Flow {
  provider: HealthOAuthProvider;
  sourceId: string;
  client: HealthOAuthClient;
  status: HealthOAuthStatus;
  state: string;
  verifier: string;
  redirectUri: string;
  server: Server | null;
  consumed: boolean;
  expiry: ReturnType<typeof setTimeout>;
  resolve: (record: HealthOAuthRecord) => void;
  reject: (error: Error) => void;
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function sameSecret(actual: string, expected: string): boolean {
  return Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

/** A port derived from the source id, so a provider that binds a redirect URI to one port keeps working across restarts. */
export function healthOAuthPort(sourceId: string): number {
  let hash = 0x811c9dc5;
  for (const char of sourceId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 21_000 + (hash % 9_000);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function postForm(url: string, form: Record<string, string>, authorization?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (authorization) headers.authorization = authorization;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: new URLSearchParams(form).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {}
  return { status: response.status, body };
}

/** Withings wraps its answer in `{status, body}`; the others answer flat. One shape comes out of both. */
function unwrap(provider: HealthOAuthProvider, body: Record<string, unknown>): Record<string, unknown> {
  if (provider !== "withings") return body;
  const inner = body.body;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return body;
  const wrapped = inner as Record<string, unknown>;
  // Withings reports failure as status 0 with an `error` string inside the envelope.
  return typeof body.status === "number" && body.status !== 0 ? { ...wrapped, error: wrapped.error ?? "withings_error" } : wrapped;
}

function tokensFrom(provider: HealthOAuthProvider, body: Record<string, unknown>, previous?: HealthOAuthTokens): HealthOAuthTokens | null {
  const flat = unwrap(provider, body);
  const access = typeof flat.access_token === "string" && flat.access_token ? flat.access_token : null;
  if (!access) return null;
  const refresh = typeof flat.refresh_token === "string" && flat.refresh_token
    ? flat.refresh_token
    : ROTATES_REFRESH.has(provider) ? undefined : previous?.refresh;
  const lifetime = typeof flat.expires_in === "number" && flat.expires_in > 0 ? flat.expires_in * 1000 : undefined;
  return {
    access,
    ...(refresh ? { refresh } : {}),
    ...(lifetime ? { expiresAt: Date.now() + lifetime } : {}),
    ...(typeof flat.scope === "string" ? { scope: flat.scope } : {}),
  };
}

/**
 * One sign-in at a time per source. The listener lives only until the sign-in settles, the state is compared in
 * constant time, and every parameter must appear once, so a replayed or spliced callback is refused rather than
 * traded for a token.
 */
export class HealthOAuthManager {
  private readonly flows = new Map<string, Flow>();
  private readonly lifetimeMs: number;
  private disposed = false;

  constructor(options: { lifetimeMs?: number } = {}) {
    this.lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
  }

  /** Starts a sign-in and resolves when the provider sends the person back. */
  async authorize(options: {
    provider: HealthOAuthProvider;
    sourceId: string;
    client: HealthOAuthClient;
  }): Promise<{ status: HealthOAuthStatus; done: Promise<HealthOAuthRecord> }> {
    const endpoints = options.client.endpoints ?? PROVIDER_ENDPOINTS[options.provider];
    if (!endpoints) throw new HealthOAuthError("unknown_provider", `no endpoints are known for ${options.provider}`);
    if (!options.client.clientId) throw new HealthOAuthError("no_client", "register an app with the provider and paste its client ID first");
    this.cancel(options.sourceId);

    const server = createServer();
    let redirectUri: string;
    try {
      await listen(server, healthOAuthPort(options.sourceId));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("the sign-in listener did not start");
      redirectUri = `http://127.0.0.1:${address.port}${HEALTH_OAUTH_CALLBACK_PATH}`;
    } catch (error) {
      server.close();
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new HealthOAuthError("port_busy", `port ${healthOAuthPort(options.sourceId)} is in use; close what has it and try again`);
      }
      throw error;
    }

    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(32));
    const authorize = new URL(endpoints.authorizeUrl);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", options.client.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    authorize.searchParams.set("code_challenge_method", "S256");
    if (endpoints.scope) authorize.searchParams.set("scope", endpoints.scope);

    let resolveDone: (record: HealthOAuthRecord) => void = () => {};
    let rejectDone: (error: Error) => void = () => {};
    const done = new Promise<HealthOAuthRecord>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // A rejected promise nobody awaits yet would crash the process; the caller reads it from `done`.
    done.catch(() => {});

    const flow: Flow = {
      provider: options.provider,
      sourceId: options.sourceId,
      client: options.client,
      status: {
        phase: "waiting",
        flowId: base64url(randomBytes(16)),
        authorizationUrl: authorize.toString(),
        expiresAt: new Date(Date.now() + this.lifetimeMs).toISOString(),
      },
      state,
      verifier,
      redirectUri,
      server,
      consumed: false,
      expiry: setTimeout(() => this.finish(flow, "expired", "the sign-in window closed; start again"), this.lifetimeMs),
      resolve: resolveDone,
      reject: rejectDone,
    };
    flow.expiry.unref();
    this.flows.set(options.sourceId, flow);
    server.on("request", (request, response) => void this.callback(flow, request, response));
    return { status: { ...flow.status }, done };
  }

  status(sourceId: string): HealthOAuthStatus | undefined {
    const flow = this.flows.get(sourceId);
    return flow ? { ...flow.status } : undefined;
  }

  cancel(sourceId: string): void {
    const flow = this.flows.get(sourceId);
    if (flow) this.finish(flow, "cancelled", "sign-in cancelled");
  }

  dispose(): void {
    this.disposed = true;
    for (const flow of this.flows.values()) this.finish(flow, "cancelled", "the server shut down");
    this.flows.clear();
  }

  private async callback(flow: Flow, request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Referrer-Policy", "no-referrer");
    // A kept-alive connection would carry the next sign-in's callback here after the listener stopped accepting.
    response.setHeader("Connection", "close");
    let callback: URL;
    try {
      const expected = new URL(flow.redirectUri);
      if (request.headers.host !== expected.host || !request.url?.startsWith("/")) throw new Error("host");
      callback = new URL(request.url, flow.redirectUri);
    } catch {
      response.writeHead(400).end("Invalid sign-in callback. Return to EACbot and try again.");
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(400).end("Invalid or expired sign-in. Return to EACbot and try again.");
      return;
    }
    const result = await this.accept(flow, callback);
    response.writeHead(result.status).end(result.text);
  }

  private async accept(flow: Flow, callback: URL): Promise<{ status: number; text: string }> {
    const expected = new URL(flow.redirectUri);
    const params = callback.searchParams;
    const wellFormed = callback.origin === expected.origin && callback.pathname === expected.pathname
      && !callback.username && !callback.password && !callback.hash
      && [...params.keys()].every((key) => params.getAll(key).length === 1)
      && sameSecret(params.get("state") ?? "", flow.state);
    if (!wellFormed) return { status: 400, text: "This redirect does not belong to the current sign-in. Start again from EACbot." };
    if (flow.consumed || flow.status.phase !== "waiting") return { status: 409, text: "This sign-in has already been used. Start again from EACbot." };
    if (Date.now() >= Date.parse(flow.status.expiresAt)) {
      this.finish(flow, "expired", "the sign-in window closed; start again");
      return { status: 400, text: "This sign-in expired. Start again from EACbot." };
    }
    flow.consumed = true;
    clearTimeout(flow.expiry);

    if (params.has("error")) {
      const reason = (params.get("error_description") ?? params.get("error") ?? "").slice(0, 200);
      this.finish(flow, "failed", reason || "the provider did not approve this sign-in");
      return { status: 400, text: "Sign-in was not approved. You can close this tab." };
    }
    const code = params.get("code");
    if (!code || code.length > 4_096) {
      this.finish(flow, "failed", "the provider sent no authorization code");
      return { status: 400, text: "The sign-in returned no code. Start again from EACbot." };
    }

    const endpoints = flow.client.endpoints ?? PROVIDER_ENDPOINTS[flow.provider];
    const form: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      client_id: flow.client.clientId,
      code_verifier: flow.verifier,
    };
    let authorization: string | undefined;
    if (flow.client.clientSecret) {
      // Fitbit requires Basic; the others accept either and Basic keeps the secret out of the body.
      authorization = `Basic ${Buffer.from(`${encodeURIComponent(flow.client.clientId)}:${encodeURIComponent(flow.client.clientSecret)}`).toString("base64")}`;
      delete form.client_id;
    }
    try {
      const answer = await postForm(endpoints.tokenUrl, form, authorization);
      const tokens = answer.status >= 200 && answer.status < 300 ? tokensFrom(flow.provider, answer.body) : null;
      if (!tokens) {
        const flat = unwrap(flow.provider, answer.body);
        const detail = typeof flat.error_description === "string" ? flat.error_description : typeof flat.error === "string" ? flat.error : "";
        this.finish(flow, "failed", `the provider did not accept this sign-in${detail ? `: ${detail.slice(0, 160)}` : ""}`);
        return { status: 400, text: "The provider did not accept this sign-in. Start again from EACbot." };
      }
      if (this.disposed || this.flows.get(flow.sourceId) !== flow || flow.status.phase !== "waiting") {
        await this.revoke(endpoints.revokeUrl, tokens, authorization).catch(() => {});
        return { status: 409, text: "This sign-in was cancelled. Start again from EACbot." };
      }
      const flat = unwrap(flow.provider, answer.body);
      const account = typeof flat.userid === "string" ? flat.userid : typeof flat.userid === "number" ? String(flat.userid) : undefined;
      this.finish(flow, "succeeded");
      flow.resolve({
        provider: flow.provider,
        sourceId: flow.sourceId,
        clientId: flow.client.clientId,
        tokens,
        redirectUri: flow.redirectUri,
        ...(account ? { account } : {}),
      });
      return { status: 200, text: "Signed in. You can close this tab and return to EACbot." };
    } catch {
      this.finish(flow, "failed", "the provider could not be reached");
      return { status: 400, text: "Could not reach the provider. Start again from EACbot." };
    }
  }

  private async revoke(url: string | undefined, tokens: HealthOAuthTokens, authorization: string | undefined): Promise<void> {
    if (!url) return;
    await postForm(url, { token: tokens.refresh ?? tokens.access, token_type_hint: "refresh_token" }, authorization);
  }

  private finish(flow: Flow, phase: HealthOAuthPhase, message?: string): void {
    if (flow.status.phase !== "waiting") return;
    clearTimeout(flow.expiry);
    flow.server?.close();
    flow.server?.closeIdleConnections();
    flow.status = { ...flow.status, phase, authorizationUrl: null, ...(message ? { message } : {}) };
    if (phase !== "succeeded") flow.reject(new HealthOAuthError(phase === "expired" ? "expired" : "refused", message ?? phase));
  }
}

/**
 * Exchanges a refresh token for a new access token. The record is returned with the new tokens rather than mutated,
 * so the caller decides when a rotation is persisted.
 */
export async function refreshHealthTokens(record: HealthOAuthRecord, client: HealthOAuthClient): Promise<HealthOAuthRecord> {
  const endpoints = client.endpoints ?? PROVIDER_ENDPOINTS[record.provider];
  if (!record.tokens.refresh) {
    throw new HealthOAuthError("refused", "this sign-in holds no refresh token, so it cannot be renewed; sign in again");
  }
  const form: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: record.tokens.refresh,
    client_id: client.clientId,
  };
  // Only Oura accepts a scope on refresh; the others refuse an unknown parameter.
  if (ROTATES_REFRESH.has(record.provider) && record.tokens.scope) form.scope = record.tokens.scope;
  let authorization: string | undefined;
  if (client.clientSecret) {
    authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
    delete form.client_id;
  }
  const answer = await postForm(endpoints.tokenUrl, form, authorization);
  const tokens = answer.status >= 200 && answer.status < 300 ? tokensFrom(record.provider, answer.body, record.tokens) : null;
  if (!tokens) {
    const flat = unwrap(record.provider, answer.body);
    const detail = typeof flat.error_description === "string" ? flat.error_description : typeof flat.error === "string" ? flat.error : "";
    throw new HealthOAuthError("refused", `the provider would not renew this sign-in${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
  return { ...record, tokens };
}
