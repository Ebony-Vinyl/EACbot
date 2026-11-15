import { createHmac, timingSafeEqual } from "node:crypto";

import type { AgentKind } from "../../packages/agent-protocol/agents.ts";
import type { Mission } from "../../packages/agent-protocol/mission.ts";
import { findSecretFields } from "../../packages/agent-protocol/guards.ts";
import { stableStringify } from "../missions/command-registry.ts";
import { ToolError } from "./errors.ts";

/** What a token lets its holder reach. `all` is an owner-level grant; a list
 * of root mission ids reaches those trees and nothing else. */
export interface ToolScope {
  readonly ownerId: string;
  readonly rootMissionIds: readonly string[] | "all";
  readonly readOnly: boolean;
}

export interface ScopedTokenClaims extends ToolScope {
  readonly v: 1;
  readonly tokenId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const TOKEN_PREFIX = "v1";
const CLOCK_SKEW_MS = 30_000;

/** HMAC-SHA256 over canonical JSON. The secret never leaves the server, and a
 * token is only ever minted here, so a caller cannot widen its own scope. */
export class TokenSigner {
  readonly #secret: string;

  constructor(secret: string) {
    if (secret.length < 32) throw new ToolError("internal", "a signing secret needs at least 32 characters");
    this.#secret = secret;
  }

  sign(payload: Record<string, unknown>): string {
    const body = Buffer.from(stableStringify(payload), "utf8").toString("base64url");
    return `${TOKEN_PREFIX}.${body}.${this.#mac(body)}`;
  }

  verify(token: string): Record<string, unknown> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
      throw new ToolError("unauthenticated", "the credential is not a token this server minted");
    }
    const [, body, mac] = parts;
    const expected = this.#mac(body!);
    const given = Buffer.from(mac!, "utf8");
    const want = Buffer.from(expected, "utf8");
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new ToolError("unauthenticated", "the credential's signature does not verify");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    } catch {
      throw new ToolError("unauthenticated", "the credential is not readable");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ToolError("unauthenticated", "the credential is not a claims object");
    }
    return parsed as Record<string, unknown>;
  }

  #mac(body: string): string {
    return createHmac("sha256", this.#secret).update(`${TOKEN_PREFIX}.${body}`).digest("base64url");
  }
}

export function mintScopedToken(signer: TokenSigner, claims: ScopedTokenClaims): string {
  assertClaimsShape(claims);
  return signer.sign({ ...claims });
}

/** Verifies signature, shape and lifetime. Every failure is `unauthenticated`
 * so a caller cannot tell a forged token from an expired one. */
export function verifyScopedToken(signer: TokenSigner, token: string, now: () => string): ScopedTokenClaims {
  const payload = signer.verify(token);
  assertClaimsShape(payload);
  const nowMs = Date.parse(now());
  const expiresMs = Date.parse(payload.expiresAt);
  const issuedMs = Date.parse(payload.issuedAt);
  if (Number.isNaN(nowMs) || Number.isNaN(expiresMs) || Number.isNaN(issuedMs)) {
    throw new ToolError("unauthenticated", "the credential carries an unreadable lifetime");
  }
  if (expiresMs + CLOCK_SKEW_MS <= nowMs) throw new ToolError("unauthenticated", "the credential has expired");
  if (issuedMs - CLOCK_SKEW_MS > nowMs) throw new ToolError("unauthenticated", "the credential is not valid yet");
  return payload;
}

function assertClaimsShape(value: unknown): asserts value is ScopedTokenClaims {
  if (typeof value !== "object" || value === null) throw new ToolError("unauthenticated", "the credential has no claims");
  const claims = value as Record<string, unknown>;
  if (claims.v !== 1) throw new ToolError("unauthenticated", "unsupported credential version");
  if (typeof claims.tokenId !== "string" || claims.tokenId.length === 0) {
    throw new ToolError("unauthenticated", "the credential has no id");
  }
  if (typeof claims.ownerId !== "string" || claims.ownerId.length === 0) {
    throw new ToolError("unauthenticated", "the credential names no owner");
  }
  if (typeof claims.readOnly !== "boolean") throw new ToolError("unauthenticated", "the credential names no access mode");
  if (typeof claims.issuedAt !== "string" || typeof claims.expiresAt !== "string") {
    throw new ToolError("unauthenticated", "the credential carries no lifetime");
  }
  const roots = claims.rootMissionIds;
  if (roots !== "all") {
    if (!Array.isArray(roots) || roots.length === 0) {
      throw new ToolError("unauthenticated", "the credential names no mission scope");
    }
    for (const id of roots) {
      if (typeof id !== "string" || id.length === 0) throw new ToolError("unauthenticated", "a mission scope id is not a string");
    }
  }
}

