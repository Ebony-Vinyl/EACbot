import { ToolError } from "./errors.ts";
import { assertNoSecretArguments, assertPathNotSecret } from "./scope.ts";

/** Who asked for the work. `ref` names a mission or an owner action, never a
 * message body: the brief carries the task, not the conversation that led to it. */
export interface BriefSource {
  readonly kind: "hermes" | "owner" | "mission";
  readonly ref?: string;
}

export const PERMISSION_LEVELS = ["read-only", "workspace-write", "execute"] as const;

/** What the delegated agent may do on the user's computer. It is a statement of
 * intent handed to the agent, and the environment enforces its own boundary;
 * a higher level here grants nothing on its own. */
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export interface BriefWorkspace {
  readonly id: string;
  readonly path?: string;
}

export interface MissionBrief {
  readonly objective: string;
  readonly doneWhen: readonly string[];
  readonly permissionLevel: PermissionLevel;
  readonly source: BriefSource;
  readonly workspace?: BriefWorkspace;
  readonly artifactIds?: readonly string[];
  readonly parentMissionId?: string;
}

/** Argument keys that would smuggle a private conversation into a mission
 * prompt. The brief is composed from structured fields only, so the whole
 * transcript a person typed to Hermes never becomes another agent's context. */
const CONVERSATION_ARGUMENT_KEYS: readonly string[] = [
  "conversation",
  "transcript",
  "messages",
  "messageHistory",
  "chatLog",
  "chatHistory",
  "history",
  "context",
  "rawConversation",
  "userMessages",
];

const MAX_OBJECTIVE = 2_000;
const MAX_CRITERION = 300;
const MAX_CRITERIA = 20;
const MAX_ARTIFACTS = 50;

const PERMISSION_TEXT: Readonly<Record<PermissionLevel, string>> = {
  "read-only": "Read and inspect only. Change no file and run no command that writes.",
  "workspace-write": "Read, and change files inside the named workspace only. Run no command that reaches outside it.",
  execute: "Read and write as the task needs, and run commands. Credentials stay in the environment; never print one.",
};

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === "string" && (PERMISSION_LEVELS as readonly string[]).includes(value);
}

/** Refuses a brief that carries a conversation rather than a task. It runs
 * before the authority scan so the caller hears why the shape is wrong, not
 * that one word inside a transcript happened to look like a grant. */
export function assertBriefArguments(args: Record<string, unknown>): void {
  assertNoConversationArguments(args);
  assertNoSecretArguments(args);
}

export function assertNoConversationArguments(args: Record<string, unknown>): void {
  assertNoConversationKeys(args, "");
  if (typeof args.brief === "object" && args.brief !== null && !Array.isArray(args.brief)) {
    assertNoConversationKeys(args.brief as Record<string, unknown>, "brief.");
  }
}

function assertNoConversationKeys(args: Record<string, unknown>, prefix: string): void {
  for (const key of CONVERSATION_ARGUMENT_KEYS) {
    if (key in args) {
      throw new ToolError(
        "invalid_arguments",
        `"${prefix}${key}" is a conversation, not a task; send a brief with objective, doneWhen and permissionLevel instead`,
      );
    }
  }
}

