import type { IncomingMessage, ServerResponse } from "node:http";

export interface SecurityHeadersOptions {
  /** When false, a request carrying a cross-origin `Origin` is refused instead
   * of being granted CORS headers. Off by default: a local server that answers
   * any web page is a local server any web page can drive. */
  readonly cors: boolean;
  readonly allowedOrigins: readonly string[];
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "x-permitted-cross-domain-policies": "none",
  "cache-control": "no-store",
  pragma: "no-cache",
};

/** Applies the headers every response carries, including error responses.
 * `cache-control: no-store` is deliberate: a snapshot or a ticket must never be
 * written to a shared cache or replayed from browser history. */
export function applySecurityHeaders(res: ServerResponse, options?: SecurityHeadersOptions, origin?: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (options?.cors && origin !== undefined && options.allowedOrigins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-expose-headers", "x-request-id");
    res.setHeader("vary", "origin");
  }
}

export interface SendOptions {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export function sendJson(res: ServerResponse, options: SendOptions): void {
  if (res.headersSent) return;
  if (options.body === undefined) {
    res.writeHead(options.status, { ...options.headers });
    res.end();
    return;
  }
  const payload = JSON.stringify(options.body);
  res.writeHead(options.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
    ...options.headers,
  });
  res.end(payload);
}

export function requestPath(req: IncomingMessage): string {
  const raw = req.url ?? "/";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

const REASONS: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  503: "Service Unavailable",
};

export function reasonPhrase(status: number): string {
  return REASONS[status] ?? "Error";
}
