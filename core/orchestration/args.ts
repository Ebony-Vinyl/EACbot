import { ToolError } from "./errors.ts";

/** A caller's arguments. Every tool reads its input through these helpers so an
 * unexpected field or type is refused before any state is touched. */
export interface ToolArguments {
  readonly raw: Record<string, unknown>;
}

export function readArguments(value: unknown): ToolArguments {
  if (value === undefined) return { raw: {} };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_arguments", "arguments must be an object");
  }
  return { raw: value as Record<string, unknown> };
}

/** Rejects a field the tool does not declare, so a caller cannot smuggle an
 * unknown knob past the schema. */
export function rejectUnknownKeys(args: ToolArguments, allowed: readonly string[]): void {
  for (const key of Object.keys(args.raw)) {
    if (!allowed.includes(key)) {
      throw new ToolError("invalid_arguments", `unknown argument "${key}"`, { details: { argument: key } });
    }
  }
}

export function requireString(args: ToolArguments, key: string, max = 200): string {
  const value = args.raw[key];
  if (typeof value !== "string") throw new ToolError("invalid_arguments", `${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ToolError("invalid_arguments", `${key} must not be empty`);
  if (trimmed.length > max) throw new ToolError("invalid_arguments", `${key} is longer than ${max} characters`);
  return trimmed;
}

export function optionalString(args: ToolArguments, key: string, max = 200): string | undefined {
  if (args.raw[key] === undefined) return undefined;
  return requireString(args, key, max);
}

export function requireInteger(args: ToolArguments, key: string, min: number, max: number): number {
  const value = args.raw[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ToolError("invalid_arguments", `${key} must be an integer`);
  }
  if (value < min || value > max) throw new ToolError("invalid_arguments", `${key} must be between ${min} and ${max}`);
  return value;
}

export function optionalInteger(args: ToolArguments, key: string, min: number, max: number): number | undefined {
  if (args.raw[key] === undefined) return undefined;
  return requireInteger(args, key, min, max);
}

export function optionalBoolean(args: ToolArguments, key: string): boolean | undefined {
  const value = args.raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ToolError("invalid_arguments", `${key} must be a boolean`);
  return value;
}

export function optionalObject(args: ToolArguments, key: string): Record<string, unknown> | undefined {
  const value = args.raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_arguments", `${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireObject(args: ToolArguments, key: string): Record<string, unknown> {
  const value = optionalObject(args, key);
  if (value === undefined) throw new ToolError("invalid_arguments", `${key} is required`);
  return value;
}

export function optionalStringArray(
  args: ToolArguments,
  key: string,
  allowed: readonly string[],
  max = 200,
): string[] | undefined {
  const value = args.raw[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ToolError("invalid_arguments", `${key} must be an array`);
  if (value.length > max) throw new ToolError("invalid_arguments", `${key} holds at most ${max} entries`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new ToolError("invalid_arguments", `${key}[${index}] must be a string`);
    if (!allowed.includes(entry)) {
      throw new ToolError("invalid_arguments", `${key}[${index}] must be one of ${allowed.join(", ")}`);
    }
    return entry;
  });
}

export function requireEnum<T extends string>(args: ToolArguments, key: string, allowed: readonly T[]): T {
  const value = args.raw[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ToolError("invalid_arguments", `${key} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
