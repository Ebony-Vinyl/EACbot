// The Matter adapter against a real matter.js device on a simulated network: pairing, reading the endpoint, a
// command that lands on the device, and a read-back receipt. No mDNS and no radio, so this runs anywhere.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { matterAdapter, pairingOptions } from "./matter.ts";

const PASSCODE = 20_202_021;
const DISCRIMINATOR = 3_840;

let dir = "";
let controller: ReturnType<typeof matterAdapter> | null = null;
let device: { close(): Promise<void> } | null = null;
let localLight: { stateOf(cluster: string): { onOff: boolean } } | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eac-matter-"));
});

afterEach(async () => {
  await controller?.dispose?.();
  controller = null;
  await device?.close().catch(() => {});
  device = null;
  localLight = null;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A light on a simulated network, paired through a passcode. The device is the same library the adapter uses, so
 * this exercises the real commissioning flow rather than a stub that agrees with whatever the adapter does.
 *
 * The storage root is set before the library is imported: it reads the variable once, and a device that kept a
 * fabric from an earlier run is no longer commissionable.
 */
async function pairLight(): Promise<void> {
  process.env.MATTER_PATH_ROOT = dir;
  process.env.MATTER_LOG_LEVEL = "error";
  const { NetworkSimulator, ServerNode, Endpoint } = await import("@matter/main");
  const { OnOffLightDevice } = await import("@matter/main/devices/on-off-light");

  const simulator = new NetworkSimulator();
  const server = await ServerNode.create({
    id: "eac-test-light",
    network: { simulator, port: 55_401 },
    commissioning: { passcode: PASSCODE, discriminator: DISCRIMINATOR },
    productDescription: { name: "Test Light", deviceType: 0x0101 },
  } as unknown as Parameters<typeof ServerNode.create>[0]);
  const light = new Endpoint(OnOffLightDevice, { id: "light" });
  await server.add(light);
  await server.start();
  localLight = light as unknown as { stateOf(cluster: string): { onOff: boolean } };
  device = server;

  // The adapter's controller joins the same simulator, so discovery finds the device on the simulated network.
  // Each node on a simulator binds its own UDP port; the default 5540 is what the device already holds.
  controller = matterAdapter({ dataDir: join(dir, "matter"), label: "test", simulator, networkPort: 55_402 });
  await controller!.pair({ passcode: PASSCODE, discriminator: DISCRIMINATOR, timeoutSeconds: 30 });
}

describe("pairing options", () => {
  it("accepts a manual code, a QR payload, or the two numbers", () => {
    expect(pairingOptions({ code: "3497-011-2332" })).toEqual({ pairingCode: "3497-011-2332" });
    expect(pairingOptions({ code: "MT:-24J0AFN00KA0648G00" })).toEqual({ pairingCode: "MT:-24J0AFN00KA0648G00" });
    expect(pairingOptions({ passcode: PASSCODE, discriminator: DISCRIMINATOR })).toEqual({ passcode: PASSCODE, discriminator: DISCRIMINATOR });
  });

  it("refuses anything else instead of guessing", () => {
    expect(pairingOptions({ code: "hello" })).toBeNull();
    expect(pairingOptions({})).toBeNull();
  });
});

describe("a paired Matter device", () => {
  it("lists its endpoints as domain entities and lands a command on the device", async () => {
    await pairLight();
    const snapshot = await controller!.snapshot();
    expect(snapshot.status).toBe("ready");
    const light = snapshot.entities.find((entity) => entity.domain === "light");
    expect(light, "the light endpoint must appear as a light").toBeTruthy();
    expect(light!.actions).toContain("turn_on");
    expect(light!.state).toBe("off");

    const receipt = await controller!.control({ entityId: light!.entityId, action: "turn_on" });
    expect(receipt.status).toBe("succeeded");
    // The device itself changed, not just the controller's cache.
    expect(localLight!.stateOf("onOff").onOff).toBe(true);
    // The receipt carries what was read back, so a person sees the device's own answer.
    expect(receipt.observed?.state).toBe("on");

    const off = await controller!.control({ entityId: light!.entityId, action: "turn_off" });
    expect(off.status).toBe("succeeded");
    expect(localLight!.stateOf("onOff").onOff).toBe(false);
  }, 180_000);

  it("reports an entity it does not hold instead of inventing a receipt", async () => {
    await pairLight();
    const receipt = await controller!.control({ entityId: "matter:not-a-node:ep9", action: "turn_on" });
    expect(receipt.status).toBe("failed");
    expect(receipt.code).toBe("unknown_entity");
  }, 180_000);
});
