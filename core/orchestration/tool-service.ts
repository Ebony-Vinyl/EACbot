import { randomUUID } from "node:crypto";

import type { AgentCapabilities, AgentKind } from "../../packages/agent-protocol/agents.ts";
import { AGENT_KINDS } from "../../packages/agent-protocol/agents.ts";
import { APPROVAL_STATUSES, type Approval } from "../../packages/agent-protocol/artifact.ts";
import type { MissionCommand } from "../../packages/agent-protocol/commands.ts";
import { assertEnvironmentRef } from "../../packages/agent-protocol/guards.ts";
import type { Mission } from "../../packages/agent-protocol/mission.ts";
import { MISSION_STATUSES } from "../../packages/agent-protocol/mission-status.ts";
import { isTerminalRunStatus, type Run } from "../../packages/agent-protocol/run.ts";
import { TERMINAL_KINDS, type TerminalKind } from "../../packages/agent-protocol/terminal.ts";
import { agentDescriptor } from "../agents/registry.ts";
import { capabilitiesFor } from "../missions/capabilities.ts";
import type { MissionRuntime } from "../missions/runtime.ts";
import {
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringArray,
  readArguments,
  rejectUnknownKeys,
  requireEnum,
  requireInteger,
  requireObject,
  requireString,
  type ToolArguments,
} from "./args.ts";
import { assertNoConversationArguments, briefTitle, renderBrief, validateBrief } from "./brief.ts";
import { toErrorBody, ToolError } from "./errors.ts";
import { parseEnvironment, parseModel, steerOutcomeOf } from "./inputs.ts";
import { isToolName, TOOL_SCHEMA_LIST, toolSchema, type ToolSchema } from "./schemas.ts";
import {
  assertMayCreateRoot,
  assertMissionInScope,
  assertNoAuthorityArguments,
  assertNoSecretArguments,
  assertPathNotSecret,
  assertRootInScope,
  assertWritable,
  isAgentKind,
  verifyScopedToken,
  type ScopedTokenClaims,
  type TokenSigner,
} from "./scope.ts";
import { mintTerminalTicket, TERMINAL_ROLES, type TerminalRole } from "./tickets.ts";
import { ackView, approvalView, missionView, runView } from "./views.ts";
import type {
  AgentView,
  ArtifactView,
  CommandAckView,
  CreateMissionView,
  InstallStatus,
  ListAgentsView,
  ListApprovalsView,
  ListMissionsView,
  MissionStatusView,
  MissionView,
  ModelStatus,
  ResolveApprovalView,
  SteerResultView,
  TerminalRequestView,
  ToolName,
  ToolOutcome,
} from "./types.ts";

/** What the tool layer needs from the rest of the server. Everything here is
 * injected, so a test drives the real service against a fake runtime. */
export interface ToolServiceOptions {
  readonly runtime: MissionRuntime;
  readonly signer: TokenSigner;
  readonly now: () => string;
  /** The lifetime the terminal layer will honour for a ticket. */
  readonly ticketTtlMs?: number;
  /** Probes one agent's own model catalog. Absent means `unprobed`, never a
   * guessed list. */
  readonly probeModels?: (agent: AgentKind) => Promise<ModelStatus>;
  /** What this process knows about an engine's install. Absent means `unknown`. */
  readonly installStatus?: (agent: AgentKind) => InstallStatus;
}

const DEFAULT_TICKET_TTL_MS = 120_000;
const DEFAULT_MISSION_LIMIT = 50;
const MAX_MISSION_LIMIT = 200;
const DEFAULT_EVENT_LIMIT = 10;
const MAX_EVENT_LIMIT = 100;

