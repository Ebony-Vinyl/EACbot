import type { AgentKind } from "../../packages/agent-protocol/agents.ts";
import { AGENT_KINDS } from "../../packages/agent-protocol/agents.ts";
import type { CommandResult, MissionCommand } from "../../packages/agent-protocol/commands.ts";
import type { CredentialRef } from "../../packages/agent-protocol/environment.ts";
import { RECONCILE_ACTIONS } from "../../packages/agent-protocol/run.ts";
import { EnvironmentError } from "../environments/errors.ts";
import type { IdentityService } from "../identity/service.ts";
import { PERMISSION_SCOPES, type PermissionScope } from "../identity/scopes.ts";
import { readJsonBody } from "./body.ts";
import type { RequestContext } from "./context.ts";
import { ApiError, notFound } from "./errors.ts";
import type { AgentCatalogPort, EnvironmentPort, MissionPort, TerminalPort } from "./ports.ts";
import type { Router } from "./router.ts";
import { optionalBoolean, optionalInteger, optionalString, rejectUnknownFields, requireInteger, requireObject, requireOneOf, requireString } from "./validate.ts";

export interface RouteDeps {
  readonly router: Router;
  readonly missions: MissionPort;
  readonly agents: AgentCatalogPort;
  readonly environments: EnvironmentPort;
  readonly terminals: TerminalPort;
  readonly identity: IdentityService;
  readonly now: () => string;
  /** The event cursor a client can use to tell whether it is up to date. */
  readonly cursor: () => number;
  readonly version: string;
  readonly startedAt: string;
}

const READ: PermissionScope = "readonly";
const DEVICE: PermissionScope = "device";
const OWNER: PermissionScope = "owner";

export function registerRoutes(deps: RouteDeps): void {
  const { router } = deps;
  registerHealth(deps, router);
  registerPairing(deps, router);
  registerAgents(deps, router);
  registerMissions(deps, router);
  registerEnvironments(deps, router);
  registerTerminals(deps, router);
  registerSessions(deps, router);
}

function registerHealth(deps: RouteDeps, router: Router): void {
  router.get("/api/v1/health", READ, () => ({
    status: 200,
    body: {
      status: "ok",
      version: deps.version,
      startedAt: deps.startedAt,
      now: deps.now(),
      cursor: deps.cursor(),
      pairing: deps.identity.activePairing() !== undefined,
    },
  }), "public");

  /** EventSource cannot set an Authorization header. The browser trades its
   * bearer for a short-lived, single-use ticket it puts in the stream's query;
   * the bearer itself never enters a URL or a log. */
  router.post("/api/v1/events/ticket", READ, (context) => {
    const caller = context.caller;
    if (!caller) throw new ApiError("unauthenticated", "a session is required", 401);
    const issued = deps.identity.issueTicket(caller, "events");
    return {
      status: 201,
      body: {
        ticket: issued.ticket,
        expiresAt: new Date(issued.expiresAt).toISOString(),
        path: "/api/v1/events",
      },
    };
  });
}

function registerPairing(deps: RouteDeps, router: Router): void {
  /** Pairing is how a new device gets in at all, so it cannot require a
   * session. It is gated by the code, which only the local terminal printed. */
  router.post("/api/v1/pairing/claim", READ, async (context) => {
    const body = requireObject(await readJsonBody(context.req));
    rejectUnknownFields(body, ["code", "label", "scope"]);
    const code = requireString(body, "code", { maxLength: 64 });
    const label = requireString(body, "label", { maxLength: 120 });
    const issued = deps.identity.pair({
      code,
      label,
      loopback: context.loopback,
      ...(body.scope !== undefined ? { requestedScope: requireOneOf(body, "scope", PERMISSION_SCOPES) } : {}),
    });
    return {
      status: 201,
      body: {
        token: issued.token,
        session: {
          id: issued.session.id,
          label: issued.session.label,
          scope: issued.session.scope,
          expiresAt: new Date(issued.session.expiresAt).toISOString(),
        },
      },
    };
  }, "public");
}