export function validateBrief(input: unknown): MissionBrief {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolError("invalid_arguments", "brief must be an object");
  }
  const raw = input as Record<string, unknown>;
  assertBriefArguments(raw);

  const objective = requireText(raw.objective, "brief.objective", MAX_OBJECTIVE);
  const doneWhen = requireCriteria(raw.doneWhen);
  const permissionLevel = raw.permissionLevel;
  if (!isPermissionLevel(permissionLevel)) {
    throw new ToolError(
      "invalid_arguments",
      `brief.permissionLevel must be one of ${PERMISSION_LEVELS.join(", ")}`,
    );
  }
  const source = requireSource(raw.source);

  let workspace: BriefWorkspace | undefined;
  if (raw.workspace !== undefined) {
    if (typeof raw.workspace !== "object" || raw.workspace === null || Array.isArray(raw.workspace)) {
      throw new ToolError("invalid_arguments", "brief.workspace must be an object");
    }
    const entry = raw.workspace as Record<string, unknown>;
    const id = requireText(entry.id, "brief.workspace.id", 200);
    if (entry.path !== undefined) {
      const path = requireText(entry.path, "brief.workspace.path", 1_000);
      assertPathNotSecret(path);
      workspace = { id, path };
    } else {
      workspace = { id };
    }
  }

  let artifactIds: string[] | undefined;
  if (raw.artifactIds !== undefined) {
    if (!Array.isArray(raw.artifactIds)) throw new ToolError("invalid_arguments", "brief.artifactIds must be an array");
    if (raw.artifactIds.length > MAX_ARTIFACTS) {
      throw new ToolError("invalid_arguments", `brief.artifactIds holds at most ${MAX_ARTIFACTS} ids`);
    }
    artifactIds = raw.artifactIds.map((value, index) => requireText(value, `brief.artifactIds[${index}]`, 200));
  }

  return {
    objective,
    doneWhen,
    permissionLevel,
    source,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(artifactIds !== undefined ? { artifactIds } : {}),
  };
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ToolError("invalid_arguments", `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ToolError("invalid_arguments", `${field} must not be empty`);
  if (trimmed.length > max) throw new ToolError("invalid_arguments", `${field} is longer than ${max} characters`);
  return trimmed;
}

function requireCriteria(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolError("invalid_arguments", "brief.doneWhen must be a non-empty array of completion criteria");
  }
  if (value.length > MAX_CRITERIA) {
    throw new ToolError("invalid_arguments", `brief.doneWhen holds at most ${MAX_CRITERIA} criteria`);
  }
  return value.map((entry, index) => requireText(entry, `brief.doneWhen[${index}]`, MAX_CRITERION));
}

function requireSource(value: unknown): BriefSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_arguments", "brief.source must be an object naming where the task came from");
  }
  const source = value as Record<string, unknown>;
  const kind = source.kind;
  if (kind !== "hermes" && kind !== "owner" && kind !== "mission") {
    throw new ToolError("invalid_arguments", "brief.source.kind must be hermes, owner or mission");
  }
  if (source.ref === undefined) return { kind };
  return { kind, ref: requireText(source.ref, "brief.source.ref", 200) };
}

/** The mission prompt. Every line is derived from a validated field, so the
 * rendered text cannot contain anything the caller did not name as a task
 * field, and a credential-bearing path never reaches an agent. */
export function renderBrief(brief: MissionBrief): string {
  const lines: string[] = [];
  lines.push("# Delegated task", "");
  lines.push(`Source: ${describeSource(brief.source)}`);
  lines.push("");
  lines.push("## Objective");
  lines.push(brief.objective);
  lines.push("");
  lines.push("## Done when");
  for (const criterion of brief.doneWhen) lines.push(`- ${criterion}`);
  lines.push("");
  lines.push("## Permission level");
  lines.push(`${brief.permissionLevel}: ${PERMISSION_TEXT[brief.permissionLevel]}`);
  if (brief.workspace) {
    lines.push("");
    lines.push("## Workspace");
    lines.push(brief.workspace.path ? `${brief.workspace.id} at ${brief.workspace.path}` : brief.workspace.id);
  }
  if (brief.artifactIds && brief.artifactIds.length > 0) {
    lines.push("");
    lines.push("## Referenced artifacts");
    for (const id of brief.artifactIds) lines.push(`- ${id}`);
  }
  return lines.join("\n");
}

function describeSource(source: BriefSource): string {
  if (source.kind === "hermes") return source.ref ? `Hermes (${source.ref})` : "Hermes";
  if (source.kind === "owner") return source.ref ? `the owner (${source.ref})` : "the owner";
  return source.ref ? `mission ${source.ref}` : "another mission";
}

/** A short title derived from the objective's first clause, so a mission list
 * reads without the full brief. */
export function briefTitle(brief: MissionBrief): string {
  const firstLine = brief.objective.split(/\r?\n/u, 1)[0] ?? brief.objective;
  const firstClause = firstLine.split(/(?<=[.!?;:])\s/u, 1)[0] ?? firstLine;
  const title = firstClause.trim();
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}
