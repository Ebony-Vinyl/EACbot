import { z } from "zod";

const id = z.string().min(1).max(200);

export const domainEventSchema = z.object({
  eventId: id,
  schemaVersion: z.number().int().min(1).max(1_000),
  type: z.string().min(1).max(120).regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){1,4}$/),
  occurredAt: z.string().datetime({ offset: true }),
  producerInstallationId: id,
  workspaceId: id,
  botId: id.optional(),
  accountId: id.optional(),
  deviceId: id.optional(),
  taskId: id.optional(),
  traceId: id,
  causationId: id.optional(),
  streamId: id,
  sequence: z.number().int().min(0),
  payloadRef: z.string().min(1).max(500),
}).strict();

export type DomainEvent = z.infer<typeof domainEventSchema>;

export type DomainEventResult =
  | { ok: true; event: DomainEvent }
  | { ok: false; error: string; issues: string[] };

export function parseDomainEvent(input: unknown): DomainEventResult {
  const parsed = domainEventSchema.safeParse(input);
  if (parsed.success) return { ok: true, event: parsed.data };
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "event"}: ${issue.message}`);
  return { ok: false, error: issues[0] ?? "invalid domain event", issues };
}
