/** Mission statuses and the only legal transitions between them.
 *
 * `succeeded`, `failed` and `cancelled` are terminal: no later event changes
 * them, and `interrupt` never produces one. */

export const MISSION_STATUSES = [
  "queued",
  "provisioning",
  "running",
  "waiting_input",
  "waiting_children",
  "interrupted",
  "resuming",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const TERMINAL_MISSION_STATUSES = ["succeeded", "failed", "cancelled"] as const;

export type TerminalMissionStatus = (typeof TERMINAL_MISSION_STATUSES)[number];

const TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  queued: ["provisioning", "running", "failed", "cancelled"],
  provisioning: ["running", "failed", "cancelled", "interrupted"],
  running: ["waiting_input", "waiting_children", "interrupted", "succeeded", "failed", "cancelled"],
  waiting_input: ["running", "waiting_children", "interrupted", "succeeded", "failed", "cancelled"],
  waiting_children: ["running", "waiting_input", "interrupted", "succeeded", "failed", "cancelled"],
  interrupted: ["resuming", "failed", "cancelled"],
  resuming: ["running", "waiting_input", "waiting_children", "interrupted", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isMissionStatus(value: unknown): value is MissionStatus {
  return typeof value === "string" && (MISSION_STATUSES as readonly string[]).includes(value);
}

export function isTerminalMissionStatus(value: MissionStatus): value is TerminalMissionStatus {
  return (TERMINAL_MISSION_STATUSES as readonly MissionStatus[]).includes(value);
}

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}

export function legalTargets(from: MissionStatus): readonly MissionStatus[] {
  return TRANSITIONS[from];
}

export class IllegalTransitionError extends Error {
  readonly from: MissionStatus;
  readonly to: MissionStatus;

  constructor(from: MissionStatus, to: MissionStatus) {
    super(`mission cannot move from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
