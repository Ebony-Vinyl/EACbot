import { parsePluginManifest, type PluginManifest } from "../../shared/plugins/manifest.ts";
import type { PluginGrant } from "../../shared/plugins/permissions.ts";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  if (Array.isArray(base) || typeof base !== "object" || base === null) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = merge((base as Record<string, unknown>)[key], value as never);
  }
  return out as T;
}

const base: PluginManifest = {
  schemaVersion: 1,
  pluginId: "eac.test",
  version: "1.0.0",
  apiVersion: "^1.0.0",
  name: "Test plugin",
  description: "A plugin used by contract tests.",
  publisher: "EAC Tests",
  license: "MIT",
  source: { repository: "https://github.com/example/eac-test", revision: "a".repeat(40) },
  compatibility: { hostVersion: "^0.1.0", hosts: ["server", "desktop", "web"], platforms: ["win32-x64", "linux-x64", "darwin-arm64"] },
  runtime: { mode: "declarative" },
  activation: ["manual"],
  permissions: [{
    id: "read-library",
    capability: "music.library.read",
    effect: "read",
    scope: { accounts: "selected" },
    reason: "Read the selected music account.",
  }],
  contributes: {},
  stateVersion: 1,
};

export function manifestInput(patch: DeepPartial<PluginManifest> = {}): unknown {
  return merge(base, patch);
}

export function manifest(patch: DeepPartial<PluginManifest> = {}): PluginManifest {
  const parsed = parsePluginManifest(manifestInput(patch));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.manifest;
}

export function grant(installationId: string, patch: Partial<PluginGrant> = {}): PluginGrant {
  return {
    grantId: "grant-1",
    installationId,
    botId: "bot-1",
    principalId: "owner-1",
    audienceId: "private-owner-1",
    permissionId: "read-library",
    effect: "read",
    resources: { accounts: ["music-1"] },
    createdAt: "2026-11-07T00:00:00.000Z",
    epoch: 1,
    uses: 0,
    ...patch,
  };
}
