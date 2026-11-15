/**
 * The local `core.json` document: which agent instances this core may run, and
 * which of the person's own computers it knows about.
 *
 * The schema is strict. An unknown field is refused rather than ignored,
 * because a mistyped `"tokens"` that is silently dropped would leave a person
 * believing their credential reached the engine. A missing file or directory is
 * an empty configuration, never a fabricated agent. A file that exists and does
 * not parse is an error: corrupt is not the same as absent.
 *
 * The document may name where a secret lives (`{ "env": "NAME" }`) instead of
 * carrying it, so a config file that is copied between machines need not hold
 * one. The file is written 0600 inside a 0700 directory; values are never
 * echoed in an error.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { AGENT_KINDS, AUTH_MODES, type AgentKind } from "../../packages/agent-protocol/agents.ts";
import { ALLOWED_ENV_NAMES, isBillingName, isControlPlaneName, type AuthMode } from "../agents/env.ts";
import { parseModelIdString } from "../agents/models.ts";
import { agentDescriptor } from "../agents/registry.ts";

export const CORE_CONFIG_FILE = "core.json";
export const CORE_CONFIG_VERSION = 1;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A literal secret, or the name of a host variable that holds it. */
export type SecretRef = string | { readonly env: string };

/** The one provider credential an `apiKey` instance may carry. */
export interface CoreConfigApiKey {
  readonly name: string;
  readonly value: SecretRef;
}

/** Where a `compatibleEndpoint` or `local` instance reaches its provider. */
export interface CoreConfigProvider {
  readonly baseUrl: string;
  readonly apiKeyName?: string;
  readonly apiKey?: SecretRef;
}

/** The model a session of this instance starts on when the caller names none. */
export interface CoreConfigModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
}

export interface CoreConfigAgent {
  readonly id: string;
  readonly agentId: AgentKind;
  /** Absolute path this instance's own home lives at. */
  readonly home: string;
  readonly authMode: AuthMode;
  /** `false` keeps the instance described but out of task selection. */
  readonly enabled: boolean;
  readonly cli?: string;
  /** HTTP agents only: the server this instance talks to. */
  readonly baseUrl?: string;
  readonly token?: SecretRef;
  /** Names drawn from the agent environment allowlist; nothing else. */
  readonly env?: Readonly<Record<string, string>>;
  readonly model?: CoreConfigModel;
  readonly apiKey?: CoreConfigApiKey;
  readonly provider?: CoreConfigProvider;
  /** Custom ACP agents only: argv after the executable. */
  readonly args?: readonly string[];
}

/** One of the person's own computers. It names a credential handle, never key material. */
export interface CoreConfigEnvironment {
  readonly id: string;
  readonly label: string;
  readonly kind: "ssh" | "local";
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly authMode: AuthMode;
  readonly credentialRef?: string;
  readonly baseUrl?: string;
  readonly hostKeyFingerprint?: string;
}

export interface CoreConfig {
  readonly version: typeof CORE_CONFIG_VERSION;
  readonly agents: readonly CoreConfigAgent[];
  readonly environments: readonly CoreConfigEnvironment[];
}

export interface LoadedCoreConfig {
  readonly config: CoreConfig;
  readonly path: string;
  /** `false` means there was no file, and the configuration is empty. */
  readonly present: boolean;
}

