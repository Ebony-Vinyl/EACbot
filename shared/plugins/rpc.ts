import { z } from "zod";

const requestId = z.string().min(1).max(120);
const id = z.string().min(1).max(200);
const timestamp = z.string().datetime({ offset: true });

export const capabilityCallSchema = z.object({
  requestId,
  traceId: id,
  capability: z.string().min(1).max(120),
  version: z.string().min(1).max(120),
  arguments: z.unknown(),
  context: z.object({
    workspaceId: id,
    installationId: id,
    botId: id.optional(),
    accountId: id.optional(),
    taskId: id.optional(),
    deviceId: id.optional(),
    principalRef: id,
    audienceRef: id,
    grantRef: id,
    authorizationEpoch: z.number().int().min(0),
  }).strict(),
  deadline: timestamp,
  idempotencyKey: z.string().min(1).max(200).optional(),
}).strict();

export type CapabilityCall = z.infer<typeof capabilityCallSchema>;

export const actionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), value: z.unknown(), receiptId: id.optional() }).strict(),
  z.object({ status: z.literal("failed"), code: z.string().min(1).max(120), message: z.string().min(1).max(2_000), retryable: z.boolean() }).strict(),
  z.object({ status: z.literal("cancelled"), reason: z.string().min(1).max(500) }).strict(),
  z.object({
    status: z.literal("indeterminate"),
    operationId: id,
    verification: z.enum(["pending", "unavailable"]),
  }).strict(),
]);

export type ActionResult = z.infer<typeof actionResultSchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; issues: string[] };

function parse<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`);
  return { ok: false, error: issues[0] ?? "invalid payload", issues };
}

export function parseCapabilityCall(input: unknown): ParseResult<CapabilityCall> {
  return parse(capabilityCallSchema, input);
}

export function parseActionResult(input: unknown): ParseResult<ActionResult> {
  return parse(actionResultSchema, input);
}
