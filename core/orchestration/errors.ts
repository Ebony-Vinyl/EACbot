import { CommandError, type CommandErrorCode } from "../../packages/agent-protocol/commands.ts";
import { EnvironmentRefError, SecretFieldError } from "../../packages/agent-protocol/guards.ts";
import { IllegalTransitionError } from "../../packages/agent-protocol/mission-status.ts";
import { MissionNotFoundError, RevisionConflictError, RunNotFoundError } from "../missions/errors.ts";

/** Every failure a tool call can report. The list is closed: a caller can
 * switch on it, and a tool that cannot say what went wrong says `internal`. */
export const TOOL_ERROR_CODES = [
  "unauthenticated",
  "scope_denied",
  "read_only",
  "scope_from_arguments_refused",
  "secret_refused",
  "unknown_tool",
  "invalid_arguments",
  "unsupported",
  "not_found",
  "not_resumable",
  "revision_conflict",
  "illegal_transition",
  "capability_missing",
  "invalid_request",
  "command_conflict",
  "already_settled",
  "native_start_failed",
  "internal",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolErrorBody {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

const RETRYABLE: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>(["revision_conflict", "native_start_failed"]);

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ToolErrorCode, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details;
  }
}

/** A command-layer code that already names the same condition. */
function isCommandCode(code: string): code is ToolErrorCode {
  return (TOOL_ERROR_CODES as readonly string[]).includes(code);
}

export function toErrorBody(error: unknown): ToolErrorBody {
  if (error instanceof ToolError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  if (error instanceof CommandError) {
    const code: ToolErrorCode = isCommandCode(error.code) ? error.code : "internal";
    return {
      code,
      message: error.message,
      retryable: RETRYABLE.has(code),
      ...(error.currentRevision !== undefined ? { details: { currentRevision: error.currentRevision } } : {}),
    };
  }
  if (error instanceof MissionNotFoundError) {
    return { code: "not_found", message: error.message, retryable: false, details: { missionId: error.missionId } };
  }
  if (error instanceof RunNotFoundError) {
    return { code: "not_found", message: error.message, retryable: false, details: { runId: error.runId } };
  }
  if (error instanceof RevisionConflictError) {
    return {
      code: "revision_conflict",
      message: error.message,
      retryable: true,
      details: { target: error.target, expected: error.expected, actual: error.actual },
    };
  }
  if (error instanceof SecretFieldError) {
    return {
      code: "secret_refused",
      message: `the request carries secret-bearing fields: ${error.fields.join(", ")}`,
      retryable: false,
      details: { fields: [...error.fields] },
    };
  }
  if (error instanceof EnvironmentRefError) {
    return { code: "invalid_arguments", message: error.message, retryable: false };
  }
  if (error instanceof IllegalTransitionError) {
    return {
      code: "illegal_transition",
      message: error.message,
      retryable: false,
      details: { from: error.from, to: error.to },
    };
  }
  return { code: "internal", message: "the tool failed unexpectedly", retryable: false };
}

/** Command codes re-exported so a caller mapping its own errors does not import
 * two vocabularies. */
export type { CommandErrorCode };
