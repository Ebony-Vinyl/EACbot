import type { AgentCapabilities, AgentKind, ModelRef } from "../../packages/agent-protocol/agents.ts";
import type { ApprovalStatus, Artifact, ArtifactKind } from "../../packages/agent-protocol/artifact.ts";
import type { EnvironmentKind } from "../../packages/agent-protocol/environment.ts";
import type { MissionError } from "../../packages/agent-protocol/mission.ts";
import type { MissionStatus } from "../../packages/agent-protocol/mission-status.ts";
import type { NativeOutcome, PendingControl, RunStatus } from "../../packages/agent-protocol/run.ts";
import type { TerminalKind } from "../../packages/agent-protocol/terminal.ts";
import type { ToolErrorBody } from "./errors.ts";
import type { PermissionLevel } from "./brief.ts";
import type { TerminalRole } from "./tickets.ts";

export const TOOL_NAMES = [
  "list_agents",
  "list_missions",
  "create_mission",
  "steer_run",
  "interrupt_run",
  "resume_mission",
  "cancel_mission",
  "mission_status",
  "list_approvals",
  "answer_approval",
  "open_terminal",
  "get_artifact",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Whether the engine is present on the user's computer. `unknown` is a real
 * answer: this layer never runs an installer or guesses a version. */
export type InstallStatus =
  | { readonly state: "installed"; readonly version: string }
  | { readonly state: "missing"; readonly reason: string }
  | { readonly state: "unknown"; readonly reason: string };

/** What the engine itself reports about its models. `none` means the engine has
 * no catalog surface, so a caller must be handed a model rather than shown one. */
export type ModelStatus =
  | {
      readonly state: "reported";
      readonly models: readonly { readonly model: string; readonly label?: string; readonly effort?: string }[];
      readonly defaultModel?: string;
    }
  | { readonly state: "unprobed"; readonly reason: string }
  | { readonly state: "none"; readonly reason: string };

export interface AgentInstallView {
  readonly docsUrl: string;
  readonly npmPackage?: string;
  readonly vendorInstaller?: { readonly darwin?: string; readonly linux?: string; readonly win32?: string };
  readonly signInCommand?: string;
  readonly needsNode?: boolean;
}

/** One agent a scoped credential can name. Capabilities are the engine's own,
 * so a caller sees a missing one instead of discovering it through a refusal. */
export interface AgentView {
  readonly agent: AgentKind;
  readonly displayName: string;
  readonly transport: string;
  readonly install: AgentInstallView;
  readonly installStatus: InstallStatus;
  readonly capabilities: AgentCapabilities;
  readonly models: ModelStatus;
  readonly authModes: readonly string[];
  readonly note?: string;
}

/** What a mission's current state actually permits. A false value is a refusal
 * the tool layer will also make, not a hint. */
export interface AllowedActions {
  readonly steer: "native" | "next-boundary" | "none";
  readonly interrupt: boolean;
  readonly resume: boolean;
  readonly cancel: boolean;
  readonly answerApproval: boolean;
}

export interface MissionView {
  readonly id: string;
  readonly rootMissionId: string;
  readonly parentMissionId?: string;
  readonly title: string;
  readonly agent: AgentKind;
  readonly model?: ModelRef;
  readonly status: MissionStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly acceptedAt: string;
  readonly settledAt?: string;
  readonly activeRunId?: string;
  readonly environment: { readonly id: string; readonly label: string; readonly kind: EnvironmentKind };
  readonly error?: MissionError;
  readonly cancelReason?: string;
  readonly allowed: AllowedActions;
}

export interface RunView {
  readonly id: string;
  readonly missionId: string;
  readonly attempt: number;
  readonly status: RunStatus;
  readonly revision: number;
  readonly acceptedAt: string;
  readonly nativeSessionId?: string;
  readonly nativeStartedAt?: string;
  readonly nativeCompletedAt?: string;
  readonly nativeOutcome?: NativeOutcome;
  readonly controlPending?: PendingControl;
  readonly interruptedAt?: string;
  readonly resumedAt?: string;
  readonly resumeOfRunId?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ApprovalView {
  readonly id: string;
  readonly missionId: string;
  readonly runId: string;
  readonly status: ApprovalStatus;
  readonly action: string;
  readonly detail: string;
  readonly requestedAt: string;
  readonly expiresAt?: string;
  readonly resolvedAt?: string;
  readonly decidedBy?: string;
  readonly revision: number;
}

export type ArtifactView = Artifact;

/** What the terminal layer is asked to attach. The ticket authorizes exactly
 * this mission, this run and this role, and nothing about typing. */
export interface TerminalRequestView {
  readonly missionId: string;
  readonly runId: string;
  readonly kind: TerminalKind;
  readonly role: TerminalRole;
  readonly ticket: string;
  readonly expiresAt: string;
  readonly note: string;
}

export interface MissionStatusView {
  readonly mission: MissionView;
  readonly latestRun?: RunView;
  readonly pendingApprovals: number;
  readonly recentEvents: readonly { readonly seq: number; readonly type: string; readonly at: string }[];
}

/** The three answers a steer can have. `accepted` means the engine admitted the
 * text into the live run; `delivery` says when it is read. */
export type SteerOutcomeView = "accepted" | "refused" | "indeterminate";

export interface SteerResultView {
  readonly missionId: string;
  readonly runId: string;
  readonly outcome: SteerOutcomeView;
  readonly delivery: "native" | "next-boundary";
  readonly reason?: string;
}

export interface CreateMissionView {
  readonly missionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly status: MissionStatus;
  readonly title: string;
  readonly agent: AgentKind;
  readonly permissionLevel: PermissionLevel;
}

export interface CommandAckView {
  readonly missionId: string;
  readonly commandId: string;
  readonly appliedAt: string;
  readonly revision: number;
  readonly runId?: string;
  readonly affectedMissionIds?: readonly string[];
  readonly affectedRunIds?: readonly string[];
}

export interface ListMissionsView {
  readonly missions: readonly MissionView[];
  readonly truncated: boolean;
}

export interface ListAgentsView {
  readonly agents: readonly AgentView[];
}

export interface ListApprovalsView {
  readonly approvals: readonly ApprovalView[];
}

export interface ResolveApprovalView {
  readonly approval: ApprovalView;
}

/** The stable envelope every tool returns. `ok: false` still carries the tool
 * name and the command id, so a caller can correlate a failure with a retry. */
export type ToolOutcome<T> =
  | { readonly ok: true; readonly tool: ToolName; readonly commandId?: string; readonly replayed: boolean; readonly data: T }
  | { readonly ok: false; readonly tool: ToolName; readonly commandId?: string; readonly error: ToolErrorBody };

export type { ArtifactKind };
