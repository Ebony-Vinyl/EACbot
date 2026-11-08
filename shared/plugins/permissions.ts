import type { PluginEffect, PluginManifest, PluginPermission } from "./manifest.ts";
import type { PluginState } from "./lifecycle.ts";

export interface PluginGrantResources {
  accounts?: string[];
  devices?: string[];
  memorySpaces?: string[];
  resources?: string[];
}

/** A grant is issued by the host for one installation and one authenticated principal/audience pair. */
export interface PluginGrant {
  grantId: string;
  installationId: string;
  botId: string;
  principalId: string;
  audienceId: string;
  permissionId: string;
  effect: PluginEffect;
  resources: PluginGrantResources;
  createdAt: string;
  expiresAt?: string;
  epoch: number;
  maxUses?: number;
  uses: number;
}

export interface PluginInstallSnapshot {
  installationId: string;
  manifest: PluginManifest;
  state: PluginState;
  grants: readonly PluginGrant[];
}

export interface PluginCallRequest {
  installationId: string;
  permissionId: string;
  botId: string;
  principalId: string;
  audienceId: string;
  epoch: number;
  now: string;
  accountId?: string;
  deviceId?: string;
  memorySpaceId?: string;
  resourceId?: string;
}

export type PluginAuthorizationCode =
  | "PLUGIN_NOT_ACTIVE"
  | "UNKNOWN_PERMISSION"
  | "NO_GRANT"
  | "GRANT_EXPIRED"
  | "GRANT_INVALID"
  | "GRANT_EPOCH_MISMATCH"
  | "GRANT_EXHAUSTED"
  | "BOT_MISMATCH"
  | "PRINCIPAL_MISMATCH"
  | "AUDIENCE_MISMATCH"
  | "EFFECT_MISMATCH"
  | "ACCOUNT_REQUIRED"
  | "ACCOUNT_NOT_GRANTED"
  | "DEVICE_REQUIRED"
  | "DEVICE_NOT_GRANTED"
  | "MEMORY_SPACE_REQUIRED"
  | "MEMORY_SPACE_NOT_GRANTED"
  | "RESOURCE_REQUIRED"
  | "RESOURCE_NOT_GRANTED";

export type PluginAuthorization =
  | { allowed: true; grant: PluginGrant }
  | { allowed: false; code: PluginAuthorizationCode; error: string };

export function findPermission(manifest: PluginManifest, permissionId: string): PluginPermission | null {
  return manifest.permissions.find((permission) => permission.id === permissionId) ?? null;
}

function targetAllows(
  permissionValue: PluginPermission["scope"]["accounts"],
  grantValue: readonly string[] | undefined,
  requested: string | undefined,
  missing: PluginAuthorizationCode,
  denied: PluginAuthorizationCode,
  label: string,
): { ok: true } | { ok: false; code: PluginAuthorizationCode; error: string } {
  if (permissionValue === undefined) return { ok: true };
  if (requested === undefined) return { ok: false, code: missing, error: `this capability needs a ${label}` };
  if (permissionValue !== "selected" && !permissionValue.includes(requested)) {
    return { ok: false, code: denied, error: `the ${label} is outside this permission's declared scope` };
  }
  if (!grantValue || !grantValue.includes(requested)) {
    return { ok: false, code: denied, error: `the ${label} is not included in this grant` };
  }
  return { ok: true };
}

function expired(grant: PluginGrant, now: string): boolean {
  if (!grant.expiresAt) return false;
  const until = Date.parse(grant.expiresAt);
  const at = Date.parse(now);
  return !Number.isFinite(until) || !Number.isFinite(at) || until <= at;
}

/**
 * The host is the only caller. It supplies the authenticated principal and audience, never values copied from a model
 * call. A matching grant is necessary but not sufficient: the installation must also be active.
 */
export function authorizePluginCall(installation: PluginInstallSnapshot, request: PluginCallRequest): PluginAuthorization {
  if (request.installationId !== installation.installationId) {
    return { allowed: false, code: "NO_GRANT", error: "the installation does not match this request" };
  }
  if (installation.state !== "active") {
    return { allowed: false, code: "PLUGIN_NOT_ACTIVE", error: `the plugin is ${installation.state}` };
  }
  const permission = findPermission(installation.manifest, request.permissionId);
  if (!permission) return { allowed: false, code: "UNKNOWN_PERMISSION", error: "the plugin does not declare this permission" };

  let denied: PluginAuthorization | null = null;
  for (const grant of installation.grants) {
    if (grant.permissionId !== permission.id) continue;
    if (grant.botId !== request.botId) { denied ??= { allowed: false, code: "BOT_MISMATCH", error: "the grant belongs to another bot" }; continue; }
    if (grant.principalId !== request.principalId) { denied ??= { allowed: false, code: "PRINCIPAL_MISMATCH", error: "the grant belongs to another requester" }; continue; }
    if (grant.audienceId !== request.audienceId) { denied ??= { allowed: false, code: "AUDIENCE_MISMATCH", error: "the grant does not cover this audience" }; continue; }
    if (grant.effect !== permission.effect) { denied ??= { allowed: false, code: "EFFECT_MISMATCH", error: "the grant effect does not match the declared permission" }; continue; }
    if (grant.epoch !== request.epoch) { denied ??= { allowed: false, code: "GRANT_EPOCH_MISMATCH", error: "the authorization epoch changed" }; continue; }
    if (expired(grant, request.now)) { denied ??= { allowed: false, code: "GRANT_EXPIRED", error: "the grant has expired" }; continue; }
    if (grant.maxUses !== undefined && grant.uses >= grant.maxUses) {
      denied ??= { allowed: false, code: "GRANT_EXHAUSTED", error: "the grant has no uses left" };
      continue;
    }
    const account = targetAllows(permission.scope.accounts, grant.resources.accounts, request.accountId, "ACCOUNT_REQUIRED", "ACCOUNT_NOT_GRANTED", "account");
    if (!account.ok) { denied ??= { allowed: false, ...account }; continue; }
    const device = targetAllows(permission.scope.devices, grant.resources.devices, request.deviceId, "DEVICE_REQUIRED", "DEVICE_NOT_GRANTED", "device");
    if (!device.ok) { denied ??= { allowed: false, ...device }; continue; }
    const memory = targetAllows(permission.scope.memorySpaces, grant.resources.memorySpaces, request.memorySpaceId, "MEMORY_SPACE_REQUIRED", "MEMORY_SPACE_NOT_GRANTED", "memory space");
    if (!memory.ok) { denied ??= { allowed: false, ...memory }; continue; }
    const resource = targetAllows(permission.scope.resources, grant.resources.resources, request.resourceId, "RESOURCE_REQUIRED", "RESOURCE_NOT_GRANTED", "resource");
    if (!resource.ok) { denied ??= { allowed: false, ...resource }; continue; }
    return { allowed: true, grant };
  }
  return denied ?? { allowed: false, code: "NO_GRANT", error: "no grant covers this call" };
}

/** Persist the returned grant before performing the effect. It does not mutate the input. */
export function consumePluginGrant(grant: PluginGrant): PluginGrant {
  return { ...grant, uses: grant.uses + 1 };
}
