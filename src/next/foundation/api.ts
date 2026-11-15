/** The workbench's `/api/v1` client, typed against `packages/agent-protocol`.
 *
 * Every mutation names a caller-chosen `commandId` and the `expectedRevision`
 * it saw, so a retried request is idempotent and a stale one is refused with
 * `revision_conflict` rather than overwriting newer work
 * (packages/agent-protocol/commands.ts, core/http/routes.ts).
 *
 * Where the protocol has no type for something the UI needs, the function
 * returns a typed `contract_missing` error instead of guessing a field. */

import type { AgentDescriptor } from "../../../packages/agent-protocol/agents.ts";
import type {
  CommandResult,
  CreateMissionCommand,
  MissionCommand,
  ResolveApprovalCommand,
} from "../../../packages/agent-protocol/commands.ts";
import type { EventPage, MissionLogEntry } from "../../../packages/agent-protocol/events.ts";
import type { Mission, MissionTreeNode } from "../../../packages/agent-protocol/mission.ts";
import type { TerminalRef } from "../../../packages/agent-protocol/terminal.ts";
import { apiClient, type ApiClient } from "./http.ts";
import { connectTerminal, type TerminalConnection, type TerminalConnectionOptions, type TerminalTicket } from "./live.ts";

export { useAuth, useApi, apiClient, claimPairing, ApiError, isApiError, type AuthState } from "./http.ts";
export { useTheme, setThemeChoice, readThemeChoice, type ThemeChoice } from "./theme.ts";
export { useLiveEvents } from "./use-live-events.ts";
export { connectTerminal, connectLiveEvents, INITIAL_TERMINAL_CREDIT } from "./live.ts";
export type { TerminalControl, TerminalReadyControl, TerminalHandlers } from "./live.ts";

export interface AgentListResponse {
  readonly agents: readonly AgentDescriptor[];
}

export interface MissionListResponse {
  readonly missions: readonly Mission[];
}

export interface MissionResponse {
  readonly mission: Mission;
}

export interface MissionTreeResponse {
  readonly tree: MissionTreeNode;
}

/** `GET /api/v1/missions/:id/history` returns the log page directly, not an
 * `EventPage`: `nextSeq` is the last entry's `seq`, or the requested cursor
 * when the page is empty. */
export interface MissionHistoryResponse {
  readonly events: readonly MissionLogEntry[];
  readonly nextSeq: number;
}

export interface MissionHistoryOptions {
  readonly sinceSeq?: number;
  readonly limit?: number;
}

export interface TerminalListResponse {
  readonly terminals: readonly TerminalRef[];
}

/** Fields a caller supplies for a new mission. `commandId` is generated here
 * unless the caller is retrying a request it already sent. */
export interface NewMission {
  readonly title: string;
  readonly prompt: string;
  readonly agent: CreateMissionCommand["agent"];
  readonly environment: CreateMissionCommand["environment"];
  readonly model?: CreateMissionCommand["model"];
  readonly parentMissionId?: string;
}

export interface MissionCommandOptions {
  readonly commandId?: string;
  readonly signal?: AbortSignal;
}

let counter = 0;

/** A command id the authority can use to make a retry idempotent. `crypto`
 * is absent in some test environments, so the fallback is still unique per
 * process. */
export function newCommandId(prefix = "wb"): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random !== undefined) return `${prefix}-${random}`;
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function client(clientOverride?: ApiClient): ApiClient {
  return clientOverride ?? apiClient();
}

export async function getAgents(clientOverride?: ApiClient): Promise<readonly AgentDescriptor[]> {
  const body = await client(clientOverride).request<AgentListResponse>("/agents");
  return body.agents;
}

export async function getMissions(clientOverride?: ApiClient): Promise<readonly Mission[]> {
  const body = await client(clientOverride).request<MissionListResponse>("/missions");
  return body.missions;
}

export async function getMission(missionId: string, clientOverride?: ApiClient): Promise<Mission> {
  const body = await client(clientOverride).request<MissionResponse>(`/missions/${encodeURIComponent(missionId)}`);
  return body.mission;
}

export async function getMissionTree(missionId: string, clientOverride?: ApiClient): Promise<MissionTreeNode> {
  const body = await client(clientOverride).request<MissionTreeResponse>(
    `/missions/${encodeURIComponent(missionId)}/tree`,
  );
  return body.tree;
}

export async function getMissionHistory(
  missionId: string,
  options: MissionHistoryOptions = {},
  clientOverride?: ApiClient,
): Promise<MissionHistoryResponse> {
  const body = await client(clientOverride).request<MissionHistoryResponse>(
    `/missions/${encodeURIComponent(missionId)}/history`,
    {
      query: {
        ...(options.sinceSeq !== undefined ? { since: options.sinceSeq } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      },
    },
  );
  return body;
}

/** The history endpoint's page shape, when a caller wants the protocol's
 * `EventPage` (it carries `hasMore`, which the route does not send yet). */
export function asEventPage(page: MissionHistoryResponse): EventPage {
  return { events: page.events, nextSeq: page.nextSeq, hasMore: page.events.length > 0 };
}

export async function createMission(input: NewMission, options: MissionCommandOptions = {}): Promise<CommandResult> {
  const command: CreateMissionCommand = {
    type: "mission.create",
    commandId: options.commandId ?? newCommandId("create"),
    title: input.title,
    prompt: input.prompt,
    agent: input.agent,
    environment: input.environment,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.parentMissionId !== undefined ? { parentMissionId: input.parentMissionId } : {}),
  };
  return run(command, options);
}

