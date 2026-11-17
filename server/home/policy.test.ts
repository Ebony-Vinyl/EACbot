// The one decision that decides whether a home command leaves the host, and whether it waits for the person.
import { describe, expect, it } from "vitest";

import { homeVerdict, type HomePolicy } from "./policy.ts";
import type { HomeAction, HomeDomain, HomeEntity } from "../../shared/home.ts";

const entity = (overrides: Partial<HomeEntity> = {}): HomeEntity => ({
  entityId: "home-assistant:light.kitchen",
  adapterId: "home-assistant",
  domain: "light" as HomeDomain,
  name: "Kitchen light",
  zone: "kitchen",
  nativeId: "light.kitchen",
  available: true,
  actions: ["turn_on", "turn_off", "toggle"] as HomeAction[],
  state: "off",
  attributes: {},
  lastChangedAt: "2026-11-14T00:00:00Z",
  ...overrides,
});

const lock = (): HomeEntity => entity({
  entityId: "home-assistant:lock.front-door", domain: "lock", name: "Front door", zone: "hall",
  actions: ["lock", "unlock"], state: "locked",
});

const policy = (overrides: Partial<HomePolicy> = {}): HomePolicy => ({ access: "control", canConfirmSensitive: false, ...overrides });

describe("home policy", () => {
  it("refuses everything when access is off", () => {
    expect(homeVerdict(policy({ access: "off" }), entity(), "turn_on")).toMatchObject({ ok: false, code: "access_off" });
  });

  it("lets a read-only bot look but not change", () => {
    expect(homeVerdict(policy({ access: "read" }), entity(), "turn_on")).toMatchObject({ ok: false, code: "read_only" });
  });

  it("lets a control bot turn a light on without asking", () => {
    expect(homeVerdict(policy(), entity(), "turn_on")).toEqual({ ok: true, needsConfirmation: false });
  });

  it("refuses an action the device does not offer", () => {
    expect(homeVerdict(policy(), entity(), "set_brightness")).toMatchObject({ ok: false, code: "unsupported_action" });
  });

  it("refuses an action the domain does not have", () => {
    const sensor = entity({ domain: "sensor", actions: ["set_position"] });
    expect(homeVerdict(policy(), sensor, "set_position")).toMatchObject({ ok: false, code: "unsupported_action" });
  });

  it("refuses a device that is not reachable", () => {
    expect(homeVerdict(policy(), entity({ available: false }), "turn_on")).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("refuses a zone the bot may not touch", () => {
    expect(homeVerdict(policy({ zones: ["living-room"] }), entity(), "turn_on")).toMatchObject({ ok: false, code: "zone_not_allowed" });
  });

  it("allows a zone the bot may touch", () => {
    expect(homeVerdict(policy({ zones: ["kitchen"] }), entity(), "turn_on")).toEqual({ ok: true, needsConfirmation: false });
  });

  it("refuses a domain the bot may not touch", () => {
    expect(homeVerdict(policy({ domains: ["light"] }), lock(), "unlock")).toMatchObject({ ok: false, code: "zone_not_allowed" });
  });

  it("never unlocks a door for a control bot", () => {
    expect(homeVerdict(policy(), lock(), "unlock")).toMatchObject({ ok: false, code: "sensitive" });
  });

  it("never unlocks a door for a full bot that cannot ask", () => {
    expect(homeVerdict(policy({ access: "full" }), lock(), "unlock")).toMatchObject({ ok: false, code: "sensitive" });
  });

  it("unlocks a door for a full bot only with a confirmation", () => {
    expect(homeVerdict(policy({ access: "full", canConfirmSensitive: true }), lock(), "unlock")).toEqual({ ok: true, needsConfirmation: true });
  });

  it("offers no command at all for a camera, which is read-only", () => {
    const camera = entity({ domain: "camera", actions: ["turn_on"] });
    // A camera is watched, not driven: the domain has no action for it, so nothing reaches the adapter.
    expect(homeVerdict(policy(), camera, "turn_on")).toMatchObject({ ok: false, code: "unsupported_action" });
  });

  it("treats opening a cover as sensitive", () => {
    const cover = entity({ domain: "cover", actions: ["open", "close"] });
    expect(homeVerdict(policy(), cover, "open")).toMatchObject({ ok: false, code: "sensitive" });
    expect(homeVerdict(policy(), cover, "close")).toMatchObject({ ok: false, code: "sensitive" });
  });
});
