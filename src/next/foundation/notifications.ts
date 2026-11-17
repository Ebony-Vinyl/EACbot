/** The notification the core's event hub publishes, mirrored from
 * `core/events/hub.ts`. It is deliberately thin: a client learns *that*
 * something moved and which mission moved, then reads the authoritative
 * snapshot over REST. Nothing here is task state. */

export const NOTIFICATION_KINDS = [
  "mission.updated",
  "run.updated",
  "approval.updated",
  "artifact.added",
  "environment.updated",
  "terminal.updated",
  "server.shutdown",
  "stream.resync",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface Notification {
  readonly cursor: number;
  readonly kind: NotificationKind;
  readonly at: string;
  readonly missionId?: string;
  readonly runId?: string;
  readonly revision?: number;
  readonly reason?: string;
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

export function isNotification(value: unknown): value is Notification {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.cursor !== "number" || !Number.isSafeInteger(candidate.cursor) || candidate.cursor < 0) return false;
  if (!isNotificationKind(candidate.kind)) return false;
  if (typeof candidate.at !== "string" || Number.isNaN(Date.parse(candidate.at))) return false;
  return true;
}
