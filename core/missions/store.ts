import { randomUUID } from "node:crypto";

import type { AgentKind, ModelRef } from "../../packages/agent-protocol/agents.ts";
import type { EnvironmentRef } from "../../packages/agent-protocol/environment.ts";
import { assertEnvironmentRef } from "../../packages/agent-protocol/guards.ts";
import type { Mission, MissionTreeNode } from "../../packages/agent-protocol/mission.ts";
import { assertTransition, isTerminalMissionStatus, type MissionStatus } from "../../packages/agent-protocol/mission-status.ts";
import type { Run, RunStatus } from "../../packages/agent-protocol/run.ts";
import type { PendingControl } from "../../packages/agent-protocol/run.ts";
import { inTransaction, type Database } from "./db.ts";
import { MissionNotFoundError, RevisionConflictError, RunNotFoundError } from "./errors.ts";
import { integer, json, missionFromRow, runFromRow, text, type Row } from "./rows.ts";

export interface CreateMissionInput {
  readonly title: string;
  readonly prompt: string;
  readonly agent: AgentKind;
  readonly model?: ModelRef;
  readonly environment: EnvironmentRef;
  readonly parentMissionId?: string;
  readonly now?: string;
}

export interface MissionMutation {
  readonly status?: MissionStatus;
  readonly activeRunId?: string | null;
  readonly settledAt?: string | null;
  readonly error?: Mission["error"] | null;
  readonly cancelReason?: string | null;
  readonly updatedAt: string;
}

export interface AcceptRunInput {
  readonly missionId: string;
  readonly commandId: string;
  readonly now: string;
}

export class MissionStore {
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  transaction<T>(fn: () => T): T {
    return inTransaction(this.db, fn);
  }

  close(): void {
    this.db.close();
  }

  createMission(input: CreateMissionInput, commandId: string): Mission {
    assertEnvironmentRef(input.environment);
    const now = input.now ?? new Date().toISOString();
    const id: string = randomUUID();
    return this.transaction(() => {
      let rootMissionId: string = id;
      let depth = 0;
      if (input.parentMissionId !== undefined) {
        const parent = this.requireMission(input.parentMissionId);
        rootMissionId = parent.rootMissionId;
        depth = parent.depth + 1;
        if (isTerminalMissionStatus(parent.status)) {
          throw new RevisionConflictError(`mission ${parent.id}`, parent.revision, parent.revision);
        }
      }
      this.db
        .prepare(
          `INSERT INTO missions (id, root_mission_id, parent_mission_id, depth, title, prompt, agent, model_json,
            environment_json, status, revision, created_at, updated_at, accepted_at, wake_generation)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?, 0)`,
        )
        .run(
          id,
          rootMissionId,
          input.parentMissionId ?? null,
          depth,
          input.title,
          input.prompt,
          input.agent,
          json(input.model),
          JSON.stringify(input.environment),
          now,
          now,
          now,
        );
      if (input.parentMissionId !== undefined) {
        this.bumpMission(input.parentMissionId, now);
        this.waitOnChildren(input.parentMissionId, now);
      }
      this.appendAuthorityEvent(id, now, "mission.accepted", { commandId, title: input.title });
      this.acceptRun({ missionId: id, commandId, now });
      return this.requireMission(id);
    });
  }

  getMission(id: string): Mission | undefined {
    const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as Row | undefined;
    return row ? this.missionWithExtras(row) : undefined;
  }

  requireMission(id: string): Mission {
    const mission = this.getMission(id);
    if (!mission) throw new MissionNotFoundError(id);
    return mission;
  }

  listMissions(rootMissionId?: string): Mission[] {
    const rows = rootMissionId
      ? (this.db.prepare("SELECT * FROM missions WHERE root_mission_id = ? ORDER BY created_at, id").all(rootMissionId) as Row[])
      : (this.db.prepare("SELECT * FROM missions ORDER BY created_at, id").all() as Row[]);
    return rows.map((row) => this.missionWithExtras(row));
  }

  missionTree(rootMissionId: string): MissionTreeNode | undefined {
    const all = this.listMissions(rootMissionId);
    const root = all.find((mission) => mission.id === rootMissionId);
    if (!root) return undefined;
    const byParent = new Map<string, Mission[]>();
    for (const mission of all) {
      if (mission.parentMissionId === undefined) continue;
      const list = byParent.get(mission.parentMissionId) ?? [];
      list.push(mission);
      byParent.set(mission.parentMissionId, list);
    }
    const build = (mission: Mission): MissionTreeNode => ({
      mission,
      children: (byParent.get(mission.id) ?? []).map(build),
    });
    return build(root);
  }

