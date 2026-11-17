/** Structured events an adapter reports about a run, and the append-only
 * mission log that records them.
 *
 * Only `AdapterEvent` values move a mission. Terminal status (OSC 7501,
 * process exit) arrives as `TerminalStatusSignal`, whose brand no mission
 * event union accepts. */

export const ADAPTER_EVENT_TYPES = [
  "run.started",
  "run.output",
  "run.tool_call",
  "run.tool_result",
  "run.approval_requested",
  "run.approval_resolved",
  "run.waiting_input",
  "run.input_received",
  "run.steer_acknowledged",
  "run.interrupted",
  "run.resumed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.artifact",
  "run.usage",
  "run.child_spawned",
  "run.child_settled",
] as const;

export type AdapterEventType = (typeof ADAPTER_EVENT_TYPES)[number];

interface AdapterEventEnvelope {
  readonly source: "adapter";
  readonly type: AdapterEventType;
  readonly eventId: string;
  /** Monotonic per run, starting at 1. Duplicates and gaps are detectable. */
  readonly seq: number;
  readonly missionId: string;
  readonly runId: string;
  readonly at: string;
  readonly nativeSessionId?: string;
}

export interface RunStartedEvent extends AdapterEventEnvelope {
  readonly type: "run.started";
  readonly model?: string;
  /** Absent when the engine has not reported its own id yet. */
  readonly nativeSessionId?: string;
  /** The engine refused the cursor and this session started new. */
  readonly rebuilt?: boolean;
}

export interface RunOutputEvent extends AdapterEventEnvelope {
  readonly type: "run.output";
  readonly text: string;
  readonly stream: "stdout" | "stderr" | "assistant";
}

export interface RunToolCallEvent extends AdapterEventEnvelope {
  readonly type: "run.tool_call";
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
}

export interface RunToolResultEvent extends AdapterEventEnvelope {
  readonly type: "run.tool_result";
  readonly callId: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly output?: string;
}

export interface RunApprovalRequestedEvent extends AdapterEventEnvelope {
  readonly type: "run.approval_requested";
  readonly approvalId: string;
  readonly action: string;
  readonly detail: string;
  readonly expiresAt?: string;
}

export interface RunApprovalResolvedEvent extends AdapterEventEnvelope {
  readonly type: "run.approval_resolved";
  readonly approvalId: string;
  readonly decision: "allow" | "deny" | "expired";
  readonly by?: string;
}

export interface RunWaitingInputEvent extends AdapterEventEnvelope {
  readonly type: "run.waiting_input";
  readonly question: string;
}

export interface RunInputReceivedEvent extends AdapterEventEnvelope {
  readonly type: "run.input_received";
  readonly input: string;
}

export interface RunSteerAcknowledgedEvent extends AdapterEventEnvelope {
  readonly type: "run.steer_acknowledged";
  readonly commandId: string;
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface RunInterruptedEvent extends AdapterEventEnvelope {
  readonly type: "run.interrupted";
  readonly resumable: boolean;
  readonly reason?: string;
}

export interface RunResumedEvent extends AdapterEventEnvelope {
  readonly type: "run.resumed";
  /** Absent when the engine has not reported its own id yet. */
  readonly nativeSessionId?: string;
  readonly fromRunId: string;
}

export interface RunCompletedEvent extends AdapterEventEnvelope {
  readonly type: "run.completed";
  readonly outcome: "succeeded";
  readonly summary?: string;
}

export interface RunFailedEvent extends AdapterEventEnvelope {
  readonly type: "run.failed";
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface RunCancelledEvent extends AdapterEventEnvelope {
  readonly type: "run.cancelled";
  readonly reason?: string;
}

export interface RunArtifactEvent extends AdapterEventEnvelope {
  readonly type: "run.artifact";
  readonly artifactId: string;
  readonly path: string;
  readonly bytes: number;
  readonly mediaType: string;
}

export interface RunUsageEvent extends AdapterEventEnvelope {
  readonly type: "run.usage";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export interface RunChildSpawnedEvent extends AdapterEventEnvelope {
  readonly type: "run.child_spawned";
  readonly childMissionId: string;
}

export interface RunChildSettledEvent extends AdapterEventEnvelope {
  readonly type: "run.child_settled";
  readonly childMissionId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
}

export type AdapterEvent =
  | RunStartedEvent
  | RunOutputEvent
  | RunToolCallEvent
  | RunToolResultEvent
  | RunApprovalRequestedEvent
  | RunApprovalResolvedEvent
  | RunWaitingInputEvent
  | RunInputReceivedEvent
  | RunSteerAcknowledgedEvent
  | RunInterruptedEvent
  | RunResumedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | RunArtifactEvent
  | RunUsageEvent
  | RunChildSpawnedEvent
  | RunChildSettledEvent;

export type AdapterEventPayload = Omit<AdapterEvent, keyof AdapterEventEnvelope>;

/** Authority decisions recorded beside adapter events in the same append-only
 * log, so a reader can reconstruct why a mission moved without replaying a
 * command handler. They are not adapter input. */
export interface MissionLogEntry {
  readonly seq: number;
  readonly eventId: string;
  readonly missionId: string;
  readonly runId?: string;
  readonly at: string;
  readonly source: "adapter" | "authority";
  readonly type: string;
  readonly payload: Record<string, unknown>;
  /** The adapter's own sequence, when the entry came from one. */
  readonly adapterSeq?: number;
}

export interface EventPage {
  readonly events: readonly MissionLogEntry[];
  readonly nextSeq: number;
  readonly hasMore: boolean;
}