const CREATE_ALLOWED = ["commandId", "agent", "model", "environment", "brief", "parentMissionId"] as const;
const STEER_ALLOWED = ["commandId", "missionId", "expectedRevision", "input"] as const;
const INTERRUPT_ALLOWED = ["commandId", "missionId", "expectedRevision", "reason"] as const;
const RESUME_ALLOWED = ["commandId", "missionId", "expectedRevision"] as const;
const CANCEL_ALLOWED = ["commandId", "missionId", "expectedRevision", "reason", "cascade"] as const;
const STATUS_ALLOWED = ["missionId", "eventLimit"] as const;
const APPROVALS_ALLOWED = ["missionId", "status"] as const;
const ANSWER_ALLOWED = ["commandId", "missionId", "expectedRevision", "approvalId", "decision", "answer"] as const;
const TERMINAL_ALLOWED = ["missionId", "runId", "kind", "role"] as const;
const ARTIFACT_ALLOWED = ["artifactId", "missionId"] as const;
const LIST_MISSIONS_ALLOWED = ["rootMissionId", "status", "limit"] as const;
const LIST_AGENTS_ALLOWED = ["agents", "probeModels"] as const;

/** A handler's answer plus the command id it actually used and whether the
 * command layer replayed an earlier application of it. A generated id is
 * reported, so a caller can replay or correlate the call it did not name. */
interface Handled<T> {
  readonly data: T;
  readonly replayed: boolean;
  readonly commandId?: string;
}

function fresh<T>(data: T): Handled<T> {
  return { data, replayed: false };
}

function applied<T>(data: T, commandId: string, replayed: boolean): Handled<T> {
  return { data, replayed, commandId };
}

/** Transport-independent orchestration tools. It maps a tool call to a
 * `MissionRuntime` command, checks a scoped token first, and returns a stable
 * JSON envelope. It speaks no MCP and opens no stream. */
export class ToolService {
  readonly #runtime: MissionRuntime;
  readonly #signer: TokenSigner;
  readonly #now: () => string;
  readonly #ticketTtlMs: number;
  readonly #probeModels: ((agent: AgentKind) => Promise<ModelStatus>) | undefined;
  readonly #installStatus: ((agent: AgentKind) => InstallStatus) | undefined;

  constructor(options: ToolServiceOptions) {
    this.#runtime = options.runtime;
    this.#signer = options.signer;
    this.#now = options.now;
    this.#ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
    this.#probeModels = options.probeModels;
    this.#installStatus = options.installStatus;
  }

  /** The tool catalogue as data. It is the same list `call` dispatches on, so a
   * schema and its handler cannot drift. */
  listTools(): readonly ToolSchema[] {
    return TOOL_SCHEMA_LIST;
  }

