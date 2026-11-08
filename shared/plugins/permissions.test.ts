import { describe, expect, it } from "vitest";

import { authorizePluginCall, consumePluginGrant, type PluginCallRequest, type PluginGrant, type PluginInstallSnapshot } from "./permissions.ts";
import { parsePluginManifest } from "./manifest.ts";

const manifest = parsePluginManifest({
  schemaVersion: 1,
  pluginId: "eac.test",
  version: "1.0.0",
  apiVersion: "^1.0.0",
  name: "Test plugin",
  description: "A plugin used by contract tests.",
  publisher: "EAC Tests",
  license: "MIT",
  source: { repository: "https://github.com/example/eac-test", revision: "a".repeat(40) },
  compatibility: { hostVersion: "^0.1.0", hosts: ["server"], platforms: ["win32-x64"] },
  runtime: { mode: "declarative" },
  activation: ["manual"],
  permissions: [{ id: "read-library", capability: "music.library.read", effect: "read", scope: { accounts: "selected", devices: "selected" }, reason: "Read." }],
  contributes: {},
  stateVersion: 1,
});
if (!manifest.ok) throw new Error(manifest.error);

const grant = (patch: Partial<PluginGrant> = {}): PluginGrant => ({
  grantId: "grant-1",
  installationId: "plg_1",
  botId: "bot-1",
  principalId: "owner-1",
  audienceId: "private-owner-1",
  permissionId: "read-library",
  effect: "read",
  resources: { accounts: ["music-1"], devices: ["desktop-1"] },
  createdAt: "2026-11-07T00:00:00.000Z",
  epoch: 1,
  uses: 0,
  ...patch,
});

const installation = (grants: PluginGrant[], state: PluginInstallSnapshot["state"] = "active"): PluginInstallSnapshot => ({
  installationId: "plg_1",
  manifest: manifest.manifest,
  state,
  grants,
});

const call = (patch: Partial<PluginCallRequest> = {}): PluginCallRequest => ({
  installationId: "plg_1",
  permissionId: "read-library",
  botId: "bot-1",
  principalId: "owner-1",
  audienceId: "private-owner-1",
  epoch: 1,
  now: "2026-11-07T01:00:00.000Z",
  accountId: "music-1",
  deviceId: "desktop-1",
  ...patch,
});

describe("plugin authorization", () => {
  it("allows the exact installation, bot, requester, audience, account and device", () => {
    expect(authorizePluginCall(installation([grant()]), call())).toMatchObject({ allowed: true });
  });

  it("fails closed when the installation is not active", () => {
    expect(authorizePluginCall(installation([grant()], "disabled"), call())).toMatchObject({ allowed: false, code: "PLUGIN_NOT_ACTIVE" });
  });

  it("does not let another bot, person or audience reuse the grant", () => {
    expect(authorizePluginCall(installation([grant()]), call({ botId: "bot-2" }))).toMatchObject({ code: "BOT_MISMATCH" });
    expect(authorizePluginCall(installation([grant()]), call({ principalId: "guest" }))).toMatchObject({ code: "PRINCIPAL_MISMATCH" });
    expect(authorizePluginCall(installation([grant()]), call({ audienceId: "room-1" }))).toMatchObject({ code: "AUDIENCE_MISMATCH" });
  });

  it("requires selected accounts and devices, and rejects ones outside the grant", () => {
    expect(authorizePluginCall(installation([grant()]), call({ accountId: undefined }))).toMatchObject({ code: "ACCOUNT_REQUIRED" });
    expect(authorizePluginCall(installation([grant()]), call({ accountId: "music-2" }))).toMatchObject({ code: "ACCOUNT_NOT_GRANTED" });
    expect(authorizePluginCall(installation([grant()]), call({ deviceId: undefined }))).toMatchObject({ code: "DEVICE_REQUIRED" });
    expect(authorizePluginCall(installation([grant()]), call({ deviceId: "phone-1" }))).toMatchObject({ code: "DEVICE_NOT_GRANTED" });
    expect(authorizePluginCall(installation([grant({ resources: {} })]), call())).toMatchObject({ code: "ACCOUNT_NOT_GRANTED" });
  });

  it("rejects an expired, stale or exhausted grant", () => {
    expect(authorizePluginCall(installation([grant({ expiresAt: "2026-11-07T00:30:00.000Z" })]), call())).toMatchObject({ code: "GRANT_EXPIRED" });
    expect(authorizePluginCall(installation([grant({ epoch: 2 })]), call())).toMatchObject({ code: "GRANT_EPOCH_MISMATCH" });
    expect(authorizePluginCall(installation([grant({ maxUses: 1, uses: 1 })]), call())).toMatchObject({ code: "GRANT_EXHAUSTED" });
  });

  it("increments uses only through the explicit consume step", () => {
    const original = grant({ maxUses: 2 });
    expect(consumePluginGrant(original).uses).toBe(1);
    expect(original.uses).toBe(0);
  });
});