export async function steerMission(
  missionId: string,
  expectedRevision: number,
  input: string,
  options: MissionCommandOptions = {},
): Promise<CommandResult> {
  return run(
    { type: "run.steer", missionId, expectedRevision, input, commandId: options.commandId ?? newCommandId("steer") },
    options,
  );
}

export async function interruptMission(
  missionId: string,
  expectedRevision: number,
  options: MissionCommandOptions & { readonly reason?: string } = {},
): Promise<CommandResult> {
  return run(
    {
      type: "run.interrupt",
      missionId,
      expectedRevision,
      commandId: options.commandId ?? newCommandId("interrupt"),
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
    },
    options,
  );
}

export async function resumeMission(
  missionId: string,
  expectedRevision: number,
  options: MissionCommandOptions = {},
): Promise<CommandResult> {
  return run(
    { type: "mission.resume", missionId, expectedRevision, commandId: options.commandId ?? newCommandId("resume") },
    options,
  );
}

export async function cancelMission(
  missionId: string,
  expectedRevision: number,
  options: MissionCommandOptions & { readonly reason?: string; readonly cascade?: boolean } = {},
): Promise<CommandResult> {
  return run(
    {
      type: "mission.cancel",
      missionId,
      expectedRevision,
      commandId: options.commandId ?? newCommandId("cancel"),
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.cascade !== undefined ? { cascade: options.cascade } : {}),
    },
    options,
  );
}

export async function submitMissionInput(
  missionId: string,
  expectedRevision: number,
  input: string,
  options: MissionCommandOptions = {},
): Promise<CommandResult> {
  return run(
    {
      type: "run.submit_input",
      missionId,
      expectedRevision,
      input,
      commandId: options.commandId ?? newCommandId("input"),
    },
    options,
  );
}

export async function resolveApproval(
  missionId: string,
  approvalId: string,
  expectedRevision: number,
  decision: ResolveApprovalCommand["decision"],
  options: MissionCommandOptions & { readonly answer?: string; readonly by?: string } = {},
): Promise<CommandResult> {
  return run(
    {
      type: "approval.resolve",
      missionId,
      approvalId,
      expectedRevision,
      decision,
      commandId: options.commandId ?? newCommandId("approval"),
      ...(options.answer !== undefined ? { answer: options.answer } : {}),
      ...(options.by !== undefined ? { by: options.by } : {}),
    },
    options,
  );
}

export async function getTerminals(clientOverride?: ApiClient): Promise<readonly TerminalRef[]> {
  const body = await client(clientOverride).request<TerminalListResponse>("/terminals");
  return body.terminals;
}

/** A single-use ticket for one terminal's stream. A `WebSocket` constructor
 * cannot set an Authorization header, so the ticket goes in the query string
 * and is bound to this terminal and this session. */
export async function getTerminalTicket(
  terminalId: string,
  clientOverride?: ApiClient,
): Promise<TerminalTicket> {
  return client(clientOverride).request<TerminalTicket>(`/terminals/${encodeURIComponent(terminalId)}/ticket`, {
    method: "POST",
    body: {},
  });
}

export type { TerminalConnection, TerminalConnectionOptions, TerminalTicket };

export { connectTerminal as openTerminal };

async function run(command: MissionCommand, options: MissionCommandOptions): Promise<CommandResult> {
  const path = pathFor(command);
  return apiClient().request<CommandResult>(path, {
    method: "POST",
    // The route carries the mission and approval ids; the command type is the
    // route's own choice. The server refuses any body field its table does not
    // name, so only the command's arguments travel here.
    body: commandBody(command),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

/** The fields a command handler accepts beyond its path. */
function commandBody(command: MissionCommand): Record<string, unknown> {
  const body: Record<string, unknown> = { ...command };
  delete body.type;
  delete body.missionId;
  delete body.approvalId;
  return body;
}

/** The route a command posts to. The mission id is in the path for every
 * command that names one, and the body repeats it so the authority can refuse
 * a mismatch. */
export function pathFor(command: MissionCommand): string {
  if (command.type === "mission.create") return "/missions";
  const mission = encodeURIComponent(command.missionId);
  switch (command.type) {
    case "run.steer":
      return `/missions/${mission}/steer`;
    case "run.interrupt":
      return `/missions/${mission}/interrupt`;
    case "mission.resume":
      return `/missions/${mission}/resume`;
    case "mission.cancel":
      return `/missions/${mission}/cancel`;
    case "run.submit_input":
      return `/missions/${mission}/input`;
    case "approval.resolve":
      return `/missions/${mission}/approvals/${encodeURIComponent(command.approvalId)}/resolve`;
    case "run.reconcile":
      return `/missions/${mission}/reconcile`;
  }
}
