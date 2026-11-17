import { describe, expect, it } from "vitest";

import {
  BACKGROUND_DEFAULTS,
  drawsBackground,
  parseBackgroundSettings,
  ROTATE_MAX_SECONDS,
  ROTATE_MIN_SECONDS,
  WALLPAPERS,
} from "./background-settings";

describe("parseBackgroundSettings", () => {
  it("gives the defaults for nothing at all", () => {
    expect(parseBackgroundSettings(undefined)).toEqual(BACKGROUND_DEFAULTS);
    expect(parseBackgroundSettings(null)).toEqual(BACKGROUND_DEFAULTS);
    expect(parseBackgroundSettings("nonsense")).toEqual(BACKGROUND_DEFAULTS);
  });

  it("keeps a stored choice", () => {
    const parsed = parseBackgroundSettings({ mode: "wallpaper", rotateSeconds: 45, effect: "sakura", strength: 80, veil: 50 });
    expect(parsed).toEqual({ mode: "wallpaper", rotateSeconds: 45, effect: "sakura", strength: 80, veil: 50 });
  });

  it("refuses a mode or effect it does not know", () => {
    expect(parseBackgroundSettings({ mode: "video" }).mode).toBe(BACKGROUND_DEFAULTS.mode);
    expect(parseBackgroundSettings({ effect: "rain" }).effect).toBe(BACKGROUND_DEFAULTS.effect);
  });

  it("holds the rotation between the limits it can drive", () => {
    expect(parseBackgroundSettings({ rotateSeconds: 0 }).rotateSeconds).toBe(ROTATE_MIN_SECONDS);
    expect(parseBackgroundSettings({ rotateSeconds: 100000 }).rotateSeconds).toBe(ROTATE_MAX_SECONDS);
    expect(parseBackgroundSettings({ rotateSeconds: Number.NaN }).rotateSeconds).toBe(ROTATE_MIN_SECONDS);
  });

  it("holds the two percentages between 0 and 100", () => {
    expect(parseBackgroundSettings({ strength: -40, veil: 900 })).toMatchObject({ strength: 0, veil: 100 });
  });
});

describe("drawsBackground", () => {
  it("draws nothing while the ground is the skin's own colour", () => {
    expect(drawsBackground(BACKGROUND_DEFAULTS, true)).toBe(false);
  });

  it("draws the bundled wallpapers when they exist", () => {
    expect(drawsBackground({ ...BACKGROUND_DEFAULTS, mode: "wallpaper" }, false)).toBe(WALLPAPERS.length > 0);
  });

  it("draws a chosen picture only once there is one", () => {
    expect(drawsBackground({ ...BACKGROUND_DEFAULTS, mode: "picture" }, false)).toBe(false);
    expect(drawsBackground({ ...BACKGROUND_DEFAULTS, mode: "picture" }, true)).toBe(true);
  });
});
