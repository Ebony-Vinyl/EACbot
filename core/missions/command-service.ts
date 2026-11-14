import type { AgentCapabilities, AgentKind } from "../../packages/agent-protocol/agents.ts";
import type { CommandResult, MissionCommand } from "../../packages/agent-protocol/commands.ts";
import { CommandError } from "../../packages/agent-protocol/commands.ts";
import { isTerminalMissionStatus } from "../../packages/agent-protocol/mission-status.ts";
import { isTerminalRunStatus } from "../../packages/agent-protocol/run.ts";
import { requestHash } from "./command-registry.ts";
import type { MissionContext } from "./ingest.ts";
import { commandResult, wakeParentIfReady } from "./ingest.ts";

/** Executes one command exactly once. The durable record is written in the same
 * transaction as the state change, so a crash either keeps both or neither. */
export function executeCommand(ctx: MissionContext, command: MissionCommand): CommandResult {
  const hash = requestHash(command.type, command);
  const replay = ctx.registry.lookup(command.commandId, hash);
  if (replay) return replay;

  return ctx.store.transaction(() => {
    const again = ctx.registry.lookup(command.commandId, hash);
    if (again) return again;
    const result = applyCommand(ctx, command);
    ctx.registry.record({
      commandId: command.commandId,
      type: command.type,
      missionId: result.missionId,
      appliedAt: result.appliedAt,
      requestHash: hash,
      result,
    });
    return result;
  });
}

function applyCommand(ctx: MissionContext, command: MissionCommand): CommandResult {
  switch (command.type) {
    case "mission.create":
      return createMission(ctx, command);
    case "run.steer":
      return steerRun(ctx, command);
    case "run.interrupt":
      return interruptRun(ctx, command);
    case "mission.resume":
      return resumeMission(ctx, command);
    case "run.submit_input":
      return submitInput(ctx, command);
    case "approval.resolve":
      return resolveApproval(ctx, command);
    case "mission.cancel":
      return cancelMission(ctx, command);
    case "run.reconcile":
      return reconcileRun(ctx, command);
  }
}

/** Records the caller's reconciliation intent; `MissionRuntime` performs the
 * native effect afterwards. `start` and `resume` only check the preconditions
 * here, so a bad request fails before anything is launched. */
function reconcileRun(ctx: MissionContext, command: Extract<MissionCommand, { type: "run.reconcile" }>): CommandResult {
  const mission = requireRevision(ctx, command.missionId, command.expectedRevision);
  const run = ctx.store.getRun(command.runId);
  if (!run || run.missionId !== mission.id) throw new CommandError("not_found", `no run ${command.runId} on this mission`);

  // A run whose status already says cancelled but whose native effect is
  // unconfirmed must still accept the retry that confirms it.
  const retryingPendingCancel = command.action === "cancel" && run.controlPending === "cancel";
  if (isTerminalRunStatus(run.status) && command.action !== "abandon" && !retryingPendingCancel) {
    throw new CommandError("already_settled", "the run is already settled");
  }

  if (command.action === "start" && run.nativeStartedAt !== undefined) {
    throw new CommandError("invalid_request", "the run already started once");
  }
  if (command.action === "resume" && run.nativeSessionId === undefined) {
    throw new CommandError("invalid_request", "the run kept no native session to resume");
  }

  ctx.log.appendAuthorityEvent(mission.id, "run.reconcile_requested", { runId: run.id, action: command.action }, ctx.now(), run.id);
  return commandResult(ctx, { commandId: command.commandId, type: command.type, missionId: mission.id, runId: run.id });
}

function createMission(ctx: MissionContext, command: Extract<MissionCommand, { type: "mission.create" }>): CommandResult {
  if (command.title.trim().length === 0) throw new CommandError("invalid_request", "title is required");
  if (command.prompt.trim().length === 0) throw new CommandError("invalid_request", "prompt is required");
  requireCapability(ctx, command.agent, "events");

  const mission = ctx.store.createMission(
    {
      title: command.title,
      prompt: command.prompt,
      agent: command.agent,
      ...(command.model !== undefined ? { model: command.model } : {}),
      environment: command.environment,
      ...(command.parentMissionId !== undefined ? { parentMissionId: command.parentMissionId } : {}),
      now: ctx.now(),
    },
    command.commandId,
  );
  return commandResult(ctx, { commandId: command.commandId, type: command.type, missionId: mission.id });
}