function registerAgents(deps: RouteDeps, router: Router): void {
  router.get("/api/v1/agents", READ, () => ({
    status: 200,
    body: { agents: deps.agents.list() },
  }));

  router.get("/api/v1/agents/:kind", READ, (context) => {
    const kind = parseAgentKind(context.params.kind);
    const descriptor = deps.agents.get(kind);
    if (!descriptor) throw notFound(`no agent ${kind}`);
    return { status: 200, body: { agent: descriptor } };
  });

  router.get("/api/v1/agents/:kind/models", READ, (context) => {
    const kind = parseAgentKind(context.params.kind);
    const descriptor = deps.agents.get(kind);
    if (!descriptor) throw notFound(`no agent ${kind}`);
    const models = deps.agents.models(kind);
    if (models === undefined) {
      return { status: 200, body: { agent: kind, models: [], reported: false } };
    }
    return { status: 200, body: { agent: kind, models, reported: true } };
  });
}

function registerMissions(deps: RouteDeps, router: Router): void {
  router.post("/api/v1/missions", DEVICE, async (context) => {
    const result = await runCommand(context, deps, "mission.create");
    return { status: result.replayed ? 200 : 201, body: result };
  });

  router.get("/api/v1/missions", READ, () => ({
    status: 200,
    body: { missions: deps.missions.listMissions() },
  }));

  router.get("/api/v1/missions/:missionId", READ, (context) => {
    const mission = deps.missions.getMission(context.params.missionId as string);
    if (!mission) throw notFound("no such mission");
    return { status: 200, body: { mission } };
  });

  router.get("/api/v1/missions/:missionId/tree", READ, (context) => {
    const missionId = context.params.missionId as string;
    const tree = deps.missions.missionTree(missionId);
    if (!tree) throw notFound("no such mission");
    return { status: 200, body: { tree } };
  });

  router.get("/api/v1/missions/:missionId/history", READ, (context) => {
    const missionId = context.params.missionId as string;
    if (!deps.missions.getMission(missionId)) throw notFound("no such mission");
    const sinceSeq = queryInteger(context, "since");
    const limit = queryInteger(context, "limit");
    const events = deps.missions.events(missionId, {
      ...(sinceSeq !== undefined ? { sinceSeq } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { status: 200, body: { events, nextSeq: events.length > 0 ? (events[events.length - 1] as { seq: number }).seq : (sinceSeq ?? 0) } };
  });

  router.post("/api/v1/missions/:missionId/steer", DEVICE, async (context) => {
    const result = await runCommand(context, deps, "run.steer");
    return { status: 200, body: result };
  });

  router.post("/api/v1/missions/:missionId/interrupt", DEVICE, async (context) => {
    const result = await runCommand(context, deps, "run.interrupt");
    return { status: 200, body: result };
  });

  router.post("/api/v1/missions/:missionId/resume", DEVICE, async (context) => {
    const result = await runCommand(context, deps, "mission.resume");
    return { status: 200, body: result };
  });

  router.post("/api/v1/missions/:missionId/cancel", DEVICE, async (context) => {
    const result = await runCommand(context, deps, "mission.cancel");
    return { status: 200, body: result };
  });

  router.post("/api/v1/missions/:missionId/input", DEVICE, async (context) => {
    const result = await runCommand(context, deps, "run.submit_input");
    return { status: 200, body: result };
  });

  router.post("/api/v1/missions/:missionId/approvals/:approvalId/resolve", DEVICE, async (context) => {
    const result = await runCommand(context, deps, "approval.resolve");
    return { status: 200, body: result };
  });

  router.post("/api/v1/missions/:missionId/reconcile", DEVICE, async (context) => {
    const result = await runCommand(context, deps, "run.reconcile");
    return { status: 200, body: result };
  });
}

/** Every mutation ends here: the command goes to the authority, and only after
 * it is durably applied does a notification go out. A notification is a hint
 * to refetch, so publishing before the write would point a client at a
 * snapshot that does not show the change yet. */
async function runCommand(
  context: RequestContext,
  deps: RouteDeps,
  type: CommandType,
): Promise<CommandResult> {
  const result = await deps.missions.execute(await missionCommand(context, type));
  context.publish({
    kind: type === "approval.resolve" ? "approval.updated" : "mission.updated",
    missionId: result.missionId,
    ...(result.runId !== undefined ? { runId: result.runId } : {}),
    revision: result.missionRevision,
  });
  return result;
}

function registerEnvironments(deps: RouteDeps, router: Router): void {
  router.get("/api/v1/environments", READ, () => ({
    status: 200,
    body: {
      environments: deps.environments.list().map((environment) => ({
        ...environment,
        lastTest: deps.environments.lastTest(environment.id),
      })),
    },
  }));

  /** Adding a computer pins its host key and probes it before this answers, so
   * the body carries connection facts only. A password, a private key or a
   * path to one is refused by `rejectUnknownFields` before any port sees the
   * request, and the response never echoes one. A create that fails answers
   * with the environment layer's own failure: the record may exist with the
   * status that failure earned, but nothing here reports it connected. */
  router.post("/api/v1/environments", OWNER, async (context) => {
    const body = requireObject(await readJsonBody(context.req));
    rejectUnknownFields(body, ["label", "host", "port", "user", "hostKeyFingerprint"]);
    let created;
    try {
      created = await deps.environments.create({
        label: requireString(body, "label", { maxLength: 200 }),
        host: requireString(body, "host", { maxLength: 500 }),
        user: requireString(body, "user", { maxLength: 200 }),
        hostKeyFingerprint: requireString(body, "hostKeyFingerprint", { maxLength: 200 }),
        ...optionalPort(body),
      });
    } catch (error) {
      context.publish({ kind: "environment.updated" });
      throw environmentFailure(error);
    }
    context.publish({ kind: "environment.updated" });
    return { status: 201, body: { environment: created } };
  });

  /** Runs the port's real check. A port with no transport behind it says so
   * instead of claiming reachability, and a failed check answers 200 with
   * `reachable: false` and a detail: the check ran and it observed a failure. */
  router.post("/api/v1/environments/:environmentId/test", OWNER, async (context) => {
    const environmentId = context.params.environmentId as string;
    if (!deps.environments.get(environmentId)) throw notFound("no such environment");
    const result = await deps.environments.check(environmentId);
    context.publish({ kind: "environment.updated" });
    return { status: 200, body: { environmentId, ...result } };
  });

  /** Removes this application's record only. Nothing on the computer is
   * touched, because that data is the person's and a delete cannot be undone. */
  router.delete("/api/v1/environments/:environmentId", OWNER, async (context) => {
    const environmentId = context.params.environmentId as string;
    if (!deps.environments.get(environmentId)) throw notFound("no such environment");
    await deps.environments.remove(environmentId);
    context.publish({ kind: "environment.updated" });
    return { status: 204 };
  });
}

/** An environment layer failure, as the envelope a client branches on. The
 * kind is the code, so a screen can say "the host key changed" without parsing
 * a message, and the message never carries a credential: the layer refuses to
 * hold one. */
function environmentFailure(error: unknown): unknown {
  if (!(error instanceof EnvironmentError)) return error;
  const status = ENVIRONMENT_STATUS_CODES[error.kind] ?? 500;
  return new ApiError(error.kind, error.message, status);
}

const ENVIRONMENT_STATUS_CODES: Readonly<Record<string, number>> = {
  invalidRecord: 400,
  secretInRecord: 400,
  duplicateEnvironment: 409,
  revisionConflict: 409,
  hostKeyMissing: 409,
  hostKeyChanged: 409,
  hostKeyConfirmationRequired: 409,
  fingerprintMismatch: 409,
  unsafeSshArguments: 400,
  confirmationRequired: 400,
  sshDisconnected: 502,
  sshFailed: 502,
  notNonRoot: 422,
  diskLow: 422,
  versionMismatch: 422,
  toolProbeFailed: 502,
  storeBusy: 503,
  storeCorrupt: 500,
  unknownEnvironment: 404,
  installChecksum: 500,
  installFailed: 500,
  installRolledBack: 500,
};

function registerTerminals(deps: RouteDeps, router: Router): void {
  router.get("/api/v1/terminals", READ, () => ({
    status: 200,
    body: { terminals: deps.terminals.list() },
  }));

  /** Starts the agent's own TUI on the person's computer. The terminal is a
   * view of native work, not a mission input: its id is separate from every
   * native session, and starting or closing it changes no task. */
  router.post("/api/v1/terminals", DEVICE, async (context) => {
    const body = requireObject(await readJsonBody(context.req));
    rejectUnknownFields(body, ["environmentId", "tool", "missionId", "runId", "cols", "rows", "name"]);
    const terminal = await deps.terminals.start({
      environmentId: requireString(body, "environmentId", { maxLength: 200 }),
      tool: requireOneOf(body, "tool", ["hermes", "claude", "codex", "opencode", "pi", "omp"]) as
        "hermes" | "claude" | "codex" | "opencode" | "pi" | "omp",
      ...optionalStringField(body, "missionId"),
      ...optionalStringField(body, "runId"),
      ...optionalIntegerField(body, "cols", 1, 1000),
      ...optionalIntegerField(body, "rows", 1, 1000),
      ...optionalStringField(body, "name"),
    }).catch((error: unknown) => {
      throw new ApiError(
        "terminal_unavailable",
        error instanceof Error ? error.message : "the terminal did not start",
        502,
      );
    });
    context.publish({ kind: "mission.updated" });
    return { status: 201, body: { terminal } };
  });

  router.get("/api/v1/terminals/:terminalId", READ, (context) => {
    const terminal = deps.terminals.get(context.params.terminalId as string);
    if (!terminal) throw notFound("no such terminal");
    return { status: 200, body: { terminal } };
  });

  /** A WebSocket cannot carry an Authorization header, so the browser asks
   * for a single-use ticket bound to this terminal and then upgrades with it
   * in the query string. */
  router.post("/api/v1/terminals/:terminalId/ticket", DEVICE, (context) => {
    const terminalId = context.params.terminalId as string;
    if (!deps.terminals.get(terminalId)) throw notFound("no such terminal");
    const caller = context.caller;
    if (!caller) throw new ApiError("unauthenticated", "a session is required", 401);
    const issued = deps.identity.issueTicket(caller, "terminal", terminalId);
    return {
      status: 201,
      body: {
        ticket: issued.ticket,
        expiresAt: new Date(issued.expiresAt).toISOString(),
        path: `/api/v1/terminals/${encodeURIComponent(terminalId)}/stream`,
      },
    };
  });
}

function registerSessions(deps: RouteDeps, router: Router): void {
  router.get("/api/v1/sessions", READ, () => ({
    status: 200,
    body: {
      sessions: deps.identity.listSessions().map((session) => ({
        id: session.id,
        label: session.label,
        scope: session.scope,
        createdAt: new Date(session.createdAt).toISOString(),
        lastUsedAt: new Date(session.lastUsedAt).toISOString(),
        expiresAt: new Date(session.expiresAt).toISOString(),
        ...(session.revokedAt !== undefined ? { revokedAt: new Date(session.revokedAt).toISOString() } : {}),
      })),
    },
  }));

  router.delete("/api/v1/sessions/:sessionId", DEVICE, (context) => {
    deps.identity.revokeSession(context.params.sessionId as string);
    return { status: 204 };
  });

  router.post("/api/v1/sessions/revoke-all", OWNER, () => {
    deps.identity.revokeAllSessions();
    return { status: 204 };
  });
}

type CommandType = MissionCommand["type"];

const COMMAND_FIELDS: Readonly<Record<CommandType, readonly string[]>> = {
  "mission.create": ["commandId", "title", "prompt", "agent", "model", "environment", "parentMissionId"],
  "run.steer": ["commandId", "expectedRevision", "input"],
  "run.interrupt": ["commandId", "expectedRevision", "reason"],
  "mission.resume": ["commandId", "expectedRevision"],
  "run.submit_input": ["commandId", "expectedRevision", "input"],
  "approval.resolve": ["commandId", "expectedRevision", "decision", "answer", "by"],
  "mission.cancel": ["commandId", "expectedRevision", "reason", "cascade"],
  "run.reconcile": ["commandId", "expectedRevision", "runId", "action", "reason"],
};

/** Builds the command the authority expects. The mission id and the approval
 * id come from the path, so a body cannot name a different mission than the
 * one the caller was authorised for. */
async function missionCommand(context: RequestContext, type: CommandType): Promise<MissionCommand> {
  const body = requireObject(await readJsonBody(context.req));
  rejectUnknownFields(body, COMMAND_FIELDS[type]);
  const commandId = requireString(body, "commandId", { maxLength: 200 });
  const missionId = context.params.missionId;
  const expectedRevision = needsRevision(type) ? requireInteger(body, "expectedRevision") : undefined;
  const base = { commandId, ...(expectedRevision !== undefined ? { expectedRevision } : {}) };

  switch (type) {
    case "mission.create": {
      const model = optionalModel(body);
      const parentMissionId = optionalString(body, "parentMissionId", { maxLength: 200 });
      return {
        type,
        commandId,
        title: requireString(body, "title", { maxLength: 200 }),
        prompt: requireString(body, "prompt", { maxLength: 200_000 }),
        agent: parseAgentKind(requireString(body, "agent", { maxLength: 40 })),
        environment: environmentRef(body.environment),
        ...(model !== undefined ? { model } : {}),
        ...(parentMissionId !== undefined ? { parentMissionId } : {}),
      };
    }
    case "run.steer":
    case "run.submit_input":
      return { type, ...base, missionId: requireMissionId(missionId), expectedRevision: expectedRevision as number, input: requireString(body, "input", { maxLength: 100_000 }) };
    case "run.interrupt": {
      const reason = optionalString(body, "reason", { maxLength: 1_000 });
      return { type, ...base, missionId: requireMissionId(missionId), expectedRevision: expectedRevision as number, ...(reason !== undefined ? { reason } : {}) };
    }
    case "mission.resume":
      return { type, ...base, missionId: requireMissionId(missionId), expectedRevision: expectedRevision as number };
    case "approval.resolve": {
      const decision = requireOneOf(body, "decision", ["allow", "deny", "answer"]);
      const answer = optionalString(body, "answer", { maxLength: 20_000 });
      const by = optionalString(body, "by", { maxLength: 200 });
      return {
        type,
        ...base,
        missionId: requireMissionId(missionId),
        approvalId: context.params.approvalId as string,
        expectedRevision: expectedRevision as number,
        decision,
        ...(answer !== undefined ? { answer } : {}),
        ...(by !== undefined ? { by } : {}),
      };
    }
    case "mission.cancel": {
      const reason = optionalString(body, "reason", { maxLength: 1_000 });
      const cascade = optionalBoolean(body, "cascade");
      return {
        type,
        ...base,
        missionId: requireMissionId(missionId),
        expectedRevision: expectedRevision as number,
        ...(reason !== undefined ? { reason } : {}),
        ...(cascade !== undefined ? { cascade } : {}),
      };
    }
    case "run.reconcile": {
      const reason = optionalString(body, "reason", { maxLength: 1_000 });
      return {
        type,
        ...base,
        missionId: requireMissionId(missionId),
        runId: requireString(body, "runId", { maxLength: 200 }),
        action: requireOneOf(body, "action", RECONCILE_ACTIONS),
        expectedRevision: expectedRevision as number,
        ...(reason !== undefined ? { reason } : {}),
      };
    }
  }
}

function needsRevision(type: CommandType): boolean {
  return type !== "mission.create";
}

function requireMissionId(value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new ApiError("invalid_request", "missionId is required", 400);
  return value;
}

type MissionCommandEnvironment = Extract<MissionCommand, { type: "mission.create" }>["environment"];

/** The environment a mission runs on. Only the handle fields a client owns are
 * read; a secret-bearing field is refused by `rejectUnknownFields` before the
 * mission authority ever sees the body. */
function environmentRef(value: unknown): MissionCommandEnvironment {
  const source = requireObject(value, "environment");
  rejectUnknownFields(source, ["id", "label", "kind", "host", "port", "user", "authMode", "credentialRef", "baseUrl", "hostKeyFingerprint"]);
  const credentialRef = optionalString(source, "credentialRef", { maxLength: 200 });
  return {
    id: requireString(source, "id", { maxLength: 200 }),
    label: requireString(source, "label", { maxLength: 200 }),
    kind: requireOneOf(source, "kind", ["ssh", "local"]),
    authMode: requireOneOf(source, "authMode", ["subscription", "apiKey", "compatibleEndpoint", "local"]),
    ...optionalStringField(source, "host"),
    ...optionalPort(source),
    ...optionalStringField(source, "user"),
    ...(credentialRef !== undefined ? { credentialRef: credentialRef as CredentialRef } : {}),
    ...optionalStringField(source, "baseUrl"),
    ...optionalStringField(source, "hostKeyFingerprint"),
  };
}

function optionalModel(body: Record<string, unknown>): Extract<MissionCommand, { type: "mission.create" }>["model"] | undefined {
  if (body.model === undefined) return undefined;
  const model = requireObject(body.model, "model");
  rejectUnknownFields(model, ["agent", "model", "effort", "variant", "label"]);
  const effort = optionalString(model, "effort", { maxLength: 40 });
  const variant = optionalString(model, "variant", { maxLength: 80 });
  const label = optionalString(model, "label", { maxLength: 200 });
  return {
    agent: parseAgentKind(requireString(model, "agent", { maxLength: 40 })),
    model: requireString(model, "model", { maxLength: 200 }),
    ...(effort !== undefined ? { effort } : {}),
    ...(variant !== undefined ? { variant } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

function optionalStringField<K extends string>(body: Record<string, unknown>, field: K): Partial<Record<K, string>> {
  const value = optionalString(body, field, { maxLength: 500 });
  return value !== undefined ? ({ [field]: value } as Partial<Record<K, string>>) : {};
}

function optionalIntegerField<K extends string>(
  body: Record<string, unknown>,
  field: K,
  min: number,
  max: number,
): Partial<Record<K, number>> {
  const value = optionalInteger(body, field);
  if (value === undefined) return {};
  if (value < min || value > max) throw new ApiError("invalid_request", `${field} must be ${min}..${max}`, 400);
  return { [field]: value } as Partial<Record<K, number>>;
}

function optionalPort(body: Record<string, unknown>): { port?: number } {
  if (body.port === undefined) return {};
  return { port: requireInteger(body, "port", { min: 1 }) };
}

function queryInteger(context: RequestContext, name: string): number | undefined {
  const raw = context.query.get(name);
  if (raw === null) return undefined;
  if (!/^\d{1,12}$/u.test(raw)) throw new ApiError("invalid_request", `${name} must be a non-negative integer`, 400);
  return Number(raw);
}

export function parseAgentKind(value: string): AgentKind {
  if (!(AGENT_KINDS as readonly string[]).includes(value)) throw new ApiError("invalid_request", `unknown agent ${value}`, 400);
  return value as AgentKind;
}
