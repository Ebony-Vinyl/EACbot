import type { IncomingMessage } from "node:http";

import { ApiError } from "./errors.ts";

/** A JSON body is a command or a small descriptor. 64 KiB is generous for
 * both and small enough that a hostile body cannot exhaust memory before the
 * limit is reached. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface BodyLimits {
  readonly maxBytes?: number;
}

const JSON_CONTENT_TYPE = /^application\/json(?:;\s*charset=utf-8)?$/iu;

/** Reads a request body, refusing anything but a bounded JSON document.
 *
 * `content-type` is checked before a byte is read: a form-encoded body from a
 * cross-site page is refused even when the body itself would parse. */
export async function readJsonBody(req: IncomingMessage, limits: BodyLimits = {}): Promise<unknown> {
  const maxBytes = limits.maxBytes ?? MAX_BODY_BYTES;
  const declared = req.headers["content-type"];
  if (declared === undefined || !JSON_CONTENT_TYPE.test(declared.trim())) {
    throw new ApiError("unsupported_media_type", "content-type must be application/json", 415);
  }
  const declaredLength = req.headers["content-length"];
  if (declaredLength !== undefined) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ApiError("invalid_request", "content-length is not a valid length", 400);
    }
    if (length > maxBytes) throw tooLarge(maxBytes);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw tooLarge(maxBytes);
    }
    chunks.push(buffer);
  }
  if (total === 0) throw new ApiError("invalid_request", "a JSON body is required", 400);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("invalid_json", "the body is not valid JSON", 400);
  }
}

function tooLarge(maxBytes: number): ApiError {
  return new ApiError("payload_too_large", `the body exceeds ${maxBytes} bytes`, 413, { maxBytes });
}