function steerRun(ctx: MissionContext, command: Extract<MissionCommand, { type: "run.steer" }>): CommandResult {
  const mission = requireRevision(ctx, command.missionId, command.expectedRevision);
  const run = mission.activeRunId ? ctx.store.getRun(mission.activeRunId) : undefined;
  if (!run || isTerminalRunStatus(run.status)) {
    throw new CommandError("already_settled", "the mission has no live run to steer");
  }
  if (command.input.trim().length === 0) throw new CommandError("invalid_request", "input is required");
  requireCapability(ctx, mission.agent, "steer");
  ctx.log.appendAuthorityEvent(mission.id, "run.steer_requested", { input: command.input, commandId: command.commandId }, ctx.now(), run.id);
  ctx.store.bumpMission(mission.id, ctx.now());
  return commandResult(ctx, { commandId: command.commandId, type: command.type, missionId: mission.id, runId: run.id });
}

function interruptRun(ctx: MissionContext, command: Extract<MissionCommand, { type: "run.interrupt" }>): CommandResult {
  const mission = requireRevision(ctx, command.missionId, command.expectedRevision);
  if (isTerminalMissionStatus(mission.status)) throw new CommandError("already_settled", "the mission is already settled");
  const run = mission.activeRunId ? ctx.store.getRun(mission.activeRunId) : undefined;
  if (!run || isTerminalRunStatus(run.status)) throw new CommandError("already_settled", "the mission has no live run to interrupt");
  requireCapability(ctx, mission.agent, "interrupt");

  ctx.store.updateRun(run.id, { status: "interrupted", interruptedAt: ctx.now(), controlPending: "interrupt" });
  ctx.store.applyAuthorityStatus(mission.id, "interrupted", ctx.now());
  ctx.log.appendAuthorityEvent(mission.id, "run.interrupted", { reason: command.reason ?? null, commandId: command.commandId }, ctx.now(), run.id);
  return commandResult(ctx, { commandId: command.commandId, type: command.type, missionId: mission.id, runId: run.id });
}

function resumeMission(ctx: MissionContext, command: Extract<MissionCommand, { type: "mission.resume" }>): CommandResult {
  const mission = requireRevision(ctx, command.missionId, command.expectedRevision);
  if (mission.status !== "interrupted") throw new CommandError("illegal_transition", "only an interrupted mission resumes");
  requireCapability(ctx, mission.agent, "resume");

  const previous = ctx.store.latestRun(mission.id);
  if (!previous) throw new CommandError("invalid_request", "the mission has no run to resume");
  if (previous.nativeSessionId === undefined) {
    throw new CommandError("invalid_request", "the interrupted run kept no native session");
  }

  ctx.store.applyAuthorityStatus(mission.id, "resuming", ctx.now());
  const run = ctx.store.acceptRun({ missionId: mission.id, commandId: command.commandId, now: ctx.now() });
  ctx.store.updateRun(run.id, {
    resumeOfRunId: previous.id,
    nativeSessionId: previous.nativeSessionId,
  });
  ctx.store.applyAuthorityStatus(mission.id, "resuming", ctx.now(), { activeRunId: run.id });
  ctx.log.appendAuthorityEvent(mission.id, "run.resume_accepted", { fromRunId: previous.id, runId: run.id }, ctx.now(), run.id);
  return commandResult(ctx, { commandId: command.commandId, type: command.type, missionId: mission.id, runId: run.id });
}

function submitInput(ctx: MissionContext, command: Extract<MissionCommand, { type: "run.submit_input" }>): CommandResult {
  const mission = requireRevision(ctx, command.missionId, command.expectedRevision);
  if (mission.status !== "waiting_input") throw new CommandError("illegal_transition", "the mission is not waiting for input");
  const run = mission.activeRunId ? ctx.store.getRun(mission.activeRunId) : undefined;
  if (!run) throw new CommandError("already_settled", "the mission has no live run");

  ctx.log.appendAuthorityEvent(mission.id, "run.input_submitted", { input: command.input }, ctx.now(), run.id);
  ctx.store.applyAuthorityStatus(mission.id, "running", ctx.now());
  if (run.status === "waiting_input") ctx.store.updateRun(run.id, { status: "running" });
  return commandResult(ctx, { commandId: command.commandId, type: command.type, missionId: mission.id, runId: run.id });
}

