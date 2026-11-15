/**
 * The data shapes and action signatures every screen in this feature uses.
 *
 * Screens take data as props. That keeps a screen a pure function of what it
 * was given: a test hands it an error, an unauthorized answer or a stale
 * revision without a transport, and `foundation.ts` is the only place that
 * knows how a request is actually made.
 */
import type { ModelCatalogEntry } from "../../../packages/agent-protocol/agents.ts";
import type { CommandResult } from "../../../packages/agent-protocol/commands.ts";
import type { MissionLogEntry } from "../../../packages/agent-protocol/events.ts";

/** Four states, because a screen must tell "still asking" from "the server
 * refused us" from "it failed" without reading a message. */
export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "unauthorized" }
  | { readonly status: "error"; readonly message: string; readonly retry: () => void }
  | { readonly status: "ready"; readonly data: T; readonly refresh: () => void };

export interface HistoryPage {
  readonly events: readonly MissionLogEntry[];
  readonly nextSeq: number;
}

export interface AgentModels {
  readonly models: readonly ModelCatalogEntry[];
  readonly reported: boolean;
}

export interface EnvironmentTestResult {
  readonly reachable: boolean;
  readonly latencyMs?: number;
  readonly detail?: string;
  readonly checkedAt: string;
}

export interface EnvironmentRecord {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyFingerprint?: string;
  readonly status?: string;
  readonly lastTest?: EnvironmentTestResult;
}

/** Connection facts only: this application owns its known-hosts file and an
 * agent instance owns its sign-in mode. */
export interface NewEnvironment {
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyFingerprint: string;
}

/** A notification from the server: a hint that something moved, never the
 * move itself. */
export interface LiveNotification {
  readonly kind: string;
  readonly missionId?: string;
  readonly runId?: string;
  readonly revision?: number;
}

export interface MissionCommandInput {
  /** Decided by the caller so a retry of one intent is one command. */
  readonly commandId: string;
  /** The revision the person was looking at. */
  readonly expectedRevision: number;
}

export interface ApprovalInput extends MissionCommandInput {
  readonly missionId: string;
  readonly approvalId: string;
  readonly decision: "allow" | "deny" | "answer";
  readonly answer?: string;
}

export interface ReconcileInput extends MissionCommandInput {
  readonly runId: string;
  readonly action: "start" | "resume" | "cancel" | "abandon";
  readonly reason?: string;
}

/** The computer a task runs on, plus the sign-in mode of the agent instance
 * that runs there. The authority requires all four fields. */
export interface MissionEnvironment {
  readonly id: string;
  readonly label: string;
  readonly kind: "ssh" | "local";
  readonly authMode: "subscription" | "apiKey" | "compatibleEndpoint" | "local";
}

export interface CreateMissionInput {
  readonly commandId: string;
  readonly title: string;
  readonly prompt: string;
  readonly agent: string;
  readonly model?: { readonly agent: string; readonly model: string; readonly effort?: string; readonly variant?: string; readonly label?: string };
  readonly environment: MissionEnvironment;
  readonly parentMissionId?: string;
}

export interface CancelOptions {
  readonly cascade?: boolean;
  readonly reason?: string;
}

/** What a screen calls when a person acts. Every method names the command and
 * the revision it saw; none reads state back, because a notification is what
 * tells a screen to refetch. */
export interface MissionActions {
  create(input: CreateMissionInput): Promise<CommandResult>;
  steer(missionId: string, input: string, command: MissionCommandInput): Promise<CommandResult>;
  interrupt(missionId: string, command: MissionCommandInput, reason?: string): Promise<CommandResult>;
  resume(missionId: string, command: MissionCommandInput): Promise<CommandResult>;
  cancel(missionId: string, command: MissionCommandInput, options?: CancelOptions): Promise<CommandResult>;
  submitInput(missionId: string, input: string, command: MissionCommandInput): Promise<CommandResult>;
  resolve(input: ApprovalInput): Promise<CommandResult>;
  reconcile(missionId: string, input: ReconcileInput): Promise<CommandResult>;
}

export interface EnvironmentActions {
  create(input: NewEnvironment): Promise<EnvironmentRecord>;
  test(id: string): Promise<EnvironmentTestResult>;
  /** Removes this application's record only. Nothing on the computer changes,
   * so re-adding it is how a changed host key gets confirmed. */
  remove(id: string): Promise<void>;
}

/** A stable id for one attempt at one action. Foundation generates command ids
 * the same way; this exists so a screen can build one for a retry. */
export function newCommandId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random !== undefined) return random;
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
