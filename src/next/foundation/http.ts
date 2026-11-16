/** Transport primitives for the workbench's `/api/v1` client: the bearer
 * session, the single error envelope every core route returns, and the request
 * helper the REST functions share.
 *
 * Wire shapes here mirror `core/http/errors.ts` (`ErrorEnvelope`) and
 * `core/identity/scopes.ts` (`PermissionScope`), which are not part of
 * `packages/agent-protocol`. */

import { useEffect, useSyncExternalStore } from "react";

export const API_BASE = "/api/v1";

/** Every route failure, including a 404 and an oversized body, uses this
 * shape. `details.requestId` is present on responses from the core server. */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

/** What a paired client may do. Mirrors `core/identity/scopes.ts`. */
export type PermissionScope = "readonly" | "device" | "owner";

export interface AuthSession {
  readonly id: string;
  readonly label: string;
  readonly scope: PermissionScope;
  readonly expiresAt: string;
}

/** `contract_missing` is this client's own code for a server behaviour it
 * needs but the protocol package does not define yet. It is never sent to the
 * server and never stands in for a guessed request. */
export const CONTRACT_MISSING = "contract_missing";
export const NETWORK_ERROR = "network_error";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, status: number, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** A typed refusal for a contract this client needs and the wire does not
 * publish. Callers render it; they never fall back to a guessed request. */
export function contractMissing(contract: string): ApiError {
  return new ApiError(CONTRACT_MISSING, `the workbench has no published contract for ${contract}`, 0);
}

let desktopBaseUrl: string | undefined;
let desktopConnection: Promise<void> | undefined;

export function connectDesktopCore(): Promise<void> {
  const bridge = globalThis.window?.ogb?.taskCore;
  if (!bridge) return Promise.resolve();
  desktopConnection ??= bridge.connect().then(connection => {
    desktopBaseUrl = connection.baseUrl;
    if (snapshot?.token !== connection.token) {
      snapshot = { status: "paired", token: connection.token, session: connection.session, error: null };
      notify();
    }
  }).finally(() => { desktopConnection = undefined; });
  return desktopConnection;
}

const SESSION_KEY = "eacbot.workbench.session.v1";

export interface AuthSnapshot {
  readonly status: "anonymous" | "paired";
  readonly token: string | null;
  readonly session: AuthSession | null;
  readonly error: string | null;
}

const ANONYMOUS: AuthSnapshot = { status: "anonymous", token: null, session: null, error: null };

const sessionListeners = new Set<() => void>();
let snapshot: AuthSnapshot | undefined;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isScope(value: unknown): value is PermissionScope {
  return value === "readonly" || value === "device" || value === "owner";
}

/** Reads a stored session, refusing a hand-edited or half-written value: a
 * token without a usable scope would only produce 403s the UI cannot explain. */
export function parseStoredSession(raw: unknown): AuthSnapshot | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const token = source.token;
  const session = source.session;
  if (typeof token !== "string" || token.length === 0) return undefined;
  if (session === null || typeof session !== "object") return undefined;
  const candidate = session as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return undefined;
  if (typeof candidate.label !== "string") return undefined;
  if (!isScope(candidate.scope)) return undefined;
  if (typeof candidate.expiresAt !== "string" || Number.isNaN(Date.parse(candidate.expiresAt))) return undefined;
  return {
    status: "paired",
    token,
    session: { id: candidate.id, label: candidate.label, scope: candidate.scope, expiresAt: candidate.expiresAt },
    error: null,
  };
}

function read(): AuthSnapshot {
  if (snapshot !== undefined) return snapshot;
  let raw: unknown;
  try {
    const stored = storage()?.getItem(SESSION_KEY);
    raw = stored ? JSON.parse(stored) : undefined;
  } catch {
    raw = undefined;
  }
  snapshot = parseStoredSession(raw) ?? ANONYMOUS;
  return snapshot;
}

function notify(): void {
  for (const listener of sessionListeners) listener();
}