  childrenOf(missionId: string): Mission[] {
    const rows = this.db.prepare("SELECT * FROM missions WHERE parent_mission_id = ? ORDER BY created_at, id").all(missionId) as Row[];
    return rows.map((row) => this.missionWithExtras(row));
  }

  descendantsOf(missionId: string): Mission[] {
    const collected: Mission[] = [];
    const queue = this.childrenOf(missionId);
    while (queue.length > 0) {
      const next = queue.shift()!;
      collected.push(next);
      queue.push(...this.childrenOf(next.id));
    }
    return collected;
  }

  /** Applies a status or bookkeeping change under the caller's revision. Every
   * call increments the revision exactly once. */
  mutateMission(id: string, expectedRevision: number, mutation: MissionMutation): Mission {
    return this.transaction(() => {
      const current = this.requireMission(id);
      if (current.revision !== expectedRevision) {
        throw new RevisionConflictError(`mission ${id}`, expectedRevision, current.revision);
      }
      if (mutation.status !== undefined) assertTransition(current.status, mutation.status);
      this.writeMission(current, mutation);
      return this.requireMission(id);
    });
  }

  /** Authority-initiated transition: still legal-transition checked, but it
   * trusts its own current revision instead of a caller's. Bookkeeping fields
   * are written even when the status does not change. */
  applyAuthorityStatus(id: string, status: MissionStatus, now: string, extra: Partial<MissionMutation> = {}): Mission {
    return this.transaction(() => {
      const current = this.requireMission(id);
      if (isTerminalMissionStatus(current.status)) return current;
      const sameStatus = current.status === status;
      if (sameStatus && !hasBookkeeping(extra)) return current;
      if (!sameStatus) assertTransition(current.status, status);
      this.writeMission(current, { ...extra, status, updatedAt: now });
      return this.requireMission(id);
    });
  }

  bumpMission(id: string, now: string): Mission {
    return this.transaction(() => {
      const current = this.requireMission(id);
      this.writeMission(current, { updatedAt: now });
      return this.requireMission(id);
    });
  }

  /** A mission with live children is `waiting_children`; the run that spawned
   * them is not what advances the mission from here. */
  waitOnChildren(id: string, now: string): Mission {
    return this.transaction(() => {
      const current = this.requireMission(id);
      if (isTerminalMissionStatus(current.status) || current.status === "waiting_children") return current;
      if (current.status === "interrupted" || current.status === "resuming" || current.status === "queued") return current;
      this.writeMission(current, { status: "waiting_children", updatedAt: now });
      return this.requireMission(id);
    });
  }

