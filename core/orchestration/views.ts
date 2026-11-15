import type { AgentCapabilities } from "../../packages/agent-protocol/agents.ts";
import type { Approval } from "../../packages/agent-protocol/artifact.ts";
import type { CommandResult } from "../../packages/agent-protocol/commands.ts";
import type { Mission } from "../../packages/agent-protocol/mission.ts";
import { isTerminalMissionStatus } from "../../packages/agent-protocol/mission-status.ts";
import { canSteer } from "../../packages/agent-protocol/agents.ts";
import type { Run } from "../../packages/agent-protocol/run.ts";
import type { ApprovalView, CommandAckView, MissionView, RunView } from "./types.ts";

/** A mission's state plus what that state actually permits. The two are
 * computed together so a caller cannot read `status: interrupted` and assume a
 * resume the engine does not have. */
export function missionView(mission: Mission, capabilities: AgentCapabilities): MissionView {
  return {
    id: mission.id,
    rootMissionId: mission.rootMissionId,
    ...(mission.parentMissionId !== undefined ? { parentMissionId: mission.parentMissionId } : {}),
    title: mission.title,
    agent: mission.agent,
    ...(mission.model !== undefined ? { model: mission.model } : {}),
    status: mission.status,
    revision: mission.revision,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    acceptedAt: mission.acceptedAt,
    ...(mission.settledAt !== undefined ? { settledAt: mission.settledAt } : {}),
    ...(mission.activeRunId !== undefined ? { activeRunId: mission.activeRunId } : {}),
    environment: { id: mission.environment.id, label: mission.environment.label, kind: mission.environment.kind },
    ...(mission.error !== undefined ? { error: mission.error } : {}),
    ...(mission.cancelReason !== undefined ? { cancelReason: mission.cancelReason } : {}),
    allowed: allowedActions(mission, capabilities),
  };
}

function allowedActions(mission: Mission, capabilities: AgentCapabilities): MissionView["allowed"] {
  const settled = isTerminalMissionStatus(mission.status);
  const live = !settled && mission.activeRunId !== undefined;
  return {
    steer: live && canSteer(capabilities) ? (capabilities.steer.kind === "native" ? "native" : "next-boundary") : "none",
    interrupt: live && capabilities.interrupt,
    resume: mission.status === "interrupted" && capabilities.resume,
    cancel: !settled,
    answerApproval: !settled && capabilities.approval,
  };
}

export function runView(run: Run): RunView {
  return {
    id: run.id,
    missionId: run.missionId,
    attempt: run.attempt,
    status: run.status,
    revision: run.revision,
    acceptedAt: run.acceptedAt,
    ...(run.nativeSessionId !== undefined ? { nativeSessionId: run.nativeSessionId } : {}),
    ...(run.nativeStartedAt !== undefined ? { nativeStartedAt: run.nativeStartedAt } : {}),
    ...(run.nativeCompletedAt !== undefined ? { nativeCompletedAt: run.nativeCompletedAt } : {}),
    ...(run.nativeOutcome !== undefined ? { nativeOutcome: run.nativeOutcome } : {}),
    ...(run.controlPending !== undefined ? { controlPending: run.controlPending } : {}),
    ...(run.interruptedAt !== undefined ? { interruptedAt: run.interruptedAt } : {}),
    ...(run.resumedAt !== undefined ? { resumedAt: run.resumedAt } : {}),
    ...(run.resumeOfRunId !== undefined ? { resumeOfRunId: run.resumeOfRunId } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

export function approvalView(approval: Approval): ApprovalView {
  return {
    id: approval.id,
    missionId: approval.missionId,
    runId: approval.runId,
    status: approval.status,
    action: approval.action,
    detail: approval.detail,
    requestedAt: approval.requestedAt,
    ...(approval.expiresAt !== undefined ? { expiresAt: approval.expiresAt } : {}),
    ...(approval.resolvedAt !== undefined ? { resolvedAt: approval.resolvedAt } : {}),
    ...(approval.decidedBy !== undefined ? { decidedBy: approval.decidedBy } : {}),
    revision: approval.revision,
  };
}

export function ackView(result: CommandResult): CommandAckView {
  return {
    missionId: result.missionId,
    commandId: result.commandId,
    appliedAt: result.appliedAt,
    revision: result.missionRevision,
    ...(result.runId !== undefined ? { runId: result.runId } : {}),
    ...(result.affectedMissionIds !== undefined ? { affectedMissionIds: result.affectedMissionIds } : {}),
    ...(result.affectedRunIds !== undefined ? { affectedRunIds: result.affectedRunIds } : {}),
  };
}