/** A document this module refuses. `path` is the file, never a secret's value. */
export class CoreConfigError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${path}: ${message}`);
    this.name = "CoreConfigError";
    this.path = path;
  }
}

export function emptyCoreConfig(): CoreConfig {
  return { version: CORE_CONFIG_VERSION, agents: [], environments: [] };
}

/** `$EAC_CORE_DATA_DIR/core.json` when the caller resolves the data directory that way. */
export function coreConfigPath(options: { dataDir: string; fileName?: string }): string {
  return join(options.dataDir, options.fileName ?? CORE_CONFIG_FILE);
}

/** Reads the document. An absent file or directory is empty; anything else that
 * cannot be read is an error. A file other users can read is tightened to 0600
 * before its contents are used, because it may carry a literal credential. */
export function loadCoreConfig(path: string): LoadedCoreConfig {
  if (!existsSync(path)) return { config: emptyCoreConfig(), path, present: false };
  tightenMode(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // The parser's own message can quote the text around the fault, which may be
    // the credential the person stored. The refusal says where, not what.
    throw new CoreConfigError("is not valid JSON", path);
  }
  return { config: parseCoreConfig(parsed, path), path, present: true };
}

/** Validates one document. Every field is checked here, so no later stage has
 * to trust a value it did not read. */
export function parseCoreConfig(value: unknown, source = CORE_CONFIG_FILE): CoreConfig {
  const root = objectOf(value, "the document", source);
  rejectUnknownFields(root, ["version", "agents", "environments"], "the document", source);
  if (root.version !== CORE_CONFIG_VERSION) {
    throw new CoreConfigError(
      `the document: unsupported version ${JSON.stringify(root.version)}; expected ${CORE_CONFIG_VERSION}`,
      source,
    );
  }
  const agents = arrayOf(root.agents, "agents", source).map((entry, index) =>
    parseAgent(entry, `agents[${index}]`, source),
  );
  uniqueIds(agents, "agents", source);
  const environments =
    root.environments === undefined
      ? []
      : arrayOf(root.environments, "environments", source).map((entry, index) =>
          parseEnvironment(entry, `environments[${index}]`, source),
        );
  uniqueIds(environments, "environments", source);
  return { version: CORE_CONFIG_VERSION, agents, environments };
}

/** Writes the document through a temporary file, 0600, replacing the old one in
 * place. A configuration the loader would refuse is never written. */
export function saveCoreConfig(path: string, config: CoreConfig): string {
  const text = `${JSON.stringify(plainConfig(config), null, 2)}\n`;
  parseCoreConfig(JSON.parse(text), path);
  mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", FILE_MODE);
  try {
    writeSync(fd, text, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return path;
}

/** The literal, or the named variable's value. `undefined` when the variable is
 * unset or empty, which the caller reports as a build problem rather than as an
 * anonymous failure. */
export function resolveSecret(ref: SecretRef, env: Record<string, string | undefined>): string | undefined {
  if (typeof ref === "string") return ref === "" ? undefined : ref;
  const value = env[ref.env];
  return value === undefined || value === "" ? undefined : value;
}

/** What a person can read about a secret's location: a variable name or a
 * description of the literal, never the literal. */
export function describeSecretRef(ref: SecretRef): string {
  return typeof ref === "string" ? "the literal in core.json" : `environment variable ${ref.env}`;
}

function parseAgent(value: unknown, where: string, source: string): CoreConfigAgent {
  const entry = objectOf(value, where, source);
  rejectUnknownFields(
    entry,
    ["id", "agentId", "home", "authMode", "enabled", "cli", "baseUrl", "token", "env", "model", "apiKey", "provider", "args"],
    where,
    source,
  );
  const id = nonEmptyString(entry.id, `${where}.id`, source);
  const agentId = agentKindOf(entry.agentId, `${where}.agentId`, source);
  const home = nonEmptyString(entry.home, `${where}.home`, source);
  if (!isAbsolute(home)) fail(`${where}.home`, "must be an absolute path", source);
  const authMode = authModeOf(entry.authMode, `${where}.authMode`, source);
  const enabled = entry.enabled === undefined ? true : booleanOf(entry.enabled, `${where}.enabled`, source);
  const cli = optionalNonEmptyString(entry.cli, `${where}.cli`, source);
  const baseUrl = optionalHttpUrl(entry.baseUrl, `${where}.baseUrl`, source);
  const token = entry.token === undefined ? undefined : parseSecretRef(entry.token, `${where}.token`, source);
  const env = parseEnv(entry.env, where, source, agentId);
  const model = entry.model === undefined ? undefined : parseModel(entry.model, `${where}.model`, source);
  const apiKey = entry.apiKey === undefined ? undefined : parseApiKey(entry.apiKey, `${where}.apiKey`, source);
  const provider = entry.provider === undefined ? undefined : parseProvider(entry.provider, `${where}.provider`, source);
  const args = parseArgs(entry.args, where, source, agentId);

  const http = agentId === "hermes" || agentId === "openCode";
  if (http && baseUrl === undefined) fail(`${where}.baseUrl`, `${agentId} needs the server's base URL`, source);
  if (!http && baseUrl !== undefined) fail(`${where}.baseUrl`, "is only for hermes and openCode", source);
  if (!http && token !== undefined) fail(`${where}.token`, "is only for hermes and openCode; use apiKey or provider", source);
  if (http && cli !== undefined) fail(`${where}.cli`, "is not used by an HTTP agent", source);
  if (agentId === "hermes" && token === undefined) {
    fail(`${where}.token`, 'hermes needs a bearer token or { "env": "NAME" }', source);
  }
  if (agentId === "custom" && cli === undefined) fail(`${where}.cli`, "a custom ACP agent needs its executable", source);

  if (authMode === "subscription" && (apiKey !== undefined || provider !== undefined)) {
    fail(where, 'a subscription instance carries no apiKey or provider; use authMode "apiKey" or "compatibleEndpoint"', source);
  }
  if (authMode === "apiKey" && apiKey === undefined) fail(`${where}.apiKey`, 'is required when authMode is "apiKey"', source);
  if (authMode === "apiKey" && provider !== undefined) fail(`${where}.provider`, 'belongs to "compatibleEndpoint" or "local"', source);
  if (authMode === "compatibleEndpoint" && provider === undefined) {
    fail(`${where}.provider`, 'is required when authMode is "compatibleEndpoint"', source);
  }
  if ((authMode === "compatibleEndpoint" || authMode === "local") && apiKey !== undefined) {
    fail(`${where}.apiKey`, 'belongs to authMode "apiKey"; name the credential inside provider', source);
  }
  if (authMode === "local" && provider !== undefined && (provider.apiKeyName !== undefined || provider.apiKey !== undefined)) {
    fail(`${where}.provider`, "a local endpoint carries no credential", source);
  }

  return {
    id,
    agentId,
    home,
    authMode,
    enabled,
    ...(cli !== undefined ? { cli } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(args !== undefined ? { args } : {}),
  };
}