function resolveApproval(ctx: MissionContext, command: Extract<MissionCommand, { type: "approval.resolve" }>): CommandResult {
  const mission = requireRevision(ctx, command.missionId, command.expectedRevision);
  const approval = ctx.records.getApproval(command.approvalId);
  if (!approval || approval.missionId !== mission.id) throw new CommandError("not_found", "no such approval on this mission");
  if (approval.status !== "pending") throw new CommandError("already_settled", "the approval is already resolved");
  requireCapability(ctx, mission.agent, "approval");

  ctx.records.resolveApproval(approval.id, command.decision === "allow" ? "allowed" : command.decision === "deny" ? "denied" : "answered", ctx.now(), command.by);
  ctx.log.appendAuthorityEvent(
    mission.id,
    "approval.resolved",
    {
      approvalId: approval.id,
      decision: command.decision,
      ...(command.answer !== undefined ? { answer: command.answer } : {}),
    },
    ctx.now(),
    approval.runId,
  );
  ctx.store.bumpMission(mission.id, ctx.now());
  return commandResult(ctx, { commandId: command.commandId, type: command.type, missionId: mission.id, runId: approval.runId });
}

function cancelMission(ctx: MissionContext, command: Extract<MissionCommand, { type: "mission.cancel" }>): CommandResult {
  const mission = requireRevision(ctx, command.missionId, command.expectedRevision);
  if (isTerminalMissionStatus(mission.status)) {
    throw new CommandError("already_settled", "the mission is already settled");
  }
  const affected: string[] = [];
  const affectedRuns: string[] = [];
  const now = ctx.now();
  const targets = command.cascade === false ? [mission] : [mission, ...ctx.store.descendantsOf(mission.id)];

  for (const target of targets) {
    const current = ctx.store.requireMission(target.id);
    if (isTerminalMissionStatus(current.status)) continue;
    const run = current.activeRunId ? ctx.store.getRun(current.activeRunId) : undefined;
    if (run && !isTerminalRunStatus(run.status)) {
      ctx.store.updateRun(run.id, {
        status: "cancelled",
        nativeCompletedAt: now,
        nativeOutcome: "cancelled",
        controlPending: "cancel",
        cancelAcceptedAt: now,
      });
      affectedRuns.push(run.id);
    }
    ctx.store.applyAuthorityStatus(current.id, "cancelled", now, {
      settledAt: now,
      activeRunId: null,
      ...(command.reason !== undefined ? { cancelReason: command.reason } : {}),
    });
    ctx.log.appendAuthorityEvent(current.id, "mission.cancelled", { reason: command.reason ?? null, commandId: command.commandId }, now);
    affected.push(current.id);
  }

  for (const id of affected) {
    const settled = ctx.store.requireMission(id);
    if (settled.parentMissionId !== undefined) wakeParentIfReady(ctx, settled.parentMissionId, now);
  }
  return commandResult(ctx, {
    commandId: command.commandId,
    type: command.type,
    missionId: mission.id,
    affected: affected,
    affectedRuns,
  });
}

function requireRevision(ctx: MissionContext, missionId: string, expectedRevision: number) {
  const mission = ctx.store.getMission(missionId);
  if (!mission) throw new CommandError("not_found", `no mission ${missionId}`);
  if (mission.revision !== expectedRevision) {
    throw new CommandError("revision_conflict", `mission ${missionId} moved on`, mission.revision);
  }
  return mission;
}

function requireCapability(ctx: MissionContext, agent: AgentKind, capability: keyof AgentCapabilities): void {
  const value = ctx.capabilitiesFor(agent)[capability];
  const supported = typeof value === "boolean" ? value : value.kind !== "none";
  if (!supported) {
    throw new CommandError("capability_missing", `${agent} does not support ${capability}`);
  }
}
