import type { AdapterEvent } from "../../packages/agent-protocol/events.ts";
import type { Mission } from "../../packages/agent-protocol/mission.ts";
import { canTransition, type MissionStatus } from "../../packages/agent-protocol/mission-status.ts";
import { canTransitionRun, type RunStatus } from "../../packages/agent-protocol/run.ts";

/** What applying one event does to the mission. An absent `status` means the
 * event is recorded without moving the mission. */
export interface MissionEffect {
  readonly status?: MissionStatus;
  readonly activeRunId?: string | null;
  readonly settledAt?: string | null;
  readonly error?: { code: string; message: string; retryable?: boolean };
  readonly cancelReason?: string;
}

export interface RunEffect {
  readonly status?: RunStatus;
  readonly nativeSessionId?: string;
  readonly nativeStartedAt?: string;
  readonly nativeCompletedAt?: string;
  readonly nativeOutcome?: "succeeded" | "failed" | "cancelled";
  readonly interruptedAt?: string;
  readonly resumedAt?: string;
  readonly error?: { code: string; message: string };
  readonly resumeOfRunId?: string;
}

export interface ApplyEffects {
  readonly mission: MissionEffect;
  readonly run: RunEffect;
}

const NOTHING: ApplyEffects = { mission: {}, run: {} };

function toStatus(from: MissionStatus, to: MissionStatus): MissionStatus | undefined {
  return canTransition(from, to) ? to : undefined;
}

function toRunStatus(from: RunStatus | undefined, to: RunStatus): RunStatus | undefined {
  return from !== undefined && canTransitionRun(from, to) ? to : undefined;
}

function isRunTerminalEvent(type: AdapterEvent["type"]): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.cancelled";
}

/** The run's own bookkeeping for a terminal event, with no mission move. */
function terminalRunEffect(event: AdapterEvent, runStatus: RunStatus | undefined): RunEffect {
  switch (event.type) {
    case "run.completed":
      return { status: toRunStatus(runStatus, "completed"), nativeCompletedAt: event.at, nativeOutcome: "succeeded" };
    case "run.failed":
      return {
        status: toRunStatus(runStatus, "failed"),
        nativeCompletedAt: event.at,
        nativeOutcome: "failed",
        error: { code: event.code, message: event.message },
      };
    case "run.cancelled":
      return { status: toRunStatus(runStatus, "cancelled"), nativeCompletedAt: event.at, nativeOutcome: "cancelled" };
    default:
      return {};
  }
}

/** The only function that turns a structured adapter event into mission state.
 * Terminal status never reaches it: `TerminalStatusSignal` is not an
 * `AdapterEvent`, so this signature rejects one at compile time. */
export function reduce(event: AdapterEvent, mission: Mission, runStatus: RunStatus | undefined): ApplyEffects {
  if (mission.status === "succeeded" || mission.status === "failed" || mission.status === "cancelled") {
    return NOTHING;
  }
  const status = mission.status;

  // A parent waiting on live children is resumed by its wake, not by the run
  // that spawned them finishing: settling it here would orphan the children.
  if (status === "waiting_children" && isRunTerminalEvent(event.type)) {
    return { mission: {}, run: terminalRunEffect(event, runStatus) };
  }

  switch (event.type) {
    case "run.started": {
      const next = toStatus(status, "running");
      return {
        mission: next ? { status: next } : {},
        run: {
          status: toRunStatus(runStatus, "running"),
          ...(event.nativeSessionId !== undefined ? { nativeSessionId: event.nativeSessionId } : {}),
          nativeStartedAt: event.at,
        },
      };
    }

    case "run.waiting_input": {
      const next = toStatus(status, "waiting_input");
      return {
        mission: next ? { status: next } : {},
        run: { status: toRunStatus(runStatus, "waiting_input") },
      };
    }

    case "run.input_received": {
      const next = toStatus(status, "running");
      return {
        mission: next ? { status: next } : {},
        run: { status: toRunStatus(runStatus, "running") },
      };
    }

    case "run.interrupted": {
      const next = toStatus(status, "interrupted");
      return {
        mission: next ? { status: next } : {},
        run: { status: toRunStatus(runStatus, "interrupted"), interruptedAt: event.at },
      };
    }

    case "run.resumed": {
      const next = toStatus(status, "running");
      return {
        mission: next ? { status: next } : {},
        run: {
          status: toRunStatus(runStatus, "running"),
          ...(event.nativeSessionId !== undefined ? { nativeSessionId: event.nativeSessionId } : {}),
          resumedAt: event.at,
          resumeOfRunId: event.fromRunId,
        },
      };
    }

    case "run.completed": {
      const next = toStatus(status, "succeeded");
      return {
        mission: { ...(next ? { status: next } : {}), settledAt: event.at, activeRunId: null },
        run: { status: toRunStatus(runStatus, "completed"), nativeCompletedAt: event.at, nativeOutcome: "succeeded" },
      };
    }

    case "run.failed": {
      const next = toStatus(status, "failed");
      return {
        mission: {
          ...(next ? { status: next } : {}),
          settledAt: event.at,
          activeRunId: null,
          error: {
            code: event.code,
            message: event.message,
            ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
          },
        },
        run: {
          status: toRunStatus(runStatus, "failed"),
          nativeCompletedAt: event.at,
          nativeOutcome: "failed",
          error: { code: event.code, message: event.message },
        },
      };
    }

    case "run.cancelled": {
      const next = toStatus(status, "cancelled");
      return {
        mission: {
          ...(next ? { status: next } : {}),
          settledAt: event.at,
          activeRunId: null,
          ...(event.reason !== undefined ? { cancelReason: event.reason } : {}),
        },
        run: { status: toRunStatus(runStatus, "cancelled"), nativeCompletedAt: event.at, nativeOutcome: "cancelled" },
      };
    }

    case "run.child_spawned": {
      const next = toStatus(status, "waiting_children");
      return { mission: next ? { status: next } : {}, run: {} };
    }

    case "run.output":
    case "run.tool_call":
    case "run.tool_result":
    case "run.approval_requested":
    case "run.approval_resolved":
    case "run.steer_acknowledged":
    case "run.child_settled":
    case "run.artifact":
    case "run.usage":
      return NOTHING;
  }
}
