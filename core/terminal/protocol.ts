/**
 * JSON-RPC 2.0 envelopes for herdr-core, with the core's stable error kinds.
 *
 * Errors carry `data.kind` and `data.hint`; the kind is what callers branch on
 * (herdr-core 0.1.21, `crates/herdr-core/src/rpc.rs`).
 */

export const PROTOCOL_GENERATION = 1;

export const RpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
} as const;

export type RpcErrorKind =
  | "parse_error"
  | "invalid_request"
  | "unknown_method"
  | "invalid_params"
  | "internal"
  | "unsupported_generation"
  | "not_found"
  | "machine_unknown"
  | "name_taken"
  | "spawn_failed"
  | "unavailable"
  | "invalid_template"
  | "config"
  | "finished"
  | "needs_framed"
  | "blocked"
  | "status_mismatch"
  | "cancelled"
  | "live"
  | "needs_login"
  | "needs_target"
  | "needs_update"
  | "not_text"
  | "io"
  | "edit_failed"
  | "conflict"
  | "usage";

export interface RpcErrorData {
  readonly kind?: RpcErrorKind | string;
  readonly hint?: string;
}

export class RpcError extends Error {
  readonly code: number;
  readonly kind: string;
  readonly hint: string;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    const parsed = (data ?? {}) as RpcErrorData;
    this.kind = typeof parsed.kind === "string" ? parsed.kind : "internal";
    this.hint = typeof parsed.hint === "string" ? parsed.hint : "";
    this.data = data;
  }
}

export class TransportError extends Error {
  readonly code = "transport";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransportError";
  }
}

export function isRpcErrorKind(error: unknown, ...kinds: string[]): boolean {
  return error instanceof RpcError && kinds.includes(error.kind);
}

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  return "id" in record && ("result" in record || "error" in record) && !("method" in record);
}

export function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  return typeof record.method === "string" && !("id" in record);
}

export function rpcErrorFrom(failure: JsonRpcFailure): RpcError {
  const code = typeof failure.error.code === "number" ? failure.error.code : RpcErrorCode.INTERNAL_ERROR;
  const message = typeof failure.error.message === "string" ? failure.error.message : "the core reported an error";
  return new RpcError(code, message, failure.error.data);
}

export function parseMessage(raw: string | Uint8Array): unknown {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/**
 * Splits plain-mode bytes into JSON lines. One message per line, and a read
 * never respects a line boundary.
 */
export class LineDecoder {
  #buffer = "";

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];
    let at = this.#buffer.indexOf("\n");
    while (at !== -1) {
      const line = this.#buffer.slice(0, at).trim();
      this.#buffer = this.#buffer.slice(at + 1);
      if (line !== "") lines.push(line);
      at = this.#buffer.indexOf("\n");
    }
    return lines;
  }

  /** A last message the core wrote without its newline. */
  flush(): string[] {
    const line = this.#buffer.trim();
    this.#buffer = "";
    return line === "" ? [] : [line];
  }

  reset(): void {
    this.#buffer = "";
  }
}
