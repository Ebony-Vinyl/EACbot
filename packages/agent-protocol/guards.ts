/** Runtime guards and compile-time proofs for the mission boundary. */
import type { AdapterEvent, AdapterEventType } from "./events.ts";
import { ADAPTER_EVENT_TYPES } from "./events.ts";
import type { EnvironmentRef } from "./environment.ts";
import { SECRET_FIELD_NAMES } from "./environment.ts";
import type { TerminalStatusSignal } from "./terminal.ts";
import { PROTOCOL_VERSION } from "./version.ts";

/** `true` only when `A` is assignable to `B`. */
export type Assignable<A, B> = [A] extends [B] ? true : false;

/** Fails to compile unless `T` is `false`. */
export type ExpectFalse<T extends false> = T;

/** A terminal's own status is not an adapter event, so no handler that takes
 * an `AdapterEvent` can be handed one. */
export type TerminalStatusIsNotAnAdapterEvent = ExpectFalse<Assignable<TerminalStatusSignal, AdapterEvent>>;

/** Nor is a bare string type that merely happens to share a name. */
export type AdapterEventNeedsItsEnvelope = ExpectFalse<Assignable<{ type: "run.completed" }, AdapterEvent>>;

export function isAdapterEventType(value: unknown): value is AdapterEventType {
  return typeof value === "string" && (ADAPTER_EVENT_TYPES as readonly string[]).includes(value);
}

const EVENT_ID = /^[A-Za-z0-9._:-]{1,200}$/u;

export function isAdapterEvent(value: unknown): value is AdapterEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.source !== "adapter") return false;
  if (!isAdapterEventType(candidate.type)) return false;
  if (typeof candidate.eventId !== "string" || !EVENT_ID.test(candidate.eventId)) return false;
  if (typeof candidate.seq !== "number" || !Number.isSafeInteger(candidate.seq) || candidate.seq < 1) return false;
  if (typeof candidate.missionId !== "string" || candidate.missionId.length === 0) return false;
  if (typeof candidate.runId !== "string" || candidate.runId.length === 0) return false;
  if (typeof candidate.at !== "string" || Number.isNaN(Date.parse(candidate.at))) return false;
  return true;
}

export class AdapterEventShapeError extends Error {
  constructor(reason: string) {
    super(`not an adapter event: ${reason}`);
    this.name = "AdapterEventShapeError";
  }
}

export function assertAdapterEvent(value: unknown): asserts value is AdapterEvent {
  if (typeof value !== "object" || value === null) throw new AdapterEventShapeError("not an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.source !== "adapter") throw new AdapterEventShapeError("source must be adapter");
  if (!isAdapterEventType(candidate.type)) throw new AdapterEventShapeError("unknown type");
  if (typeof candidate.seq !== "number" || !Number.isSafeInteger(candidate.seq) || candidate.seq < 1) {
    throw new AdapterEventShapeError("seq must be a positive integer");
  }
  if (typeof candidate.missionId !== "string" || candidate.missionId.length === 0) {
    throw new AdapterEventShapeError("missionId is required");
  }
  if (typeof candidate.runId !== "string" || candidate.runId.length === 0) {
    throw new AdapterEventShapeError("runId is required");
  }
  if (typeof candidate.eventId !== "string" || !EVENT_ID.test(candidate.eventId)) {
    throw new AdapterEventShapeError("eventId is required");
  }
  if (typeof candidate.at !== "string" || Number.isNaN(Date.parse(candidate.at))) {
    throw new AdapterEventShapeError("at must be an ISO timestamp");
  }
}

export function isTerminalStatusSignal(value: unknown): value is TerminalStatusSignal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "terminal.status" && typeof candidate.terminalId === "string";
}

export class SecretFieldError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`secret-bearing fields are not allowed: ${fields.join(", ")}`);
    this.name = "SecretFieldError";
    this.fields = fields;
  }
}

export function findSecretFields(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findSecretFields(entry, `${path}[${index}]`));
  }
  const found: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if ((SECRET_FIELD_NAMES as readonly string[]).includes(key)) found.push(here);
    found.push(...findSecretFields(nested, here));
  }
  return found;
}

export function assertNoSecretFields(value: unknown): void {
  const found = findSecretFields(value);
  if (found.length > 0) throw new SecretFieldError(found);
}

export class EnvironmentRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentRefError";
  }
}

/** An environment reference may name where a credential lives, never the
 * credential. Enforced on the way into the store, not only in the type. */
export function assertEnvironmentRef(ref: EnvironmentRef): void {
  assertNoSecretFields(ref);
  if (ref.authMode === "apiKey" && !ref.credentialRef) {
    throw new EnvironmentRefError("an apiKey environment must name a credentialRef");
  }
}

export function assertProtocolVersion(value: unknown): asserts value is typeof PROTOCOL_VERSION {
  if (value !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${String(value)}; expected ${PROTOCOL_VERSION}`);
  }
}