function subscribe(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

export function authSnapshot(): AuthSnapshot {
  return read();
}

export function authToken(): string | null {
  return read().token;
}

/** Keeps the paired session. The token is the durable credential; the session
 * record beside it only names what the token may do. */
export function saveSession(token: string, session: AuthSession): void {
  snapshot = { status: "paired", token, session, error: null };
  try {
    storage()?.setItem(SESSION_KEY, JSON.stringify({ token, session }));
  } catch {}
  notify();
}

export function setAuthError(message: string | null): void {
  snapshot = { ...read(), error: message };
  notify();
}

export function clearSession(): void {
  snapshot = { ...ANONYMOUS };
  try {
    storage()?.removeItem(SESSION_KEY);
  } catch {}
  notify();
}

export function subscribeAuth(listener: () => void): () => void {
  return subscribe(listener);
}

export interface PairingClaim {
  readonly code: string;
  readonly label: string;
  readonly scope?: PermissionScope;
}

export interface PairingResult {
  readonly token: string;
  readonly session: AuthSession;
}

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly token?: () => string | null;
  readonly fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  /** Sends the bearer but keeps a 401 from clearing the stored session; the
   * pairing claim uses this so a wrong code never looks like a revoked device. */
  readonly keepSessionOnUnauthorized?: boolean;
}

export interface ApiClient {
  readonly baseUrl: string;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions["query"]): string {
  const relative = baseUrl.startsWith("/");
  const base = new URL(baseUrl, relative ? "http://127.0.0.1" : undefined);
  const joined = `${base.pathname.replace(/\/+$/u, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const url = new URL(joined, base.origin);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  // A relative base stays relative, so the browser and Electron resolve it
  // against the page's own origin and the dev proxy sees it as same-origin.
  return relative ? `${url.pathname}${url.search}` : url.toString();
}

async function readEnvelope(response: Response): Promise<ErrorEnvelope | undefined> {
  try {
    const body = (await response.json()) as unknown;
    if (body !== null && typeof body === "object" && "error" in body) return body as ErrorEnvelope;
  } catch {}
  return undefined;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? API_BASE;
  const token = options.token ?? authToken;
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<T> {
    if (options.baseUrl === undefined && globalThis.window?.ogb?.taskCore) await connectDesktopCore();
    const bearer = token();
    const headers: Record<string, string> = { accept: "application/json", ...requestOptions.headers };
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    if (requestOptions.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await fetchImpl(buildUrl(options.baseUrl ?? desktopBaseUrl ?? baseUrl, path, requestOptions.query), {
        method: requestOptions.method ?? "GET",
        headers,
        ...(requestOptions.body !== undefined ? { body: JSON.stringify(requestOptions.body) } : {}),
        ...(requestOptions.signal !== undefined ? { signal: requestOptions.signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiError(NETWORK_ERROR, error instanceof Error ? error.message : "the request did not reach the server", 0);
    }

    if (!response.ok) {
      const envelope = await readEnvelope(response);
      if (response.status === 401 && bearer !== null && requestOptions.keepSessionOnUnauthorized !== true) clearSession();
      throw new ApiError(
        envelope?.error.code ?? `http_${response.status}`,
        envelope?.error.message ?? `the server answered ${response.status}`,
        response.status,
        envelope?.error.details,
      );
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError("invalid_response", "the server sent a body that is not JSON", response.status);
    }
  }

  return { get baseUrl() { return options.baseUrl ?? desktopBaseUrl ?? baseUrl; }, request };
}

const defaultClient = createApiClient();

/** The process-wide client. It reads the bearer at call time, so pairing or
 * signing out takes effect without rebuilding it. */
export function apiClient(): ApiClient {
  return defaultClient;
}

export function useApi(): ApiClient {
  return defaultClient;
}

export interface AuthState extends AuthSnapshot {
  readonly claim: (input: PairingClaim) => Promise<PairingResult>;
  readonly signOut: () => void;
}

/** Pairing is how a new device gets in: the local terminal printed the code,
 * and the claim trades it for a durable bearer. */
export async function claimPairing(
  input: PairingClaim,
  client: ApiClient = defaultClient,
): Promise<PairingResult> {
  const body = await client.request<{ token: string; session: AuthSession }>("/pairing/claim", {
    method: "POST",
    body: {
      code: input.code,
      label: input.label,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
    },
    keepSessionOnUnauthorized: true,
  });
  const session: AuthSession = {
    id: body.session.id,
    label: body.session.label,
    scope: body.session.scope,
    expiresAt: body.session.expiresAt,
  };
  saveSession(body.token, session);
  return { token: body.token, session };
}

export function useAuth(): AuthState {
  useEffect(() => {
    if (!globalThis.window?.ogb?.taskCore) return;
    let active = true;
    const refresh = () => void connectDesktopCore().catch(error => {
      if (active) setAuthError(error instanceof Error ? error.message : "任务服务连接失败");
    });
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const state = useSyncExternalStore(subscribeAuth, authSnapshot, () => ANONYMOUS);
  return {
    ...state,
    claim: async (input) => {
      try {
        return await claimPairing(input);
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "pairing failed");
        throw error;
      }
    },
    signOut: clearSession,
  };
}