function parseEnvironment(value: unknown, where: string, source: string): CoreConfigEnvironment {
  const entry = objectOf(value, where, source);
  rejectUnknownFields(
    entry,
    ["id", "label", "kind", "host", "port", "user", "authMode", "credentialRef", "baseUrl", "hostKeyFingerprint"],
    where,
    source,
  );
  const id = nonEmptyString(entry.id, `${where}.id`, source);
  const label = nonEmptyString(entry.label, `${where}.label`, source);
  const kind = oneOf(entry.kind, ["ssh", "local"] as const, `${where}.kind`, source);
  const authMode = authModeOf(entry.authMode, `${where}.authMode`, source);
  const host = optionalNonEmptyString(entry.host, `${where}.host`, source);
  const user = optionalNonEmptyString(entry.user, `${where}.user`, source);
  const baseUrl = optionalHttpUrl(entry.baseUrl, `${where}.baseUrl`, source);
  const credentialRef = optionalNonEmptyString(entry.credentialRef, `${where}.credentialRef`, source);
  const hostKeyFingerprint = optionalNonEmptyString(entry.hostKeyFingerprint, `${where}.hostKeyFingerprint`, source);
  let port: number | undefined;
  if (entry.port !== undefined) {
    port = entry.port as number;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) fail(`${where}.port`, "must be an integer between 1 and 65535", source);
  }

  if (kind === "ssh" && (host === undefined || user === undefined)) {
    fail(where, "an ssh computer needs a host and a user", source);
  }
  if (kind === "local" && baseUrl === undefined) fail(`${where}.baseUrl`, "a local computer needs the address it answers on", source);
  if (kind === "local" && port !== undefined) fail(`${where}.port`, "belongs to an ssh computer", source);
  if (authMode === "apiKey" && credentialRef === undefined) {
    fail(`${where}.credentialRef`, 'is required when authMode is "apiKey"', source);
  }

  return {
    id,
    label,
    kind,
    authMode,
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(credentialRef !== undefined ? { credentialRef } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(hostKeyFingerprint !== undefined ? { hostKeyFingerprint } : {}),
  };
}