  /** Verifies a raw scoped token, then runs the call. This is the entry point a
   * transport uses: the token is the only thing that establishes authority, and
   * it is checked before any tool reads its arguments. */
  async callWithToken(tool: string, args: unknown, token: string): Promise<ToolOutcome<unknown>> {
    let scope: ScopedTokenClaims;
    try {
      scope = verifyScopedToken(this.#signer, token, this.#now);
    } catch (error) {
      const named: ToolName | undefined = isToolName(tool) ? tool : undefined;
      const suppliedCommandId = commandIdOf(args);
      return {
        ok: false,
        tool: named ?? "list_agents",
        ...(suppliedCommandId !== undefined ? { commandId: suppliedCommandId } : {}),
        error: toErrorBody(error),
      };
    }
    return this.call(tool, args, scope);
  }

  /** Runs one tool call for an already-verified credential. A refusal is a
   * value, not an exception, so a transport has one shape to serialize. */
  async call(tool: string, args: unknown, scope: ScopedTokenClaims): Promise<ToolOutcome<unknown>> {
    const named: ToolName | undefined = isToolName(tool) ? tool : undefined;
    const suppliedCommandId = commandIdOf(args);
    try {
      if (named === undefined) throw new ToolError("unknown_tool", `no tool named "${tool}"`);
      assertNoConversationArguments(readArguments(args).raw);
      assertNoAuthorityArguments(args, declaredTopLevelKeys(named));
      assertNoSecretArguments(args);
      const parsed = readArguments(args);
      const handled = await this.#dispatch(named, parsed, scope);
      const commandId = handled.commandId ?? suppliedCommandId;
      return {
        ok: true,
        tool: named,
        ...(commandId !== undefined ? { commandId } : {}),
        replayed: handled.replayed,
        data: handled.data,
      };
    } catch (error) {
      return {
        ok: false,
        tool: named ?? "list_agents",
        ...(suppliedCommandId !== undefined ? { commandId: suppliedCommandId } : {}),
        error: toErrorBody(error),
      };
    }
  }

  async #dispatch(tool: ToolName, args: ToolArguments, scope: ScopedTokenClaims): Promise<Handled<unknown>> {
    switch (tool) {
      case "list_agents":
        return fresh(await this.#listAgents(args));
      case "list_missions":
        return fresh(this.#listMissions(args, scope));
      case "create_mission":
        return this.#createMission(args, scope);
      case "steer_run":
        return this.#steerRun(args, scope);
      case "interrupt_run":
        return this.#interruptRun(args, scope);
      case "resume_mission":
        return this.#resumeMission(args, scope);
      case "cancel_mission":
        return this.#cancelMission(args, scope);
      case "mission_status":
        return fresh(this.#missionStatus(args, scope));
      case "list_approvals":
        return fresh(this.#listApprovals(args, scope));
      case "answer_approval":
        return this.#answerApproval(args, scope);
      case "open_terminal":
        return fresh(this.#openTerminal(args, scope));
      case "get_artifact":
        return fresh(this.#getArtifact(args, scope));
    }
  }

  async #listAgents(args: ToolArguments): Promise<ListAgentsView> {
    rejectUnknownKeys(args, LIST_AGENTS_ALLOWED);
    const wanted = optionalStringArray(args, "agents", AGENT_KINDS);
    const probe = optionalBoolean(args, "probeModels") ?? false;
    const kinds = wanted && wanted.length > 0 ? wanted.filter(isAgentKind) : AGENT_KINDS;
    const agents: AgentView[] = [];
    for (const agent of kinds) agents.push(await this.#agentView(agent, probe));
    return { agents };
  }

  async #agentView(agent: AgentKind, probe: boolean): Promise<AgentView> {
    const descriptor = agentDescriptor(agent);
    const capabilities = agentCapabilities(agent);
    const install: InstallStatus = this.#installStatus
      ? this.#installStatus(agent)
      : { state: "unknown", reason: "this process does not probe installed engines" };

    let models: ModelStatus;
    if (!capabilities.modelCatalog) {
      models = { state: "none", reason: `${descriptor.displayName} reports no model catalog; pass a model explicitly` };
    } else if (!probe) {
      models = { state: "unprobed", reason: "model probing was not requested; set probeModels to read the engine's own catalog" };
    } else if (!this.#probeModels) {
      models = { state: "unprobed", reason: "this process has no catalog probe" };
    } else {
      models = await this.#probeModels(agent);
    }

    const vendorInstaller = descriptor.install.vendorInstaller;
    return {
      agent,
      displayName: descriptor.displayName,
      transport: descriptor.transport,
      install: {
        docsUrl: descriptor.install.docsUrl,
        ...(descriptor.install.npmPackage !== undefined ? { npmPackage: descriptor.install.npmPackage } : {}),
        ...(vendorInstaller !== undefined ? { vendorInstaller } : {}),
        ...(descriptor.install.signInCommand !== undefined ? { signInCommand: descriptor.install.signInCommand } : {}),
        ...(descriptor.install.needsNode !== undefined ? { needsNode: descriptor.install.needsNode } : {}),
      },
      installStatus: install,
      capabilities,
      models,
      authModes: descriptor.authModes,
      ...(descriptor.note !== undefined ? { note: descriptor.note } : {}),
    };
  }

  #listMissions(args: ToolArguments, scope: ScopedTokenClaims): ListMissionsView {
    rejectUnknownKeys(args, LIST_MISSIONS_ALLOWED);
    const rootMissionId = optionalString(args, "rootMissionId");
    if (rootMissionId !== undefined) assertRootInScope(scope, rootMissionId);
    const statuses = optionalStringArray(args, "status", MISSION_STATUSES);
    const limit = optionalInteger(args, "limit", 1, MAX_MISSION_LIMIT) ?? DEFAULT_MISSION_LIMIT;

    const pool = rootMissionId !== undefined
      ? this.#runtime.store.listMissions(rootMissionId)
      : scope.rootMissionIds === "all"
        ? this.#runtime.store.listMissions()
        : scope.rootMissionIds.flatMap((root) => this.#runtime.store.listMissions(root));

    const inScope = pool.filter((mission) => missionInScope(scope, mission));
    const filtered = statuses && statuses.length > 0 ? inScope.filter((mission) => statuses.includes(mission.status)) : inScope;
    const ordered = [...filtered].sort((left, right) => {
      if (left.updatedAt === right.updatedAt) return left.id < right.id ? 1 : -1;
      return left.updatedAt < right.updatedAt ? 1 : -1;
    });
    return {
      missions: ordered.slice(0, limit).map((mission) => this.#missionView(mission)),
      truncated: ordered.length > limit,
    };
  }

  async #createMission(args: ToolArguments, scope: ScopedTokenClaims): Promise<Handled<CreateMissionView>> {
    assertWritable(scope, "create_mission");
    rejectUnknownKeys(args, CREATE_ALLOWED);
    const commandId = optionalString(args, "commandId") ?? `tool-${randomUUID()}`;
    const agent = requireEnum(args, "agent", AGENT_KINDS);
    const brief = validateBrief(requireObject(args, "brief"));
    const environment = parseEnvironment(requireObject(args, "environment"));
    assertEnvironmentRef(environment);

    const parentMissionId = optionalString(args, "parentMissionId");
    if (parentMissionId === undefined) {
      assertMayCreateRoot(scope);
    } else {
      const parent = this.#runtime.store.getMission(parentMissionId);
      if (!parent) throw new ToolError("not_found", `no mission ${parentMissionId}`);
      assertMissionInScope(scope, parent);
    }

    const model = parseModel(args, agent);
    const command: MissionCommand = {
      type: "mission.create",
      commandId,
      title: briefTitle(brief),
      prompt: renderBrief(brief),
      agent,
      environment,
      ...(model !== undefined ? { model } : {}),
      ...(parentMissionId !== undefined ? { parentMissionId } : {}),
    };
    const result = await this.#runtime.execute(command);
    const mission = this.#runtime.store.requireMission(result.missionId);
    assertMissionInScope(scope, mission);
    const run = this.#runtime.store.latestRun(mission.id);
    return applied(
      {
        missionId: mission.id,
        runId: run?.id ?? "",
        revision: mission.revision,
        status: mission.status,
        title: mission.title,
        agent: mission.agent,
        permissionLevel: brief.permissionLevel,
      },
      commandId,
      result.replayed,
    );
  }

  async #steerRun(args: ToolArguments, scope: ScopedTokenClaims): Promise<Handled<SteerResultView>> {
    assertWritable(scope, "steer_run");
    rejectUnknownKeys(args, STEER_ALLOWED);
    const mission = this.#requireScopedMission(args, scope);
    const revision = requireInteger(args, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    const input = requireString(args, "input", 20_000);
    const commandId = optionalString(args, "commandId") ?? `tool-${randomUUID()}`;

    const run = mission.activeRunId ? this.#runtime.store.getRun(mission.activeRunId) : undefined;
    if (!run || isTerminalRunStatus(run.status)) {
      throw new ToolError("already_settled", "the mission has no live run to steer");
    }
    const capability = capabilitiesFor(mission.agent).steer;
    if (capability.kind === "none") {
      throw new ToolError("unsupported", capability.reason, { details: { agent: mission.agent } });
    }

    const result = await this.#runtime.execute({
      type: "run.steer",
      commandId,
      missionId: mission.id,
      expectedRevision: revision,
      input,
    });
    const runId = result.runId ?? run.id;
    const outcome = steerOutcomeOf(this.#runtime, mission.id, runId);
    return applied(
      {
        missionId: mission.id,
        runId,
        outcome: outcome.outcome,
        delivery: capability.kind === "native" ? "native" : "next-boundary",
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      },
      commandId,
      result.replayed,
    );
  }

  async #interruptRun(args: ToolArguments, scope: ScopedTokenClaims): Promise<Handled<CommandAckView>> {
    assertWritable(scope, "interrupt_run");
    rejectUnknownKeys(args, INTERRUPT_ALLOWED);
    const mission = this.#requireScopedMission(args, scope);
    const revision = requireInteger(args, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    const reason = optionalString(args, "reason", 1_000);
    const commandId = optionalString(args, "commandId") ?? `tool-${randomUUID()}`;

    if (!capabilitiesFor(mission.agent).interrupt) {
      throw new ToolError("unsupported", `${mission.agent} has no interrupt`, { details: { agent: mission.agent } });
    }
    const result = await this.#runtime.execute({
      type: "run.interrupt",
      commandId,
      missionId: mission.id,
      expectedRevision: revision,
      ...(reason !== undefined ? { reason } : {}),
    });
    return applied(ackView(result), commandId, result.replayed);
  }

  async #resumeMission(args: ToolArguments, scope: ScopedTokenClaims): Promise<Handled<CommandAckView>> {
    assertWritable(scope, "resume_mission");
    rejectUnknownKeys(args, RESUME_ALLOWED);
    const mission = this.#requireScopedMission(args, scope);
    const revision = requireInteger(args, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    const commandId = optionalString(args, "commandId") ?? `tool-${randomUUID()}`;

    if (mission.status !== "interrupted") {
      throw new ToolError("not_resumable", `mission ${mission.id} is ${mission.status}; only an interrupted mission resumes`);
    }
    if (!capabilitiesFor(mission.agent).resume) {
      throw new ToolError("unsupported", `${mission.agent} has no resume`, { details: { agent: mission.agent } });
    }
    const previous = this.#runtime.store.latestRun(mission.id);
    if (!previous?.nativeSessionId) {
      throw new ToolError("not_resumable", "the interrupted run kept no native session to resume");
    }
    const result = await this.#runtime.execute({
      type: "mission.resume",
      commandId,
      missionId: mission.id,
      expectedRevision: revision,
    });
    return applied(ackView(result), commandId, result.replayed);
  }

