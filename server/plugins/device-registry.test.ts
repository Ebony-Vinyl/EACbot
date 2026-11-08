import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceError, DeviceRegistry } from "./device-registry.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function makeRegistry(options: { pairingTtlMs?: number; commandTtlMs?: number } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "eac-devices-"));
  folders.push(folder);
  let at = Date.parse("2026-11-08T00:00:00.000Z");
  const registry = new DeviceRegistry(folder, {
    now: () => new Date(at).toISOString(),
    ...options,
  });
  return { folder, registry, advance: (ms: number) => { at += ms; } };
}

function paired(registry: DeviceRegistry) {
  const pairing = registry.createPairing({
    name: "Watch", kind: "watch", capabilities: ["notify", "vibrate", "health.read"],
  });
  return { pairing, device: registry.redeem(pairing.pairingId, pairing.code) };
}

describe("device registry", () => {
  it("pairs with a one-time code and refuses replay, wrong codes and expiry", () => {
    const { registry, advance } = makeRegistry({ pairingTtlMs: 1_000 });
    const { pairing, device } = paired(registry);
    expect(device).toMatchObject({ status: "paired", kind: "watch", capabilities: ["notify", "vibrate", "health.read"] });
    expect(() => registry.redeem(pairing.pairingId, pairing.code)).toThrow(/already used/);

    const second = registry.createPairing({ name: "Phone", kind: "phone", capabilities: ["notify"] });
    expect(() => registry.redeem(second.pairingId, second.code === "000000" ? "000001" : "000000")).toThrow(/wrong/);
    advance(1_001);
    expect(() => registry.redeem(second.pairingId, second.code)).toThrow(/expired/);
  });

  it("refuses a capability the device never declared and a revoked device", () => {
    const { registry } = makeRegistry();
    const { device } = paired(registry);
    expect(() => registry.send({ deviceId: device.deviceId, capability: "lock.open" })).toThrow(DeviceError);
    registry.revoke(device.deviceId);
    expect(() => registry.send({ deviceId: device.deviceId, capability: "notify" })).toThrow(/revoked/);
  });

  it("makes a duplicate command id idempotent and records only one receipt", () => {
    const { registry } = makeRegistry();
    const { device } = paired(registry);
    const first = registry.send({ commandId: crypto.randomUUID(), deviceId: device.deviceId, capability: "notify", args: { text: "hi" } });
    const again = registry.send({ commandId: first.commandId, deviceId: device.deviceId, capability: "notify", args: { text: "hi" } });
    expect(again.commandId).toBe(first.commandId);
    const done = registry.complete(device.deviceId, first.commandId, "succeeded", { shown: true });
    expect(done).toMatchObject({ status: "succeeded", result: { shown: true } });
    expect(registry.complete(device.deviceId, first.commandId, "succeeded")).toMatchObject({ status: "succeeded" });
    expect(() => registry.complete(device.deviceId, first.commandId, "failed")).toThrow(/different result/);
  });

  it("expires a command and reports a late success as unknown", () => {
    const { registry, advance } = makeRegistry({ commandTtlMs: 1_000 });
    const { device } = paired(registry);
    const command = registry.send({ deviceId: device.deviceId, capability: "vibrate" });
    advance(1_001);
    expect(registry.pending(device.deviceId)).toEqual([]);
    expect(registry.complete(device.deviceId, command.commandId, "succeeded")).toMatchObject({ status: "unknown" });
  });

  it("persists devices and refuses an unknown device", () => {
    const { folder, registry } = makeRegistry();
    const { device } = paired(registry);
    expect(new DeviceRegistry(folder).device(device.deviceId)).toMatchObject({ name: "Watch" });
    expect(() => registry.send({ deviceId: crypto.randomUUID(), capability: "notify" })).toThrow(/no such device/);
  });
});