function parseEnv(
  value: unknown,
  where: string,
  source: string,
  agentId: AgentKind,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const env = objectOf(value, `${where}.env`, source);
  const homeEnv = agentDescriptor(agentId).homeEnv;
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(env)) {
    const at = `${where}.env.${name}`;
    if (!ENV_NAME.test(name)) fail(at, "is not an environment variable name", source);
    if (isControlPlaneName(name)) fail(at, "is a control-plane secret and never reaches an agent", source);
    if (isBillingName(name)) fail(at, "names a provider credential; use apiKey or provider instead", source);
    if (!ALLOWED_ENV_NAMES.includes(name)) fail(at, "is not in the agent environment allowlist", source);
    if (name === "HOME" || name === homeEnv) fail(at, "is set from this instance's home field", source);
    if (typeof raw !== "string" || raw === "") fail(at, "must be a non-empty string", source);
    result[name] = raw;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseModel(value: unknown, where: string, source: string): CoreConfigModel {
  if (typeof value === "string") {
    const parsed = parseModelIdString(value);
    if (!parsed) fail(where, 'must be "provider/model" or an object with providerId and modelId', source);
    return parsed;
  }
  const entry = objectOf(value, where, source);
  rejectUnknownFields(entry, ["providerId", "modelId", "variant"], where, source);
  return {
    providerId: nonEmptyString(entry.providerId, `${where}.providerId`, source),
    modelId: nonEmptyString(entry.modelId, `${where}.modelId`, source),
    ...(entry.variant === undefined ? {} : { variant: nonEmptyString(entry.variant, `${where}.variant`, source) }),
  };
}

function parseApiKey(value: unknown, where: string, source: string): CoreConfigApiKey {
  const entry = objectOf(value, where, source);
  rejectUnknownFields(entry, ["name", "value"], where, source);
  const name = credentialName(entry.name, `${where}.name`, source);
  return { name, value: parseSecretRef(entry.value, `${where}.value`, source) };
}

function parseProvider(value: unknown, where: string, source: string): CoreConfigProvider {
  const entry = objectOf(value, where, source);
  rejectUnknownFields(entry, ["baseUrl", "apiKeyName", "apiKey"], where, source);
  const baseUrl = httpUrl(entry.baseUrl, `${where}.baseUrl`, source);
  const apiKeyName = entry.apiKeyName === undefined ? undefined : credentialName(entry.apiKeyName, `${where}.apiKeyName`, source);
  const apiKey = entry.apiKey === undefined ? undefined : parseSecretRef(entry.apiKey, `${where}.apiKey`, source);
  if (apiKeyName !== undefined && apiKey === undefined) {
    fail(`${where}.apiKey`, `is required when apiKeyName names ${apiKeyName}`, source);
  }
  if (apiKey !== undefined && apiKeyName === undefined) fail(`${where}.apiKeyName`, "is required when apiKey is given", source);
  return { baseUrl, ...(apiKeyName !== undefined ? { apiKeyName } : {}), ...(apiKey !== undefined ? { apiKey } : {}) };
}

function parseSecretRef(value: unknown, where: string, source: string): SecretRef {
  if (typeof value === "string") {
    if (value === "") fail(where, "must not be empty", source);
    return value;
  }
  const entry = objectOf(value, where, source);
  rejectUnknownFields(entry, ["env"], where, source);
  const name = nonEmptyString(entry.env, `${where}.env`, source);
  if (!ENV_NAME.test(name)) fail(`${where}.env`, "is not an environment variable name", source);
  return { env: name };
}

function parseArgs(value: unknown, where: string, source: string, agentId: AgentKind): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (agentId !== "custom") fail(`${where}.args`, "is only for a custom ACP agent", source);
  return arrayOf(value, `${where}.args`, source).map((arg, index) => nonEmptyString(arg, `${where}.args[${index}]`, source));
}

