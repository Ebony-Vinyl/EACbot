import type { AgentAdapter } from "../../packages/agent-protocol/adapter.ts";
import type { AgentKind } from "../../packages/agent-protocol/agents.ts";
import type { CommandResult, MissionCommand } from "../../packages/agent-protocol/commands.ts";
import { CommandError } from "../../packages/agent-protocol/commands.ts";
import type { AdapterEvent } from "../../packages/agent-protocol/events.ts";
import type { Mission } from "../../packages/agent-protocol/mission.ts";
import { isTerminalMissionStatus } from "../../packages/agent-protocol/mission-status.ts";
import type { PendingControl, ReconcileAction } from "../../packages/agent-protocol/run.ts";
import { isTerminalRunStatus, type Run } from "../../packages/agent-protocol/run.ts";
import { capabilitiesFor } from "./capabilities.ts";
import { CommandRegistry } from "./command-registry.ts";
import { executeCommand } from "./command-service.ts";
import { openDatabase, type Database } from "./db.ts";
import { EventLog } from "./event-log.ts";
import { ingestAdapterEvent, type IngestResult, type MissionContext } from "./ingest.ts";
import { RecordStore } from "./records.ts";
import { MissionStore } from "./store.ts";

export interface MissionRuntimeOptions {
  readonly databasePath: string;
  readonly adapters: (kind: AgentKind) => AgentAdapter | undefined;
  readonly now?: () => string;
  readonly onError?: (error: unknown, context: string) => void;
}

/** A run whose native side the authority cannot vouch for. `pendingControl`
 * means a cancel or interrupt was recorded durably but never confirmed, so a
 * native session may still be alive. `unstarted` means the run was accepted
 * and never started. Neither is replayed on its own. */
export interface LimboRun {
  readonly run: Run;
  readonly missionId: string;
  readonly reason: "unstarted" | "cancellation_pending" | "interruption_pending" | "start_unknown";
  readonly allowedActions: readonly ReconcileAction[];
}

/** What a restarted process reads back without touching a native agent. */
export interface RecoveryReport {
  readonly openMissions: readonly Mission[];
  /** Runs accepted but never started. They need an explicit `start`. */
  readonly unstartedRuns: readonly Run[];
  /** Runs interrupted with a native session, resumable by an explicit resume. */
  readonly interruptedRuns: readonly Run[];
  /** Everything a restart must hand to a person or a reconcile command. */
  readonly limboRuns: readonly LimboRun[];
}

export class MissionRuntime {
  readonly store: MissionStore;
  readonly log: EventLog;
  readonly records: RecordStore;
  readonly registry: CommandRegistry;
  private readonly db: Database;
  private readonly options: MissionRuntimeOptions;
  private readonly context: MissionContext;

  constructor(options: MissionRuntimeOptions) {
    this.options = options;
    this.db = openDatabase(options.databasePath);
    this.store = new MissionStore(this.db);
    this.log = new EventLog(this.db);
    this.records = new RecordStore(this.db);
    this.registry = new CommandRegistry(this.db);
    this.context = {
      db: this.db,
      store: this.store,
      log: this.log,
      records: this.records,
      registry: this.registry,
      now: options.now ?? (() => new Date().toISOString()),
      capabilitiesFor,
    };
  }

  get contextValue(): MissionContext {
    return this.context;
  }

  /** Runs the command, then starts or controls the native work it accepted.
   * The durable record is already committed, so a native failure is recorded
   * as a typed run failure instead of leaving the mission running forever. */
  async execute(command: MissionCommand): Promise<CommandResult> {
    const result = executeCommand(this.context, command);
    if (result.replayed) return result;

    switch (command.type) {
      case "mission.create": {
        const run = this.store.latestRun(result.missionId);
        if (run) await this.startNative(result.missionId, run);
        break;
      }
      case "mission.resume": {
        const run = result.runId ? this.store.getRun(result.runId) : undefined;
        if (run) await this.resumeNative(result.missionId, run);
        break;
      }
      case "run.steer": {
        if (result.runId) await this.dispatchSteer(result.runId, command.input, command.commandId);
        break;
      }
      case "run.interrupt": {
        if (result.runId) await this.dispatchInterrupt(result.runId, command.reason);
        break;
      }
      case "mission.cancel": {
        for (const runId of result.affectedRunIds ?? []) await this.dispatchCancel(runId, command.reason);
        break;
      }
      case "run.reconcile": {
        await this.reconcile(command.missionId, command.runId, command.action, command.reason);
        break;
      }
      default:
        break;
    }
    return result;
  }

  ingest(event: AdapterEvent): IngestResult {
    return ingestAdapterEvent(this.context, event);
  }

