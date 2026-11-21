// The one place that talks to Kugou. Every call goes through `kugouRequest`, so
// the user agent, the x-router header, the retry rule and the error taxonomy are
// decided once. A caller gets either a parsed body or a typed KugouError; it
// never sees a raw socket error.
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "../../drivers/retry.ts";
import { liteSignature, LITE_APP_ID, LITE_CLIENT_VER, webSignature } from "./signer.ts";

/**
 * The browser-ish agent the public web endpoints expect. Kugou refuses a request
 * whose agent is not one of its own clients; this is the string KugouMusic.NET
 * sends from its desktop build.
 */
export const KUGOU_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** The largest body any endpoint here may return; a bigger one is an error, not a truncation. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type KugouErrorCode =
  | "not_logged_in"
  | "unsupported_format"
  | "risk_control"
  | "unreachable"
  | "expired_session"
  | "vip_required"
  | "not_found"
  | "empty_url"
  | "invalid_input"
  | "source_unavailable";

/** What a caller may do about it: retrying a refusal only digs deeper. */
export class KugouError extends Error {
  readonly code: KugouErrorCode;
  readonly retryable: boolean;
  constructor(code: KugouErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "KugouError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type SignatureKind = "lite" | "web" | "none";

export interface KugouRequest {
  url: string;
  method?: "GET" | "POST";
  /** Query parameters, already strings. Signed in ordinal order. */
  params?: Record<string, string>;
  /** The exact body sent; signed as-is for a POST. */
  body?: string;
  contentType?: string;
  /** Which signature the endpoint wants. `lite` is the default. */
  signature?: SignatureKind;
  /** Overrides the `x-router` header; most endpoints take it from the host. */
  router?: string;
  /** Extra headers, e.g. `KG-TID` or `support-calm`. */
  headers?: Record<string, string>;
  /** A caller's own timeout; the default suits a search or a page fetch. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface KugouTransportOptions {
  /** Swapped in tests to reach a local fake instead of kugou.com. */
  fetch?: typeof fetch;
  /** Base for every request; a test rewrites the origin, not the path. */
  rewrite?: (url: URL) => URL;
  now?: () => number;
  random?: () => number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

function hostOf(url: URL): string {
  return url.hostname;
}

/** A body read with a hard cap: a runaway response must not become memory. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new KugouError("source_unavailable", "Kugou returned more data than this server accepts", false);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/** Kugou answers 403/412 when it decides a client is not welcome; that is not a transient failure. */
function statusError(status: number, body: string): KugouError {
  if (status === 403 || status === 412) {
    return new KugouError("risk_control", "Kugou refused this request (region or rate limit); the public interface is not a contract and may be unavailable", false);
  }
  if (status === 401) {
    return new KugouError("expired_session", "the Kugou session has expired; sign in again", false);
  }
  if (status === 404) {
    return new KugouError("not_found", "Kugou has no such item", false);
  }
  if (status >= 500) {
    return new KugouError("source_unavailable", `Kugou returned ${status}`, true);
  }
  return new KugouError("source_unavailable", `Kugou returned ${status}${body ? `: ${body.slice(0, 200)}` : ""}`, status === 429);
}

export interface KugouTransport {
  /** One request, already retried per the shared rule. Resolves the parsed JSON. */
  request<T = unknown>(request: KugouRequest): Promise<T>;
  /** One request that returns bytes (a lyric payload, an audio preview). */
  bytes(request: KugouRequest): Promise<Uint8Array>;
}

export function createKugouTransport(options: KugouTransportOptions = {}): KugouTransport {
  const fetcher = options.fetch ?? fetch;

  const prepare = (request: KugouRequest): { url: URL; body: string; headers: Record<string, string> } => {
    const url = new URL(request.url);
    const params: Record<string, string> = request.params ? { ...request.params } : {};
    const body = request.body ?? "";
    const signature = request.signature ?? "lite";
    if (signature === "lite") params.signature = liteSignature(params, body);
    else if (signature === "web") params.signature = webSignature(params);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      "user-agent": KUGOU_USER_AGENT,
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      "x-router": request.router ?? hostOf(url),
      ...request.headers,
    };
    if (body) headers["content-type"] = request.contentType ?? "application/x-www-form-urlencoded";
    return { url: options.rewrite ? options.rewrite(url) : url, body, headers };
  };

  const attempt = async (request: KugouRequest): Promise<Response> => {
    const { url, body, headers } = prepare(request);
    const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    return fetcher(url, {
      method: request.method ?? (body ? "POST" : "GET"),
      headers,
      ...(body ? { body } : {}),
      redirect: "error",
      signal,
    });
  };

  /** Retries only what the shared classifier calls transient, and only while the caller is still interested. */
  const withRetry = async <T>(request: KugouRequest, run: () => Promise<T>): Promise<T> => {
    for (let tryIndex = 0; ; tryIndex++) {
      try {
        return await run();
      } catch (error) {
        if (request.signal?.aborted) throw new KugouError("unreachable", "the request was cancelled", false);
        const retryable = error instanceof KugouError
          ? error.retryable
          : classifyError(error as Error).transient;
        if (!retryable || tryIndex + 1 >= RETRY_MAX_ATTEMPTS) {
          if (error instanceof KugouError) throw error;
          const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
          throw new KugouError("unreachable", `Kugou is unreachable (${String(code ?? (error as Error)?.name ?? "unknown").slice(0, 60)})`, true);
        }
        const wait = interruptibleDelay(computeBackoff(tryIndex), request.signal);
        if (await wait.promise === "cancelled") throw new KugouError("unreachable", "the request was cancelled", false);
      }
    }
  };

  return {
    async request<T>(request: KugouRequest): Promise<T> {
      return withRetry(request, async () => {
        const response = await attempt(request);
        const text = await readCapped(response);
        if (!response.ok) throw statusError(response.status, text);
        if (!text.trim()) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new KugouError("source_unavailable", "Kugou returned something that is not JSON", false);
        }
      });
    },

    async bytes(request: KugouRequest): Promise<Uint8Array> {
      return withRetry(request, async () => {
        const response = await attempt(request);
        if (!response.ok) throw statusError(response.status, await readCapped(response).catch(() => ""));
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_BODY_BYTES) throw new KugouError("source_unavailable", "Kugou returned more data than this server accepts", false);
        return new Uint8Array(buffer);
      });
    },
  };
}

/** The query a Lite client attaches to almost everything: appid and client version. */
export function liteQuery(extra: Record<string, string> = {}): Record<string, string> {
  return { appid: LITE_APP_ID, clientver: LITE_CLIENT_VER, ...extra };
}

export { nowSeconds, clientTimeMs };

function nowSeconds(now: () => number = () => Date.now()): string {
  return String(Math.floor(now() / 1_000));
}

function clientTimeMs(now: () => number = () => Date.now()): string {
  return String(now());
}