  async #cancelMission(args: ToolArguments, scope: ScopedTokenClaims): Promise<Handled<CommandAckView>> {
    assertWritable(scope, "cancel_mission");
    rejectUnknownKeys(args, CANCEL_ALLOWED);
    const mission = this.#requireScopedMission(args, scope);
    const revision = requireInteger(args, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    const reason = optionalString(args, "reason", 1_000);
    const cascade = optionalBoolean(args, "cascade");
    const commandId = optionalString(args, "commandId") ?? `tool-${randomUUID()}`;

    if (cascade !== false) {
      for (const child of this.#runtime.store.descendantsOf(mission.id)) assertMissionInScope(scope, child);
    }
    const result = await this.#runtime.execute({
      type: "mission.cancel",
      commandId,
      missionId: mission.id,
      expectedRevision: revision,
      ...(reason !== undefined ? { reason } : {}),
      ...(cascade !== undefined ? { cascade } : {}),
    });
    return applied(ackView(result), commandId, result.replayed);
  }

  #missionStatus(args: ToolArguments, scope: ScopedTokenClaims): MissionStatusView {
    rejectUnknownKeys(args, STATUS_ALLOWED);
    const mission = this.#requireScopedMission(args, scope);
    const eventLimit = optionalInteger(args, "eventLimit", 0, MAX_EVENT_LIMIT) ?? DEFAULT_EVENT_LIMIT;
    const latest = this.#runtime.store.latestRun(mission.id);
    const events = this.#runtime.log.events(mission.id, { limit: eventLimit });
    return {
      mission: this.#missionView(mission),
      ...(latest !== undefined ? { latestRun: runView(latest) } : {}),
      pendingApprovals: this.#runtime.records.countPendingApprovals(mission.id),
      recentEvents: events.map((entry) => ({ seq: entry.seq, type: entry.type, at: entry.at })),
    };
  }

  #listApprovals(args: ToolArguments, scope: ScopedTokenClaims): ListApprovalsView {
    rejectUnknownKeys(args, APPROVALS_ALLOWED);
    const missionId = optionalString(args, "missionId");
    const statuses = optionalStringArray(args, "status", APPROVAL_STATUSES);
    const pool: Approval[] = missionId !== undefined
      ? this.#runtime.records.approvalsFor(this.#requireScopedMission(args, scope).id)
      : this.#missionsInScope(scope).flatMap((mission) => this.#runtime.records.approvalsFor(mission.id));
    const filtered = statuses && statuses.length > 0 ? pool.filter((approval) => statuses.includes(approval.status)) : pool;
    return { approvals: filtered.map(approvalView) };
  }

  async #answerApproval(args: ToolArguments, scope: ScopedTokenClaims): Promise<Handled<ResolveApprovalView>> {
    assertWritable(scope, "answer_approval");
    rejectUnknownKeys(args, ANSWER_ALLOWED);
    const mission = this.#requireScopedMission(args, scope);
    const revision = requireInteger(args, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    const approvalId = requireString(args, "approvalId");
    const decision = requireEnum(args, "decision", ["allow", "deny", "answer"] as const);
    const answer = optionalString(args, "answer", 4_000);
    const commandId = optionalString(args, "commandId") ?? `tool-${randomUUID()}`;

    const approval = this.#runtime.records.getApproval(approvalId);
    if (!approval || approval.missionId !== mission.id) {
      throw new ToolError("not_found", `no approval ${approvalId} on mission ${mission.id}`);
    }
    if (approval.status !== "pending") {
      throw new ToolError("already_settled", `approval ${approvalId} is already ${approval.status}`);
    }
    if (!capabilitiesFor(mission.agent).approval) {
      throw new ToolError("unsupported", `${mission.agent} has no approvals`, { details: { agent: mission.agent } });
    }
    if (decision === "answer" && answer === undefined) {
      throw new ToolError("invalid_arguments", "decision `answer` needs an answer");
    }
    if (decision !== "answer" && answer !== undefined) {
      throw new ToolError("invalid_arguments", "an answer is only allowed with decision `answer`");
    }

    const result = await this.#runtime.execute({
      type: "approval.resolve",
      commandId,
      missionId: mission.id,
      approvalId,
      expectedRevision: revision,
      decision,
      ...(answer !== undefined ? { answer } : {}),
      by: scope.ownerId,
    });
    return applied({ approval: approvalView(this.#runtime.records.requireApproval(approvalId)) }, commandId, result.replayed);
  }

  #openTerminal(args: ToolArguments, scope: ScopedTokenClaims): TerminalRequestView {
    assertWritable(scope, "open_terminal");
    rejectUnknownKeys(args, TERMINAL_ALLOWED);
    const mission = this.#requireScopedMission(args, scope);
    const requestedRunId = optionalString(args, "runId");
    const run = requestedRunId !== undefined ? this.#runtime.store.getRun(requestedRunId) : this.#liveRun(mission);
    if (!run || run.missionId !== mission.id) {
      throw new ToolError("not_found", `no run ${requestedRunId ?? "(live)"} on mission ${mission.id}`);
    }

    const kindArg = optionalString(args, "kind");
    const terminalKind: TerminalKind = kindArg !== undefined ? requireEnum(args, "kind", TERMINAL_KINDS) : "nativeTui";
    if (terminalKind === "nativeTui" && !capabilitiesFor(mission.agent).nativeTui) {
      throw new ToolError("unsupported", `${mission.agent} has no native TUI to open`, { details: { agent: mission.agent } });
    }
    const roleArg = optionalString(args, "role");
    const role: TerminalRole = roleArg !== undefined ? requireEnum(args, "role", TERMINAL_ROLES) : "observe";

    const now = this.#now();
    const expiresAt = new Date(Date.parse(now) + this.#ticketTtlMs).toISOString();
    const ticket = mintTerminalTicket(this.#signer, {
      tokenId: scope.tokenId,
      missionId: mission.id,
      runId: run.id,
      terminalKind,
      role,
      issuedAt: now,
      expiresAt,
    });
    return {
      missionId: mission.id,
      runId: run.id,
      kind: terminalKind,
      role,
      ticket,
      expiresAt,
      note: "a request only: the terminal layer validates this ticket and opens the stream itself",
    };
  }

  #getArtifact(args: ToolArguments, scope: ScopedTokenClaims): ArtifactView {
    rejectUnknownKeys(args, ARTIFACT_ALLOWED);
    const artifactId = requireString(args, "artifactId");
    const missionId = optionalString(args, "missionId");
    const mission = this.#findArtifactMission(artifactId, missionId, scope);
    const artifact = this.#runtime.records.artifactsFor(mission.id).find((entry) => entry.id === artifactId);
    if (!artifact) throw new ToolError("not_found", `no artifact ${artifactId} on mission ${mission.id}`);
    assertPathNotSecret(artifact.path);
    return artifact;
  }

  #findArtifactMission(artifactId: string, missionId: string | undefined, scope: ScopedTokenClaims): Mission {
    if (missionId !== undefined) {
      const mission = this.#runtime.store.requireMission(missionId);
      assertMissionInScope(scope, mission);
      return mission;
    }
    for (const mission of this.#missionsInScope(scope)) {
      if (this.#runtime.records.artifactsFor(mission.id).some((entry) => entry.id === artifactId)) return mission;
    }
    throw new ToolError("not_found", `no artifact ${artifactId} in this credential's scope`);
  }

  #liveRun(mission: Mission): Run | undefined {
    const run = mission.activeRunId ? this.#runtime.store.getRun(mission.activeRunId) : undefined;
    if (run && !isTerminalRunStatus(run.status)) return run;
    return this.#runtime.store.latestRun(mission.id);
  }

  #missionsInScope(scope: ScopedTokenClaims): Mission[] {
    return this.#runtime.store.listMissions().filter((mission) => missionInScope(scope, mission));
  }

  #requireScopedMission(args: ToolArguments, scope: ScopedTokenClaims): Mission {
    const missionId = requireString(args, "missionId");
    const mission = this.#runtime.store.getMission(missionId);
    if (!mission) throw new ToolError("not_found", `no mission ${missionId}`);
    assertMissionInScope(scope, mission);
    return mission;
  }

  #missionView(mission: Mission): MissionView {
    return missionView(mission, capabilitiesFor(mission.agent));
  }
}

/** The protocol's capability row, with `modelCatalog` taken from the agent
 * registry: the registry is where an engine's own catalog surface is described,
 * and a mission authority that claimed one an engine lacks would be a lie the
 * caller acts on. */
function agentCapabilities(agent: AgentKind): AgentCapabilities {
  const base = capabilitiesFor(agent);
  return { ...base, modelCatalog: agentDescriptor(agent).capabilities.modelCatalog !== "none" };
}

function declaredTopLevelKeys(tool: ToolName): readonly string[] {
  const properties = toolSchema(tool).inputSchema.properties;
  return typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
}

function missionInScope(scope: ScopedTokenClaims, mission: Mission): boolean {
  return scope.rootMissionIds === "all" || scope.rootMissionIds.includes(mission.rootMissionId);
}

function commandIdOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>).commandId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
