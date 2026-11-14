/** A capability the engine does not have. Thrown, never worked around: the caller sees which
 * capability and which engine, and the UI can say "this engine cannot steer" honestly. */
export class UnsupportedCapabilityError extends Error {
  readonly agentId: string;
  readonly capability: string;

  constructor(agentId: string, capability: string, detail?: string) {
    super(`${agentId} does not support ${capability}${detail ? `: ${detail}` : ""}`);
    this.name = "UnsupportedCapabilityError";
    this.agentId = agentId;
    this.capability = capability;
  }
}

/** A transport-level failure: the process died, a frame was malformed, an HTTP call failed. */
export class AgentTransportError extends Error {
  readonly agentId: string;
  readonly detail?: string;

  constructor(agentId: string, message: string, detail?: string, options?: { cause?: unknown }) {
    super(`${agentId}: ${message}`, options);
    this.name = "AgentTransportError";
    this.agentId = agentId;
    this.detail = detail;
  }
}

/** A JSON-RPC error frame from the engine, kept distinct from a transport failure so a refusal
 * can be told from an indeterminate delivery. */
export class AgentRpcError extends Error {
  readonly code: number;
  readonly method: string;

  constructor(method: string, code: number, message: string) {
    super(`${method} failed (${code}): ${message}`);
    this.name = "AgentRpcError";
    this.method = method;
    this.code = code;
  }
}

/** An HTTP refusal from an engine, with the status and the engine's own error code kept apart
 * from a transport failure. A 409 is a decision by the engine, not a flaky connection. */
export class AgentHttpError extends Error {
  readonly agentId: string;
  readonly status: number;
  /** The engine's own error code (`run_not_accepting_steer`, `idempotency_key_conflict`, …). */
  readonly code: string | null;
  readonly body: string;

  constructor(agentId: string, method: string, path: string, status: number, code: string | null, body: string) {
    super(`${agentId}: ${method} ${path} answered ${status}${code ? ` (${code})` : ""}`);
    this.name = "AgentHttpError";
    this.agentId = agentId;
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** A refusal the engine made on purpose, which a caller may act on rather than retry. */
  get isRefusal(): boolean {
    return this.status === 409 || this.status === 400 || this.status === 422;
  }
}

export function unsupported(agentId: string, capability: string, detail?: string): never {
  throw new UnsupportedCapabilityError(agentId, capability, detail);
}
