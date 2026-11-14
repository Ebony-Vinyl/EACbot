import type { AgentCapabilities, AgentKind } from "../../packages/agent-protocol/agents.ts";
import type { CommandResult } from "../../packages/agent-protocol/commands.ts";
import type { AdapterEvent } from "../../packages/agent-protocol/events.ts";
import { assertAdapterEvent } from "../../packages/agent-protocol/guards.ts";
import { isTerminalMissionStatus } from "../../packages/agent-protocol/mission-status.ts";
import { isTerminalRunStatus } from "../../packages/agent-protocol/run.ts";
import type { CommandRegistry } from "./command-registry.ts";
import type { Database } from "./db.ts";
import { inTransaction } from "./db.ts";
import { RunNotFoundError } from "./errors.ts";
import type { EventLog } from "./event-log.ts";
import type { RecordStore } from "./records.ts";
import { reduce, type RunEffect } from "./reduce.ts";
import type { MissionStore } from "./store.ts";

export interface MissionContext {
  readonly db: Database;
  readonly store: MissionStore;
  readonly log: EventLog;
  readonly records: RecordStore;
  readonly registry: CommandRegistry;
  readonly now: () => string;
  capabilitiesFor(agent: AgentKind): AgentCapabilities;
}

export interface IngestResult {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly buffered: boolean;
  readonly applied: number;
  readonly seq?: number;
}

/** Applies one structured adapter event. Duplicates are dropped, out-of-order
 * events are buffered until their predecessors arrive, and a mission that has
 * already settled ignores further adapter input. */
export function ingestAdapterEvent(ctx: MissionContext, input: AdapterEvent): IngestResult {
  assertAdapterEvent(input);

  return inTransaction(ctx.db, () => {
    const run = ctx.store.getRun(input.runId);
    if (!run || run.missionId !== input.missionId) throw new RunNotFoundError(input.runId);

    if (isTerminalRunStatus(run.status)) {
      return { accepted: false, duplicate: false, buffered: false, applied: 0 };
    }

    const outcome = ctx.log.appendAdapterEvent(input);
    if (!outcome.appended) {
      return { accepted: outcome.buffered, duplicate: outcome.duplicate, buffered: outcome.buffered, applied: 0 };
    }

    const ordered = [input, ...ctx.log.drainRun(input.runId)];
    let applied = 0;
    for (const event of ordered) {
      if (applyEvent(ctx, event)) applied += 1;
    }
    return {
      accepted: true,
      duplicate: false,
      buffered: false,
      applied,
      ...(outcome.seq !== undefined ? { seq: outcome.seq } : {}),
    };
  });
}

function applyEvent(ctx: MissionContext, event: AdapterEvent): boolean {
  const mission = ctx.store.getMission(event.missionId);
  const run = ctx.store.getRun(event.runId);
  if (!mission || !run) return false;
  if (isTerminalMissionStatus(mission.status)) return false;

  const effects = reduce(event, mission, run.status);
  recordSideEffect(ctx, event);

  if (hasRunEffect(effects.run)) {
    ctx.store.updateRun(run.id, {
      ...(effects.run.status !== undefined ? { status: effects.run.status } : {}),
      ...(effects.run.nativeSessionId !== undefined ? { nativeSessionId: effects.run.nativeSessionId } : {}),
      ...(effects.run.nativeStartedAt !== undefined ? { nativeStartedAt: effects.run.nativeStartedAt } : {}),
      ...(effects.run.nativeCompletedAt !== undefined ? { nativeCompletedAt: effects.run.nativeCompletedAt } : {}),
      ...(effects.run.nativeOutcome !== undefined ? { nativeOutcome: effects.run.nativeOutcome } : {}),
      ...(effects.run.interruptedAt !== undefined ? { interruptedAt: effects.run.interruptedAt } : {}),
      ...(effects.run.resumedAt !== undefined ? { resumedAt: effects.run.resumedAt } : {}),
      ...(effects.run.resumeOfRunId !== undefined ? { resumeOfRunId: effects.run.resumeOfRunId } : {}),
      ...(effects.run.error !== undefined ? { error: effects.run.error } : {}),
    });
  }

  const missionEffect = effects.mission;
  if (Object.keys(missionEffect).length > 0) {
    ctx.store.applyAuthorityStatus(mission.id, missionEffect.status ?? mission.status, event.at, {
      ...(missionEffect.settledAt !== undefined ? { settledAt: missionEffect.settledAt } : {}),
      ...(missionEffect.activeRunId !== undefined ? { activeRunId: missionEffect.activeRunId } : {}),
      ...(missionEffect.error !== undefined ? { error: missionEffect.error } : {}),
      ...(missionEffect.cancelReason !== undefined ? { cancelReason: missionEffect.cancelReason } : {}),
    });
  }

  if (event.type === "run.child_spawned") ctx.store.bumpMission(mission.id, event.at);

  const settled = ctx.store.requireMission(mission.id);
  if (isTerminalMissionStatus(settled.status) && settled.parentMissionId !== undefined) {
    wakeParentIfReady(ctx, settled.parentMissionId, event.at);
  }
  return true;
}

