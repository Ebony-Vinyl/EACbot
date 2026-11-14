/** Hermes' OpenAI-compatible API server, Runs surface, as documented at
 * https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server (read 2026-11-15).
 *
 * A run id is the engine's own and is never the conversation id. `session_id` in the create body
 * is how the caller asks Hermes to continue a transcript, and Hermes echoes it back on the run
 * status; that echoed value is the only accepted source of the native session id. */

export const HERMES_RUN_STATUSES = [
  "started", "running", "stopping", "completed", "failed", "cancelled", "interrupted", "unknown",
] as const;

export type HermesRunStatus = (typeof HERMES_RUN_STATUSES)[number];

/** `unknown` is documented as explicitly NOT terminal: the run waits for resolve-unknown. */
export function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

/** `POST /v1/runs` body. `input` is the prompt; `session_id` continues a transcript this API
 * server owns. A session another surface owns is refused with 409 permission_denied. */
export function createRunBody(input: {
  prompt: string;
  sessionId: string;
  model?: { providerId: string; modelId: string };
  system?: string;
}): Record<string, unknown> {
  return {
    input: input.prompt,
    session_id: input.sessionId,
    ...(input.model ? { model: input.model.modelId, provider: input.model.providerId } : {}),
    ...(input.system ? { instructions: input.system } : {}),
  };
}

/** `Idempotency-Key`: 1–255 visible ASCII characters. An identical retry returns the original
 * run id with HTTP 202 and `Idempotency-Replayed: true`; a different payload under the same key
 * is 409 `idempotency_key_conflict`. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

export function validIdempotencyKey(key: string): boolean {
  return key.length >= 1 && key.length <= 255 && /^[\x21-\x7e]+$/.test(key);
}

/** `POST /v1/runs/{id}/steer`. A 200 means the text was queued for the agent's next tool
 * boundary, not that it was folded into the running step. A run that is not `running` answers
 * 409 `run_not_accepting_steer`. */
export function steerBody(text: string): Record<string, unknown> {
  return { input: text };
}

/** `POST /v1/runs/{id}/approval`: `choice` is `once` or `deny`, and the identity must be exact —
 * an identityless or bulk response is refused, and stale generations are 409. */
export function approvalBody(input: {
  requestId: string;
  executionGeneration?: number;
  allow: boolean;
}): Record<string, unknown> {
  return {
    request_id: input.requestId,
    ...(input.executionGeneration === undefined ? {} : { execution_generation: input.executionGeneration }),
    choice: input.allow ? "once" : "deny",
  };
}

/** `POST /v1/runs/{id}/clarify`: the same identity plus `answer`, a string. Answering resolves
 * the waiting tool; it does not submit another inference turn. */
export function clarifyBody(input: {
  requestId: string;
  executionGeneration?: number;
  answer: string;
}): Record<string, unknown> {
  return {
    request_id: input.requestId,
    ...(input.executionGeneration === undefined ? {} : { execution_generation: input.executionGeneration }),
    answer: input.answer,
  };
}

export interface HermesRunStatusBody {
  object?: string;
  run_id?: string;
  status?: string;
  session_id?: string;
  output?: string;
  pending_steer?: string;
  error?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  /** Present on canonical runs: the identity an approval or clarify answer must name. */
  pending_controls?: { prompt_id?: string; execution_generation?: number } | null;
  execution_generation?: number;
  admission_id?: string;
}

/** The native session id Hermes reports for a run. Never the caller's own id, and never guessed
 * from the request: only the value the server echoes back is accepted. */
export function nativeSessionIdOf(body: HermesRunStatusBody | null): string | null {
  const value = body?.session_id;
  return typeof value === "string" && value ? value : null;
}

/** Terminal event names match the status exactly, which is how a stream's end is recognised. */
export function terminalEventStatus(event: string): HermesRunStatus | null {
  if (event === "run.completed") return "completed";
  if (event === "run.failed") return "failed";
  if (event === "run.cancelled") return "cancelled";
  if (event === "run.interrupted") return "interrupted";
  return null;
}

export function runUsage(body: HermesRunStatusBody | null): { input: number; output: number; cachedInput?: number } | null {
  const usage = body?.usage;
  if (!usage) return null;
  const cached = usage.cache_read_tokens;
  return {
    input: (usage.input_tokens ?? 0) + (cached ?? 0),
    output: usage.output_tokens ?? 0,
    ...(cached === undefined ? {} : { cachedInput: cached }),
  };
}

/** A delta event's text. Hermes streams `message.delta`; the text field name is not pinned by the
 * docs, so the first non-empty string wins rather than assuming one. */
export function deltaText(payload: Record<string, unknown>): string | null {
  for (const key of ["text", "delta", "content", "chunk"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** `/v1/capabilities` advertises the stable surface; only the documented flags are read. A
 * missing document means an older server, whose Runs surface still works but whose optional
 * controls must not be assumed. */
export interface HermesFeatures {
  runs: boolean;
  /** `run_approval`: the approval endpoint exists. */
  approval: boolean;
  /** `run_unknown_resolution`: resolve-unknown exists. */
  unknownResolution: boolean;
  /** No documented flag names clarify; it is offered only when approval is, because the docs
   * describe them as the same canonical control surface. */
  clarify: boolean;
}

export function hermesFeatures(body: unknown): HermesFeatures {
  const features = (body as { features?: Record<string, unknown> } | null)?.features;
  const on = (name: string) => features?.[name] === true;
  const runs = on("run_submission");
  const approval = on("run_approval");
  return {
    runs,
    approval,
    unknownResolution: on("run_unknown_resolution"),
    clarify: approval,
  };
}

/** A typed refusal from the Runs surface, so a caller can tell a 409 identity/ownership refusal
 * from a transient transport failure. */
export interface HermesErrorBody {
  error?: string;
  code?: string;
  message?: string;
}

export function hermesErrorCode(body: unknown): string | null {
  const value = body as HermesErrorBody | null;
  const code = value?.code ?? value?.error;
  return typeof code === "string" && code ? code : null;
}