/** Argument keys that would let a model restate its own authority. A tool call
 * that carries one is refused before anything reads it. */
export const AUTHORITY_ARGUMENT_KEYS: readonly string[] = [
  "token",
  "tokens",
  "accessToken",
  "access_token",
  "scopedToken",
  "authToken",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "claims",
  "subject",
  "sub",
  "owner",
  "ownerId",
  "scope",
  "scopes",
  "rootMissionIds",
  "missionIds",
  "allowedMissionIds",
  "readOnly",
  "readonly",
  "role",
  "roles",
  "permissions",
  "grant",
  "grants",
  "admin",
  "sudo",
  "elevated",
  "bypass",
  "selfAuthorize",
  "onBehalfOf",
  "impersonate",
];

/** Refuses a call that tries to supply its own authority as data. The token is
 * a transport credential; nothing in `arguments` can stand in for it.
 *
 * `declared` names the top-level fields the tool's own schema declares. A
 * declared field is validated by its handler against a fixed vocabulary, so a
 * word like `role` may be a real terminal parameter; an undeclared one never is. */
export function assertNoAuthorityArguments(value: unknown, declared: readonly string[] = [], path = ""): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAuthorityArguments(entry, declared, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    const isTopLevelDeclared = path === "" && declared.includes(key);
    if (!isTopLevelDeclared && AUTHORITY_ARGUMENT_KEYS.includes(key)) {
      throw new ToolError("scope_from_arguments_refused", `"${here}" is a credential field; a tool call cannot grant itself authority`);
    }
    assertNoAuthorityArguments(nested, declared, here);
  }
}

/** A brief or an environment reference may name where a credential lives, never
 * the credential. Enforced before anything is stored or rendered. */
export function assertNoSecretArguments(value: unknown): void {
  const found = findSecretFields(value);
  if (found.length > 0) {
    throw new ToolError("secret_refused", `secret-bearing fields are not allowed: ${found.join(", ")}`, {
      details: { fields: found },
    });
  }
}

export function assertWritable(scope: ToolScope, tool: string): void {
  if (scope.readOnly) throw new ToolError("read_only", `"${tool}" mutates state; this credential is read-only`);
}

export function assertMissionInScope(scope: ToolScope, mission: Pick<Mission, "id" | "rootMissionId">): void {
  if (scope.rootMissionIds === "all") return;
  if (!scope.rootMissionIds.includes(mission.rootMissionId)) {
    throw new ToolError("scope_denied", `mission ${mission.id} is outside this credential's scope`);
  }
}

export function assertRootInScope(scope: ToolScope, rootMissionId: string): void {
  if (scope.rootMissionIds === "all") return;
  if (!scope.rootMissionIds.includes(rootMissionId)) {
    throw new ToolError("scope_denied", `mission tree ${rootMissionId} is outside this credential's scope`);
  }
}

/** A scoped credential may delegate under a mission it already reaches; it may
 * not open a new tree, because that would widen its own scope. */
export function assertMayCreateRoot(scope: ToolScope): void {
  if (scope.rootMissionIds !== "all") {
    throw new ToolError("scope_denied", "opening a new mission tree needs an owner-level credential; delegate under an existing mission instead");
  }
}

/** Control-plane credential stores. A tool hands out a read handle, never a
 * way to reach one of these. */
const SECRET_PATH_SEGMENTS = [".ssh", ".gnupg", ".eacbot", ".aws", ".config/gcloud"];
const SECRET_FILE_NAMES = [
  ".env",
  ".netrc",
  ".npmrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "authorized_keys",
];
const SECRET_FILE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore"];

export function isSecretBearingPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/").toLowerCase();
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  for (const secret of SECRET_PATH_SEGMENTS) {
    if (normalized.includes(`/${secret}/`) || segments.some((segment) => segment === secret.split("/").at(-1))) {
      return true;
    }
  }
  const name = segments.at(-1) ?? "";
  if (SECRET_FILE_NAMES.includes(name)) return true;
  if (name.startsWith(".env.")) return true;
  return SECRET_FILE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export function assertPathNotSecret(path: string): void {
  if (isSecretBearingPath(path)) {
    throw new ToolError("secret_refused", "that path holds credential material; the tool layer will not read it", {
      details: { path },
    });
  }
}

export function isAgentKind(value: string): value is AgentKind {
  return (["hermes", "claudeCode", "codex", "openCode", "pi", "ohMyPi", "custom"] as readonly string[]).includes(value);
}