function hasRunEffect(effect: RunEffect): boolean {
  return Object.keys(effect).length > 0;
}

function recordSideEffect(ctx: MissionContext, event: AdapterEvent): void {
  switch (event.type) {
    case "run.approval_requested":
      ctx.records.requestApproval({
        id: event.approvalId,
        missionId: event.missionId,
        runId: event.runId,
        action: event.action,
        detail: event.detail,
        requestedAt: event.at,
        ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
      });
      break;
    case "run.approval_resolved":
      ctx.records.resolveApproval(
        event.approvalId,
        event.decision === "allow" ? "allowed" : event.decision === "deny" ? "denied" : "expired",
        event.at,
        event.by,
      );
      break;
    case "run.artifact":
      ctx.records.addArtifact({
        id: event.artifactId,
        missionId: event.missionId,
        runId: event.runId,
        kind: "file",
        path: event.path,
        mediaType: event.mediaType,
        bytes: event.bytes,
        createdAt: event.at,
      });
      break;
    default:
      break;
  }
}

/** Writes one durable wake per settled cycle. The wake is recorded even when
 * the parent is interrupted, so a resume finds it; only a parent that is
 * actually `waiting_children` moves back to `running`. A parent that is
 * already running has had its wake. */
export function wakeParentIfReady(ctx: MissionContext, parentMissionId: string, now: string): boolean {
  const parent = ctx.store.getMission(parentMissionId);
  if (!parent) return false;
  if (parent.status !== "waiting_children" && parent.status !== "interrupted") return false;
  const children = ctx.store.childrenOf(parent.id);
  if (children.length === 0) return false;
  if (!children.every((child) => isTerminalMissionStatus(child.status))) return false;

  const generation = parent.wakeGeneration + 1;
  const created = ctx.records.enqueueWake({
    missionId: parent.id,
    generation,
    kind: "wake",
    payload: { children: children.map((child) => ({ missionId: child.id, status: child.status })) },
    createdAt: now,
  });
  if (!created) return false;

  ctx.store.setWakeGeneration(parent.id, generation, now);
  ctx.log.appendAuthorityEvent(parent.id, "mission.woken", { generation }, now);
  if (parent.status === "waiting_children") ctx.store.applyAuthorityStatus(parent.id, "running", now);
  return true;
}

export function commandResult(
  ctx: MissionContext,
  input: {
    commandId: string;
    type: CommandResult["type"];
    missionId: string;
    runId?: string;
    affected?: readonly string[];
    affectedRuns?: readonly string[];
  },
): CommandResult {
  const mission = ctx.store.getMission(input.missionId);
  return {
    commandId: input.commandId,
    type: input.type,
    missionId: input.missionId,
    appliedAt: ctx.now(),
    missionRevision: mission?.revision ?? 0,
    replayed: false,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.affected !== undefined ? { affectedMissionIds: input.affected } : {}),
    ...(input.affectedRuns !== undefined ? { affectedRunIds: input.affectedRuns } : {}),
  };
}
