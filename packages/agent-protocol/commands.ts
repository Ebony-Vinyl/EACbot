import type { AgentKind, ModelRef } from "./agents.ts";
import type { EnvironmentRef } from "./environment.ts";
import type { ReconcileAction } from "./run.ts";

/** Every mutation carries a caller-chosen command id. Replaying the same id
 * returns the original outcome instead of acting twice. */
export interface CommandEnvelope {
  readonly commandId: string;
  readonly issuedAt?: string;
}

export interface RevisionedCommand extends CommandEnvelope {
  readonly expectedRevision: number;
}

export interface CreateMissionCommand extends CommandEnvelope {
  readonly type: "mission.create";
  readonly title: string;
  readonly prompt: string;
  readonly agent: AgentKind;
  readonly model?: ModelRef;
  readonly environment: EnvironmentRef;
  readonly parentMissionId?: string;
}

export interface SteerRunCommand extends CommandEnvelope {
  readonly type: "run.steer";
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly input: string;
}

export interface InterruptRunCommand extends CommandEnvelope {
  readonly type: "run.interrupt";
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly reason?: string;
}

export interface ResumeMissionCommand extends CommandEnvelope {
  readonly type: "mission.resume";
  readonly missionId: string;
  readonly expectedRevision: number;
}

export interface SubmitInputCommand extends CommandEnvelope {
  readonly type: "run.submit_input";
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly input: string;
}

export interface ResolveApprovalCommand extends CommandEnvelope {
  readonly type: "approval.resolve";
  readonly missionId: string;
  readonly approvalId: string;
  readonly expectedRevision: number;
  readonly decision: "allow" | "deny" | "answer";
  readonly answer?: string;
  readonly by?: string;
}

export interface CancelMissionCommand extends CommandEnvelope {
  readonly type: "mission.cancel";
  readonly missionId: string;
  readonly expectedRevision: number;
  readonly reason?: string;
  readonly cascade?: boolean;
}

/** The only way a restart finishes work it found in limbo. Nothing is replayed
 * on its own: a caller names the run and the action. */
export interface ReconcileRunCommand extends CommandEnvelope {
  readonly type: "run.reconcile";
  readonly missionId: string;
  readonly runId: string;
  readonly expectedRevision: number;
  readonly action: ReconcileAction;
  readonly reason?: string;
}

export type MissionCommand =
  | CreateMissionCommand
  | SteerRunCommand
  | InterruptRunCommand
  | ResumeMissionCommand
  | SubmitInputCommand
  | ResolveApprovalCommand
  | CancelMissionCommand
  | ReconcileRunCommand;

export type CommandType = MissionCommand["type"];

export const COMMAND_TYPES = [
  "mission.create",
  "run.steer",
  "run.interrupt",
  "mission.resume",
  "run.submit_input",
  "approval.resolve",
  "mission.cancel",
  "run.reconcile",
] as const satisfies readonly CommandType[];

/** A stored command outcome. `replayed` distinguishes a fresh application from
 * an idempotent replay, so a caller can tell it was not run twice. */
export interface CommandResult {
  readonly commandId: string;
  readonly type: CommandType;
  readonly missionId: string;
  readonly appliedAt: string;
  readonly missionRevision: number;
  readonly replayed: boolean;
  readonly runId?: string;
  readonly affectedMissionIds?: readonly string[];
  /** Runs that were live when the command applied, so the caller can stop the
   * native side after the durable state already says cancelled. */
  readonly affectedRunIds?: readonly string[];
}

export interface CommandRecord {
  readonly commandId: string;
  readonly type: CommandType;
  readonly missionId: string;
  readonly appliedAt: string;
  readonly result: CommandResult;
  readonly requestHash: string;
}

export const COMMAND_ERROR_CODES = [
  "not_found",
  "revision_conflict",
  "illegal_transition",
  "capability_missing",
  "invalid_request",
  "command_conflict",
  "already_settled",
  "native_start_failed",
] as const;

export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];

export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly status: number;
  readonly currentRevision?: number;

  constructor(code: CommandErrorCode, message: string, currentRevision?: number) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.status = statusFor(code);
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
  }
}

function statusFor(code: CommandErrorCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "revision_conflict":
      return 409;
    case "illegal_transition":
      return 409;
    case "command_conflict":
      return 409;
    case "capability_missing":
      return 422;
    case "invalid_request":
      return 400;
    case "already_settled":
      return 409;
    case "native_start_failed":
      return 502;
  }
}
