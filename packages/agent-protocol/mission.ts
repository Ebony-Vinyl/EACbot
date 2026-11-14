import type { AgentKind, ModelRef } from "./agents.ts";
import type { EnvironmentRef } from "./environment.ts";
import type { MissionStatus } from "./mission-status.ts";

export interface MissionError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

/** A mission is one unit of delegated work. It is durable and revisioned;
 * every mutation a client makes names the revision it saw. */
export interface Mission {
  readonly protocolVersion: 1;
  readonly id: string;
  /** The mission that owns the whole tree. A root mission's id is its own. */
  readonly rootMissionId: string;
  readonly parentMissionId?: string;
  readonly depth: number;
  readonly title: string;
  readonly prompt: string;
  readonly agent: AgentKind;
  readonly model?: ModelRef;
  readonly environment: EnvironmentRef;
  readonly status: MissionStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When the authority durably accepted the work. Always earlier than or
   * equal to `nativeStartedAt`; acceptance alone never completes a mission. */
  readonly acceptedAt: string;
  readonly settledAt?: string;
  readonly activeRunId?: string;
  readonly runIds: readonly string[];
  readonly childIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly approvalIds: readonly string[];
  /** Incremented once per `waiting_children` cycle that produced a wake. */
  readonly wakeGeneration: number;
  readonly error?: MissionError;
  readonly cancelReason?: string;
}

export interface MissionTreeNode {
  readonly mission: Mission;
  readonly children: readonly MissionTreeNode[];
}

export interface MissionSummary {
  readonly id: string;
  readonly rootMissionId: string;
  readonly parentMissionId?: string;
  readonly title: string;
  readonly agent: AgentKind;
  readonly status: MissionStatus;
  readonly revision: number;
  readonly updatedAt: string;
}

/** A durable message to a mission. The `wake` kind is written once per
 * `waiting_children` cycle, after every child has settled. */
export interface MissionInboxItem {
  readonly id: string;
  readonly missionId: string;
  readonly generation: number;
  readonly kind: "wake" | "child_settled" | "approval" | "note";
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly consumedAt?: string;
}