  setWakeGeneration(id: string, generation: number, now: string): void {
    this.db
      .prepare("UPDATE missions SET wake_generation = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(generation, now, id);
  }

  acceptRun(input: AcceptRunInput): Run {
    return this.transaction(() => {
      const mission = this.requireMission(input.missionId);
      if (isTerminalMissionStatus(mission.status)) {
        throw new RevisionConflictError(`mission ${mission.id}`, mission.revision, mission.revision);
      }
      const attempt = this.nextAttempt(mission.id);
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO runs (id, mission_id, attempt, agent, accepted_at, accepted_command_id, status, revision, last_adapter_seq)
           VALUES (?, ?, ?, ?, ?, ?, 'accepted', 1, 0)`,
        )
        .run(id, mission.id, attempt, mission.agent, input.now, input.commandId);
      this.writeMission(mission, {
        updatedAt: input.now,
        ...(mission.activeRunId === undefined ? { activeRunId: id } : {}),
      });
      this.appendAuthorityEvent(mission.id, input.now, "run.accepted", { runId: id, attempt, commandId: input.commandId });
      return this.requireRun(id);
    });
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? runFromRow(row) : undefined;
  }

  requireRun(id: string): Run {
    const run = this.getRun(id);
    if (!run) throw new RunNotFoundError(id);
    return run;
  }

  runsFor(missionId: string): Run[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE mission_id = ? ORDER BY attempt").all(missionId) as Row[];
    return rows.map(runFromRow);
  }

  activeRun(missionId: string): Run | undefined {
    const mission = this.requireMission(missionId);
    return mission.activeRunId ? this.getRun(mission.activeRunId) : undefined;
  }

  latestRun(missionId: string): Run | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE mission_id = ? ORDER BY attempt DESC LIMIT 1")
      .get(missionId) as Row | undefined;
    return row ? runFromRow(row) : undefined;
  }

  updateRun(id: string, patch: Partial<Omit<Run, "id" | "missionId" | "attempt" | "protocolVersion">>): Run {
    return this.transaction(() => {
      const current = this.requireRun(id);
      const next = { ...current, ...patch, revision: current.revision + 1 };
      this.db
        .prepare(
          `UPDATE runs SET status = ?, revision = ?, native_session_id = ?, native_started_at = ?, native_completed_at = ?,
            native_outcome = ?, resume_of_run_id = ?, interrupted_at = ?, resumed_at = ?, last_adapter_seq = ?,
            control_pending = ?, cancel_accepted_at = ?, reconcile_required_at = ?, error_json = ?
           WHERE id = ?`,
        )
        .run(
          next.status,
          next.revision,
          next.nativeSessionId ?? null,
          next.nativeStartedAt ?? null,
          next.nativeCompletedAt ?? null,
          next.nativeOutcome ?? null,
          next.resumeOfRunId ?? null,
          next.interruptedAt ?? null,
          next.resumedAt ?? null,
          next.lastAdapterSeq,
          next.controlPending ?? null,
          next.cancelAcceptedAt ?? null,
          next.reconcileRequiredAt ?? null,
          json(next.error),
          id,
        );
      return this.requireRun(id);
    });
  }

  setRunStatus(id: string, status: RunStatus): Run {
    return this.updateRun(id, { status });
  }

  /** Clears a recorded-but-unconfirmed control action once its native effect
   * is known, so recovery stops reporting it. */
  clearControlPending(id: string): Run {
    return this.transaction(() => {
      const current = this.requireRun(id);
      this.db
        .prepare("UPDATE runs SET control_pending = NULL, reconcile_required_at = NULL, revision = revision + 1 WHERE id = ?")
        .run(current.id);
      return this.requireRun(id);
    });
  }

  markControlPending(id: string, control: PendingControl, now: string): Run {
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE runs SET control_pending = ?, cancel_accepted_at = ?, reconcile_required_at = ?, revision = revision + 1
           WHERE id = ?`,
        )
        .run(control, control === "cancel" ? now : null, now, id);
      return this.requireRun(id);
    });
  }

  private nextAttempt(missionId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM runs WHERE mission_id = ?").get(missionId) as Row;
    return integer(row, "attempt") + 1;
  }

  private writeMission(current: Mission, mutation: MissionMutation): void {
    const status = mutation.status ?? current.status;
    const activeRunId = mutation.activeRunId === undefined ? current.activeRunId : mutation.activeRunId ?? undefined;
    const settledAt = mutation.settledAt === undefined ? current.settledAt : mutation.settledAt ?? undefined;
    const error = mutation.error === undefined ? current.error : mutation.error ?? undefined;
    const cancelReason = mutation.cancelReason === undefined ? current.cancelReason : mutation.cancelReason ?? undefined;
    this.db
      .prepare(
        `UPDATE missions SET status = ?, revision = revision + 1, updated_at = ?, active_run_id = ?,
          settled_at = ?, error_json = ?, cancel_reason = ? WHERE id = ?`,
      )
      .run(status, mutation.updatedAt, activeRunId ?? null, settledAt ?? null, json(error), cancelReason ?? null, current.id);
  }

  private missionWithExtras(row: Row): Mission {
    const id = text(row, "id");
    return missionFromRow(row, {
      runIds: this.idsFor("runs", "mission_id", id, "attempt"),
      childIds: this.idsFor("missions", "parent_mission_id", id, "created_at"),
      artifactIds: this.idsFor("artifacts", "mission_id", id, "created_at"),
      approvalIds: this.idsFor("approvals", "mission_id", id, "requested_at"),
    });
  }

  private idsFor(table: string, column: string, value: string, order: string): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM ${table} WHERE ${column} = ? ORDER BY ${order}, id`)
      .all(value) as Row[];
    return rows.map((row) => text(row, "id"));
  }

  private appendAuthorityEvent(missionId: string, at: string, type: string, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO mission_events (event_id, mission_id, run_id, at, source, type, payload_json, adapter_seq)
         VALUES (?, ?, NULL, ?, 'authority', ?, ?, NULL)`,
      )
      .run(randomUUID(), missionId, at, type, JSON.stringify(payload));
  }
}

export function isSettled(mission: Mission): boolean {
  return isTerminalMissionStatus(mission.status);
}

function hasBookkeeping(mutation: Partial<MissionMutation>): boolean {
  return (
    mutation.activeRunId !== undefined ||
    mutation.settledAt !== undefined ||
    mutation.error !== undefined ||
    mutation.cancelReason !== undefined
  );
}
