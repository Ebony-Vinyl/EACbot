import { ApiError } from "./errors.ts";

/** Reads a field a route requires. Each helper names the field in the refusal,
 * so a client gets "missionId is required" instead of "invalid request". */
export function requireObject(value: unknown, what = "body"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError("invalid_request", `${what} must be a JSON object`, 400);
  }
  return value as Record<string, unknown>;
}

export function requireString(source: Record<string, unknown>, field: string, options: { maxLength?: number; minLength?: number } = {}): string {
  const value = source[field];
  if (typeof value !== "string") throw new ApiError("invalid_request", `${field} must be a string`, 400);
  const min = options.minLength ?? 1;
  if (value.length < min) throw new ApiError("invalid_request", `${field} must not be empty`, 400);
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new ApiError("invalid_request", `${field} exceeds ${options.maxLength} characters`, 400);
  }
  return value;
}

export function optionalString(source: Record<string, unknown>, field: string, options: { maxLength?: number } = {}): string | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ApiError("invalid_request", `${field} must be a string`, 400);
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new ApiError("invalid_request", `${field} exceeds ${options.maxLength} characters`, 400);
  }
  return value;
}

export function requireInteger(source: Record<string, unknown>, field: string, options: { min?: number } = {}): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ApiError("invalid_request", `${field} must be an integer`, 400);
  }
  const min = options.min ?? 0;
  if (value < min) throw new ApiError("invalid_request", `${field} must be at least ${min}`, 400);
  return value;
}

export function optionalInteger(source: Record<string, unknown>, field: string): number | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ApiError("invalid_request", `${field} must be an integer`, 400);
  }
  return value;
}

export function optionalBoolean(source: Record<string, unknown>, field: string): boolean | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ApiError("invalid_request", `${field} must be a boolean`, 400);
  return value;
}

export function requireOneOf<T extends string>(source: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const value = source[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ApiError("invalid_request", `${field} must be one of ${allowed.join(", ")}`, 400);
  }
  return value as T;
}

/** Rejects any field the route does not read. A client that sends a secret in
 * a field the server ignores still must not believe it was accepted. */
export function rejectUnknownFields(source: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ApiError("invalid_request", `unknown field: ${unknown.join(", ")}`, 400, { fields: unknown });
  }
}