function plainConfig(config: CoreConfig): Record<string, unknown> {
  return {
    version: config.version,
    agents: config.agents.map((agent) => ({
      id: agent.id,
      agentId: agent.agentId,
      home: agent.home,
      authMode: agent.authMode,
      ...(agent.enabled ? {} : { enabled: false }),
      ...(agent.cli !== undefined ? { cli: agent.cli } : {}),
      ...(agent.baseUrl !== undefined ? { baseUrl: agent.baseUrl } : {}),
      ...(agent.token !== undefined ? { token: agent.token } : {}),
      ...(agent.env !== undefined ? { env: agent.env } : {}),
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.apiKey !== undefined ? { apiKey: agent.apiKey } : {}),
      ...(agent.provider !== undefined ? { provider: agent.provider } : {}),
      ...(agent.args !== undefined ? { args: agent.args } : {}),
    })),
    environments: config.environments.map((environment) => ({ ...environment })),
  };
}

function uniqueIds(entries: readonly { readonly id: string }[], where: string, source: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) fail(where, `has two entries with id ${JSON.stringify(entry.id)}`, source);
    seen.add(entry.id);
  }
}

function credentialName(value: unknown, where: string, source: string): string {
  const name = nonEmptyString(value, where, source);
  if (!isBillingName(name)) fail(where, `${name} is not a provider credential name`, source);
  return name;
}

function agentKindOf(value: unknown, where: string, source: string): AgentKind {
  return oneOf(value, AGENT_KINDS, where, source);
}

function authModeOf(value: unknown, where: string, source: string): AuthMode {
  return oneOf(value, AUTH_MODES, where, source);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string, source: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(where, `must be one of ${allowed.join(", ")}`, source);
  }
  return value as T;
}

function objectOf(value: unknown, where: string, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(where, "must be an object", source);
  return value as Record<string, unknown>;
}

function arrayOf(value: unknown, where: string, source: string): unknown[] {
  if (!Array.isArray(value)) fail(where, "must be an array", source);
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  source: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(where, `has unknown field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`, source);
}

function nonEmptyString(value: unknown, where: string, source: string): string {
  if (typeof value !== "string" || value === "") fail(where, "must be a non-empty string", source);
  return value;
}

function optionalNonEmptyString(value: unknown, where: string, source: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, where, source);
}

function booleanOf(value: unknown, where: string, source: string): boolean {
  if (typeof value !== "boolean") fail(where, "must be a boolean", source);
  return value;
}

function optionalHttpUrl(value: unknown, where: string, source: string): string | undefined {
  return value === undefined ? undefined : httpUrl(value, where, source);
}

function httpUrl(value: unknown, where: string, source: string): string {
  const text = nonEmptyString(value, where, source);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    fail(where, "must be an absolute http or https URL", source);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(where, "must be an absolute http or https URL", source);
  return text;
}

function fail(where: string, message: string, source: string): never {
  throw new CoreConfigError(`${where}: ${message}`, source);
}

/** A file a person wrote by hand may be group- or world-readable. It is narrowed
 * rather than refused: the credential in it is still the one they meant to use. */
function tightenMode(path: string): void {
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // A filesystem without Unix modes (or one where this user cannot chmod) is
    // not a reason to refuse to start.
  }
}
