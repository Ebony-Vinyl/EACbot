import type { AgentKind } from "./agents.ts";

export const RUN_STATUSES = [
  "accepted",
  "running",
  "waiting_input",
  "interrupted",
  "resuming",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** How the native agent finished a run, as reported by the adapter. Kept
 * separate from acceptance: a run can be accepted and never start. */
export type NativeOutcome = "succeeded" | "failed" | "cancelled";

/** One native execution attempt for a mission. `interrupt` ends the attempt
 * but keeps `nativeSessionId` resumable; `cancel` ends it for good. */
export interface Run {
  readonly protocolVersion: 1;
  readonly id: string;
  readonly missionId: string;
  readonly attempt: number;
  readonly agent: AgentKind;
  readonly acceptedAt: string;
  readonly acceptedCommandId: string;
  readonly nativeSessionId?: string;
  readonly nativeStartedAt?: string;
  readonly nativeCompletedAt?: string;
  readonly nativeOutcome?: NativeOutcome;
  readonly status: RunStatus;
  readonly revision: number;
  readonly resumeOfRunId?: string;
  readonly interruptedAt?: string;
  readonly resumedAt?: string;
  readonly lastAdapterSeq: number;
  readonly error?: { readonly code: string; readonly message: string };
  /** A control action the authority already recorded durably but whose native
   * effect it has not confirmed. A process that dies with this set leaves a
   * native session possibly still alive; `recover` reports it instead of
   * pretending the run is gone. */
  readonly controlPending?: PendingControl;
  readonly cancelAcceptedAt?: string;
  /** Set when a restart found work that must be reconciled by an explicit
   * command rather than replayed on its own. */
  readonly reconcileRequiredAt?: string;
}

export const PENDING_CONTROLS = ["cancel", "interrupt"] as const;

export type PendingControl = (typeof PENDING_CONTROLS)[number];

/** What a caller may do with a run a restart left in limbo. `start` launches a
 * run that was accepted but never started; `cancel` retries a cancellation
 * whose native effect was never confirmed; `abandon` settles it as failed so
 * nothing is silently replayed. */
export const RECONCILE_ACTIONS = ["start", "resume", "cancel", "abandon"] as const;

export type ReconcileAction = (typeof RECONCILE_ACTIONS)[number];

/** What the authority knows about a run before and after the native agent
 * reports anything. */
export interface RunAcceptance {
  readonly accepted: true;
  readonly acceptedAt: string;
  readonly nativeStarted: boolean;
  readonly nativeCompleted: boolean;
}

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  accepted: ["running", "interrupted", "failed", "cancelled"],
  running: ["waiting_input", "interrupted", "completed", "failed", "cancelled"],
  waiting_input: ["running", "interrupted", "completed", "failed", "cancelled"],
  interrupted: ["resuming", "failed", "cancelled"],
  resuming: ["running", "waiting_input", "interrupted", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return false;
  return RUN_TRANSITIONS[from].includes(to);
}