  /** Everything a restarted process can read back. Nothing here is replayed:
   * `limboRuns` names what a caller must reconcile.
   *
   * A pending control is reported for every mission, including one whose
   * durable status already says cancelled: that is exactly the case where a
   * native session may still be alive. */
  recover(): RecoveryReport {
    const all = this.store.listMissions();
    const openMissions = all.filter((mission) => !isTerminalMissionStatus(mission.status));
    const unstartedRuns: Run[] = [];
    const interruptedRuns: Run[] = [];
    const limboRuns: LimboRun[] = [];

    for (const mission of all) {
      const isOpen = !isTerminalMissionStatus(mission.status);
      for (const run of this.store.runsFor(mission.id)) {
        if (run.controlPending === "cancel") {
          limboRuns.push({ run, missionId: mission.id, reason: "cancellation_pending", allowedActions: ["cancel", "abandon"] });
        }
        if (run.controlPending === "interrupt") {
          limboRuns.push({ run, missionId: mission.id, reason: "interruption_pending", allowedActions: ["cancel", "abandon"] });
        }
        if (!isOpen || isTerminalRunStatus(run.status)) continue;
        if (run.status === "accepted" && run.nativeStartedAt === undefined) {
          unstartedRuns.push(run);
          limboRuns.push({ run, missionId: mission.id, reason: "unstarted", allowedActions: ["start", "abandon"] });
        }
        if (run.status === "interrupted" && run.nativeSessionId !== undefined && run.controlPending === undefined) {
          interruptedRuns.push(run);
        }
      }
    }
    return { openMissions, unstartedRuns, interruptedRuns, limboRuns };
  }

  /** Reads the whole tree back from disk: missions, runs and the event log. */
  readTree(rootMissionId: string) {
    return {
      tree: this.store.missionTree(rootMissionId),
      runs: this.store.listMissions(rootMissionId).flatMap((mission) => this.store.runsFor(mission.id)),
      events: this.log.treeEvents(rootMissionId, { limit: 10_000 }),
    };
  }

  close(): void {
    this.store.close();
  }

  /** The only path that acts on a run a restart left in limbo. `start` and
   * `resume` launch native work the caller explicitly asked for; `cancel`
   * retries a recorded cancellation; `abandon` settles the run as failed so
   * nothing is replayed by accident. */
  private async reconcile(missionId: string, runId: string, action: ReconcileAction, reason?: string): Promise<void> {
    const run = this.store.requireRun(runId);
    const mission = this.store.requireMission(missionId);
    const now = this.context.now();

    switch (action) {
      case "start": {
        if (run.nativeStartedAt !== undefined) {
          throw new CommandError("invalid_request", "the run already started once");
        }
        await this.startNative(missionId, run);
        return;
      }
      case "resume": {
        if (run.nativeSessionId === undefined) {
          throw new CommandError("invalid_request", "the run kept no native session to resume");
        }
        this.store.clearControlPending(run.id);
        this.store.updateRun(run.id, { status: "resuming" });
        this.store.applyAuthorityStatus(mission.id, "resuming", now, { activeRunId: run.id });
        await this.resumeNative(missionId, run);
        return;
      }
      case "cancel": {
        this.store.clearControlPending(run.id);
        this.store.updateRun(run.id, { status: "cancelled", nativeCompletedAt: now, nativeOutcome: "cancelled" });
        this.store.applyAuthorityStatus(mission.id, "cancelled", now, {
          settledAt: now,
          activeRunId: null,
          ...(reason !== undefined ? { cancelReason: reason } : {}),
        });
        this.log.appendAuthorityEvent(mission.id, "run.reconciled", { runId: run.id, action, reason: reason ?? null }, now, run.id);
        await this.dispatchCancel(run.id, reason);
        return;
      }
      case "abandon": {
        this.store.clearControlPending(run.id);
        this.store.updateRun(run.id, {
          status: "failed",
          nativeCompletedAt: now,
          nativeOutcome: "failed",
          error: { code: "abandoned_after_restart", message: reason ?? "a restart abandoned this run" },
        });
        this.store.applyAuthorityStatus(mission.id, "failed", now, {
          settledAt: now,
          activeRunId: null,
          error: { code: "abandoned_after_restart", message: reason ?? "a restart abandoned this run" },
        });
        this.log.appendAuthorityEvent(mission.id, "run.reconciled", { runId: run.id, action, reason: reason ?? null }, now, run.id);
        return;
      }
    }
  }

  private sinkFor(missionId: string): { emit(event: AdapterEvent): void } {
    return {
      emit: (event) => {
        try {
          this.ingest(event);
        } catch (error) {
          this.options.onError?.(error, `ingest ${event.type} for ${missionId}`);
        }
      },
    };
  }

