import type { AgentKind, ModelRef } from "../../packages/agent-protocol/agents.ts";
import type { Approval, ApprovalStatus, Artifact, ArtifactKind } from "../../packages/agent-protocol/artifact.ts";
import type { EnvironmentRef } from "../../packages/agent-protocol/environment.ts";
import type { Mission, MissionError, MissionInboxItem } from "../../packages/agent-protocol/mission.ts";
import type { MissionStatus } from "../../packages/agent-protocol/mission-status.ts";
import type { NativeOutcome, PendingControl, Run, RunStatus } from "../../packages/agent-protocol/run.ts";
import type { TerminalKind, TerminalRef } from "../../packages/agent-protocol/terminal.ts";

export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;

export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`${key} is not text`);
  return value;
}

export function nullableText(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${key} is not text`);
  return value;
}

export function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`${key} is not an integer`);
}

export function nullableInteger(row: Row, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`${key} is not an integer`);
}

export function parseJson<T>(value: string | undefined): T | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(value) as T;
}

export function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export interface MissionExtras {
  readonly runIds: readonly string[];
  readonly childIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly approvalIds: readonly string[];
}

export function missionFromRow(row: Row, extras: MissionExtras): Mission {
  const parent = nullableText(row, "parent_mission_id");
  const settled = nullableText(row, "settled_at");
  const activeRun = nullableText(row, "active_run_id");
  const cancelReason = nullableText(row, "cancel_reason");
  const model = parseJson<ModelRef>(nullableText(row, "model_json"));
  const error = parseJson<MissionError>(nullableText(row, "error_json"));
  return {
    protocolVersion: 1,
    id: text(row, "id"),
    rootMissionId: text(row, "root_mission_id"),
    ...(parent ? { parentMissionId: parent } : {}),
    depth: integer(row, "depth"),
    title: text(row, "title"),
    prompt: text(row, "prompt"),
    agent: text(row, "agent") as AgentKind,
    ...(model ? { model } : {}),
    environment: JSON.parse(text(row, "environment_json")) as EnvironmentRef,
    status: text(row, "status") as MissionStatus,
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    acceptedAt: text(row, "accepted_at"),
    ...(settled ? { settledAt: settled } : {}),
    ...(activeRun ? { activeRunId: activeRun } : {}),
    runIds: extras.runIds,
    childIds: extras.childIds,
    artifactIds: extras.artifactIds,
    approvalIds: extras.approvalIds,
    wakeGeneration: integer(row, "wake_generation"),
    ...(error ? { error } : {}),
    ...(cancelReason ? { cancelReason } : {}),
  };
}

export function runFromRow(row: Row): Run {
  const session = nullableText(row, "native_session_id");
  const started = nullableText(row, "native_started_at");
  const completed = nullableText(row, "native_completed_at");
  const outcome = nullableText(row, "native_outcome") as NativeOutcome | undefined;
  const resumeOf = nullableText(row, "resume_of_run_id");
  const interruptedAt = nullableText(row, "interrupted_at");
  const resumedAt = nullableText(row, "resumed_at");
  const controlPending = nullableText(row, "control_pending") as PendingControl | undefined;
  const cancelAcceptedAt = nullableText(row, "cancel_accepted_at");
  const reconcileRequiredAt = nullableText(row, "reconcile_required_at");
  const error = parseJson<{ code: string; message: string }>(nullableText(row, "error_json"));
  return {
    protocolVersion: 1,
    id: text(row, "id"),
    missionId: text(row, "mission_id"),
    attempt: integer(row, "attempt"),
    agent: text(row, "agent") as AgentKind,
    acceptedAt: text(row, "accepted_at"),
    acceptedCommandId: text(row, "accepted_command_id"),
    ...(session ? { nativeSessionId: session } : {}),
    ...(started ? { nativeStartedAt: started } : {}),
    ...(completed ? { nativeCompletedAt: completed } : {}),
    ...(outcome ? { nativeOutcome: outcome } : {}),
    status: text(row, "status") as RunStatus,
    revision: integer(row, "revision"),
    ...(resumeOf ? { resumeOfRunId: resumeOf } : {}),
    ...(interruptedAt ? { interruptedAt } : {}),
    ...(resumedAt ? { resumedAt } : {}),
    lastAdapterSeq: integer(row, "last_adapter_seq"),
    ...(controlPending ? { controlPending } : {}),
    ...(cancelAcceptedAt ? { cancelAcceptedAt } : {}),
    ...(reconcileRequiredAt ? { reconcileRequiredAt } : {}),
    ...(error ? { error } : {}),
  };
}

export function approvalFromRow(row: Row): Approval {
  const expires = nullableText(row, "expires_at");
  const resolved = nullableText(row, "resolved_at");
  const by = nullableText(row, "decided_by");
  return {
    id: text(row, "id"),
    missionId: text(row, "mission_id"),
    runId: text(row, "run_id"),
    status: text(row, "status") as ApprovalStatus,
    action: text(row, "action"),
    detail: text(row, "detail"),
    requestedAt: text(row, "requested_at"),
    ...(expires ? { expiresAt: expires } : {}),
    ...(resolved ? { resolvedAt: resolved } : {}),
    ...(by ? { decidedBy: by } : {}),
    revision: integer(row, "revision"),
  };
}

export function artifactFromRow(row: Row): Artifact {
  const sha = nullableText(row, "sha256");
  return {
    id: text(row, "id"),
    missionId: text(row, "mission_id"),
    runId: text(row, "run_id"),
    kind: text(row, "kind") as ArtifactKind,
    path: text(row, "path"),
    mediaType: text(row, "media_type"),
    bytes: integer(row, "bytes"),
    ...(sha ? { sha256: sha } : {}),
    createdAt: text(row, "created_at"),
  };
}

export function inboxFromRow(row: Row): MissionInboxItem {
  const consumed = nullableText(row, "consumed_at");
  return {
    id: text(row, "id"),
    missionId: text(row, "mission_id"),
    generation: integer(row, "generation"),
    kind: text(row, "kind") as MissionInboxItem["kind"],
    payload: parseJson<Record<string, unknown>>(text(row, "payload_json")) ?? {},
    createdAt: text(row, "created_at"),
    ...(consumed ? { consumedAt: consumed } : {}),
  };
}

export function terminalFromRow(row: Row): TerminalRef {
  const closed = nullableText(row, "closed_at");
  const exit = nullableInteger(row, "exit_code");
  return {
    id: text(row, "id"),
    kind: text(row, "kind") as TerminalKind,
    missionId: text(row, "mission_id"),
    runId: text(row, "run_id"),
    createdAt: text(row, "created_at"),
    ...(closed ? { closedAt: closed } : {}),
    ...(exit !== undefined ? { exitCode: exit } : {}),
  };
}
