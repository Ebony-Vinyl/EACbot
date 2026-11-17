import { randomUUID } from "node:crypto";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;

/** Echoes a caller's `x-request-id` when it is a plain token, otherwise mints
 * one. An echoed id appears in logs and error envelopes, so anything that could
 * break a log line or smuggle control characters is replaced. */
export function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== undefined && SAFE_REQUEST_ID.test(value)) return value;
  return randomUUID();
}
