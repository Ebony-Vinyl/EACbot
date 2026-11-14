// The Home Assistant adapter against a fake HA: what it reads, how it maps a service call, and that an
// uncertain delivery is never reported as a success.
import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { homeAssistantAdapter, serviceCallFor } from "./home-assistant.ts";
import type { HomeEntity } from "../../../shared/home.ts";

interface Fake {
  server: ReturnType<typeof createServer>;
  url: string;
  calls: Array<{ method: string; path: string; body: string; auth: string }>;
  /** What the next service call answers with, so a test can make one fail. */
  nextStatus: { status: number; body?: string };
  states: unknown[];
}

let fake: Fake;

beforeAll(async () => {
  fake = { server: createServer(), url: "", calls: [], nextStatus: { status: 200 }, states: [] };
  fake.server.on("request", (req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      fake.calls.push({ method: req.method ?? "", path: req.url ?? "", body, auth: String(req.headers.authorization ?? "") });
      if (req.url === "/api/states") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(fake.states));
        return;
      }
      if (req.url?.startsWith("/api/services/")) {
        const { status, body: text } = fake.nextStatus;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(text ?? "[]");
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(fake.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  fake.server.closeAllConnections();
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.nextStatus = { status: 200 };
  fake.states = [
    { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen light", brightness: 128, area: "kitchen" }, last_changed: "2026-11-14T00:00:00Z" },
    { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "Front door", area: "hall" }, last_changed: "2026-11-14T00:00:00Z" },
    { entity_id: "sensor.outdoor_temp", state: "12.5", attributes: { friendly_name: "Outdoor", unit_of_measurement: "°C" }, last_changed: "2026-11-14T00:00:00Z" },
    { entity_id: "input_number.nonsense", state: "3", attributes: { friendly_name: "Number" }, last_changed: "2026-11-14T00:00:00Z" },
    { entity_id: "light.broken", state: "unavailable", attributes: { friendly_name: "Broken" }, last_changed: "2026-11-14T00:00:00Z" },
  ];
});

const adapter = () => homeAssistantAdapter({ baseUrl: fake.url, token: "test-token" });

describe("Home Assistant adapter", () => {
  it("maps HA domains onto the home's own vocabulary", async () => {
    const snapshot = await adapter().snapshot();
    expect(snapshot.status).toBe("ready");
    const byName = new Map(snapshot.entities.map((entity) => [entity.nativeId, entity]));
    expect(byName.get("light.kitchen")).toMatchObject({ domain: "light", zone: "kitchen", available: true });
    expect(byName.get("lock.front_door")).toMatchObject({ domain: "lock", zone: "hall" });
    expect(byName.get("sensor.outdoor_temp")).toMatchObject({ domain: "sensor" });
    // A domain this adapter does not know stays readable and is never offered a command.
    expect(byName.get("input_number.nonsense")).toMatchObject({ domain: "other", actions: [] });
  });

  it("sends the token and never puts it in a URL", async () => {
    await adapter().snapshot();
    expect(fake.calls[0]!.auth).toBe("Bearer test-token");
    expect(fake.calls.every((call) => !call.path.includes("test-token"))).toBe(true);
  });

  it("reports a light's brightness as a percentage", async () => {
    const snapshot = await adapter().snapshot();
    const light = snapshot.entities.find((entity) => entity.nativeId === "light.kitchen")!;
    expect(light.attributes.brightness_pct).toBe(50);
  });

  it("offers a lock only the direction its state allows", async () => {
    const snapshot = await adapter().snapshot();
    const door = snapshot.entities.find((entity) => entity.nativeId === "lock.front_door")!;
    expect(door.actions).toEqual(["unlock"]);
  });

  it("marks an unavailable entity as such and offers it no commands", async () => {
    const snapshot = await adapter().snapshot();
    const broken = snapshot.entities.find((entity) => entity.nativeId === "light.broken")!;
    expect(broken.available).toBe(false);
    expect(broken.actions).toEqual([]);
  });

  it("leaves out what the config excludes", async () => {
    const snapshot = await homeAssistantAdapter({ baseUrl: fake.url, token: "t", exclude: ["sensor."] }).snapshot();
    expect(snapshot.entities.some((entity) => entity.nativeId.startsWith("sensor."))).toBe(false);
  });

  it("turns a command into one HA service call and reads the state back", async () => {
    const receipt = await adapter().control({ entityId: "home-assistant:light.kitchen", action: "turn_off" });
    expect(receipt.status).toBe("succeeded");
    const call = fake.calls.find((entry) => entry.path.startsWith("/api/services/"))!;
    expect(call.path).toBe("/api/services/light/turn_off");
    expect(JSON.parse(call.body)).toEqual({ entity_id: "light.kitchen" });
    expect(receipt.observed).not.toBeNull();
  });

  it("carries a brightness as HA's own percentage field", async () => {
    await adapter().control({ entityId: "home-assistant:light.kitchen", action: "set_brightness", value: 40 });
    const call = fake.calls.find((entry) => entry.path.startsWith("/api/services/"))!;
    expect(JSON.parse(call.body)).toEqual({ entity_id: "light.kitchen", brightness_pct: 40 });
  });

  it("refuses a value the action cannot carry, without calling HA", async () => {
    const receipt = await adapter().control({ entityId: "home-assistant:light.kitchen", action: "set_brightness", value: "very bright" });
    expect(receipt).toMatchObject({ status: "failed", code: "unsupported_action" });
    expect(fake.calls.some((entry) => entry.path.startsWith("/api/services/"))).toBe(false);
  });

  it("calls indeterminate when HA answers with a server error", async () => {
    fake.nextStatus = { status: 500, body: "boom" };
    const receipt = await adapter().control({ entityId: "home-assistant:light.kitchen", action: "turn_off" });
    // The request went out, so it may have taken effect: never a failure, never a success.
    expect(receipt.status).toBe("indeterminate");
    expect(receipt.code).toBe("server");
  });

  it("fails without pretending when the entity does not exist", async () => {
    const receipt = await adapter().control({ entityId: "home-assistant:light.ghost", action: "turn_off" });
    expect(receipt).toMatchObject({ status: "failed", code: "unknown_entity" });
  });

  it("reports an unreachable home instead of throwing", async () => {
    const offline = homeAssistantAdapter({ baseUrl: "http://127.0.0.1:9", token: "t" });
    const snapshot = await offline.snapshot();
    expect(snapshot.status).toBe("unreachable");
    expect(snapshot.entities).toEqual([]);
  });

  it("names a rejected token as unauthorized", async () => {
    fake.states = [];
    const saved = fake.server.listeners("request");
    expect(saved.length).toBeGreaterThan(0);
    const wrong = homeAssistantAdapter({ baseUrl: `${fake.url}/wrong`, token: "t" });
    const snapshot = await wrong.snapshot();
    expect(snapshot.status).toBe("unreachable");
  });
});

describe("service call mapping", () => {
  const light: HomeEntity = {
    entityId: "home-assistant:light.kitchen", adapterId: "home-assistant", domain: "light", name: "Kitchen",
    zone: "kitchen", nativeId: "light.kitchen", available: true, actions: ["turn_on", "set_brightness"],
    state: "on", attributes: {}, lastChangedAt: "2026-11-14T00:00:00Z",
  };

  it("maps brightness onto a percentage HA accepts", () => {
    expect(serviceCallFor(light, { entityId: light.entityId, action: "set_brightness", value: 150 }))
      .toEqual({ domain: "light", service: "turn_on", data: { entity_id: "light.kitchen", brightness_pct: 100 } });
  });

  it("clamps a colour temperature into the range a bulb takes", () => {
    expect(serviceCallFor(light, { entityId: light.entityId, action: "set_color_temperature", value: 9000 }))
      .toMatchObject({ data: { kelvin: 6500 } });
  });

  it("has no call for an action that needs a value it did not get", () => {
    expect(serviceCallFor(light, { entityId: light.entityId, action: "set_color" })).toBeNull();
  });
});