  /** The durable state already says `running`; a failure here is recorded as a
   * typed run and mission failure, never swallowed. */
  private async startNative(missionId: string, run: Run): Promise<void> {
    const mission = this.store.requireMission(missionId);
    const adapter = this.requireAdapter(mission.agent);
    try {
      const handle = await adapter.start(
        {
          missionId: mission.id,
          runId: run.id,
          prompt: mission.prompt,
          ...(mission.model !== undefined ? { model: mission.model } : {}),
          environmentId: mission.environment.id,
          attempt: run.attempt,
        },
        this.sinkFor(mission.id),
      );
      this.store.updateRun(run.id, {
        status: "running",
        ...(handle.nativeSessionId !== undefined ? { nativeSessionId: handle.nativeSessionId } : {}),
      });
    } catch (error) {
      this.failNativeStart(mission, run, error);
    }
  }

  private async resumeNative(missionId: string, run: Run): Promise<void> {
    const mission = this.store.requireMission(missionId);
    const adapter = this.requireAdapter(mission.agent);
    try {
      const handle = await adapter.resume(
        {
          missionId: mission.id,
          runId: run.id,
          prompt: mission.prompt,
          ...(mission.model !== undefined ? { model: mission.model } : {}),
          environmentId: mission.environment.id,
          attempt: run.attempt,
          ...(run.nativeSessionId !== undefined ? { resumeFromSessionId: run.nativeSessionId } : {}),
          ...(run.resumeOfRunId !== undefined ? { resumeOfRunId: run.resumeOfRunId } : {}),
        },
        this.sinkFor(mission.id),
      );
      this.store.updateRun(run.id, {
        status: "running",
        ...(handle.nativeSessionId !== undefined ? { nativeSessionId: handle.nativeSessionId } : {}),
      });
    } catch (error) {
      this.failNativeStart(mission, run, error);
    }
  }

  private failNativeStart(mission: Mission, run: Run, error: unknown): void {
    const now = this.context.now();
    const message = error instanceof Error ? error.message : String(error);
    this.store.clearControlPending(run.id);
    this.store.updateRun(run.id, {
      status: "failed",
      nativeCompletedAt: now,
      nativeOutcome: "failed",
      error: { code: "native_start_failed", message },
    });
    this.store.applyAuthorityStatus(mission.id, "failed", now, {
      settledAt: now,
      activeRunId: null,
      error: { code: "native_start_failed", message },
    });
    this.log.appendAuthorityEvent(mission.id, "run.start_failed", { runId: run.id, message }, now, run.id);
    this.options.onError?.(error, `start ${mission.agent} for ${mission.id}`);
  }

  private async dispatchSteer(runId: string, input: string, commandId: string): Promise<void> {
    const run = this.store.requireRun(runId);
    const mission = this.store.requireMission(run.missionId);
    const adapter = this.requireAdapter(mission.agent);
    try {
      const outcome = await adapter.steer(runId, input, commandId);
      if (!outcome.accepted) {
        this.log.appendAuthorityEvent(mission.id, "run.steer_refused", { runId, commandId, reason: outcome.reason ?? null }, this.context.now(), runId);
      }
    } catch (error) {
      this.options.onError?.(error, `steer ${runId}`);
      this.log.appendAuthorityEvent(mission.id, "run.steer_failed", { runId, commandId, message: describe(error) }, this.context.now(), runId);
    }
  }

  private async dispatchInterrupt(runId: string, reason?: string): Promise<void> {
    const run = this.store.requireRun(runId);
    const mission = this.store.requireMission(run.missionId);
    const adapter = this.requireAdapter(mission.agent);
    try {
      await adapter.interrupt(runId, reason);
      this.store.clearControlPending(run.id);
    } catch (error) {
      this.options.onError?.(error, `interrupt ${runId}`);
      this.markControlPending(run, "interrupt", error);
    }
  }

  private async dispatchCancel(runId: string, reason?: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) return;
    const mission = this.store.getMission(run.missionId);
    if (!mission) return;
    try {
      await this.requireAdapter(mission.agent).cancel(run.id, reason);
      this.store.clearControlPending(run.id);
    } catch (error) {
      this.options.onError?.(error, `cancel ${runId}`);
      this.markControlPending(run, "cancel", error);
    }
  }

  /** Records that a control action's native effect is unconfirmed, so a
   * restart reports it instead of forgetting a possibly live session. */
  private markControlPending(run: Run, control: PendingControl, error: unknown): void {
    const now = this.context.now();
    this.store.markControlPending(run.id, control, now);
    this.log.appendAuthorityEvent(run.missionId, "run.control_pending", { runId: run.id, control, message: describe(error) }, now, run.id);
  }

  private requireAdapter(kind: AgentKind): AgentAdapter {
    const adapter = this.options.adapters(kind);
    if (!adapter) throw new CommandError("capability_missing", `no adapter registered for ${kind}`);
    return adapter;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
