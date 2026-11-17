import { CommandError } from "../../packages/agent-protocol/commands.ts";
import { IdentityError } from "../identity/errors.ts";
import { MissionNotFoundError, RevisionConflictError, RunNotFoundError } from "../missions/errors.ts";

/** The wire error envelope. Every failure, including a 404 and a body that was
 * too large, uses this shape so a client has one parser. */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

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

export function notFound(message = "no such resource"): ApiError {
  return new ApiError("not_found", message, 404);
}

export function notImplemented(message: string): ApiError {
  return new ApiError("not_implemented", message, 501);
}

export interface MappedError {
  readonly status: number;
  readonly envelope: ErrorEnvelope;
  /** Whether the failure is the server's fault, so its stack is worth logging
   * and its message is worth hiding from the response. */
  readonly internal: boolean;
}

const IDENTITY_STATUS: Readonly<Record<string, number>> = {
  unauthenticated: 401,
  forbidden: 403,
  pairing_unknown: 401,
  pairing_expired: 401,
  pairing_consumed: 401,
  pairing_exhausted: 429,
  session_expired: 401,
  session_revoked: 401,
  ticket_invalid: 401,
  ticket_expired: 401,
  ticket_used: 401,
  ticket_purpose_mismatch: 403,
};

/** Turns anything thrown by a route into the envelope. Unknown errors keep
 * their message out of the response: it may name a path, a query or a token. */
export function mapError(error: unknown, requestId: string): MappedError {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      envelope: envelope(error.code, error.message, { ...error.details, requestId }),
      internal: error.status >= 500,
    };
  }
  if (error instanceof CommandError) {
    return {
      status: error.status,
      envelope: envelope(error.code, error.message, {
        ...(error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}),
        requestId,
      }),
      internal: error.status >= 500,
    };
  }
  if (error instanceof IdentityError) {
    const status = IDENTITY_STATUS[error.code] ?? 401;
    return { status, envelope: envelope(error.code, error.message, { requestId }), internal: false };
  }
  if (error instanceof MissionNotFoundError) {
    return { status: 404, envelope: envelope("not_found", error.message, { missionId: error.missionId, requestId }), internal: false };
  }
  if (error instanceof RunNotFoundError) {
    return { status: 404, envelope: envelope("not_found", error.message, { runId: error.runId, requestId }), internal: false };
  }
  if (error instanceof RevisionConflictError) {
    return {
      status: 409,
      envelope: envelope("revision_conflict", error.message, {
        expected: error.expected,
        actual: error.actual,
        requestId,
      }),
      internal: false,
    };
  }
  return {
    status: 500,
    envelope: envelope("internal_error", "the server could not complete this request", { requestId }),
    internal: true,
  };
}

export function envelope(code: string, message: string, details?: Readonly<Record<string, unknown>>): ErrorEnvelope {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}
