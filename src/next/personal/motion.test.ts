import { afterEach, describe, expect, it, vi } from "vitest";

import { ENTER_CLASS, FEEDBACK_CLASS, MOTION, animateEnter, animateExit, animateStatusChange, canAnimate, prefersReducedMotion } from "./motion.ts";

const reduced = (value: boolean) => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: value && query === "(prefers-reduced-motion: reduce)" }));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeElement(): { animate: ReturnType<typeof vi.fn> } {
  return { animate: vi.fn(() => ({ cancel: () => {}, finished: Promise.resolve() })) };
}

describe("motion respects the person's preference", () => {
  it("does not animate when reduced motion is asked for", () => {
    reduced(true);
    const element = fakeElement();
    expect(prefersReducedMotion()).toBe(true);
    expect(animateEnter(element)).toBeUndefined();
    expect(animateExit(element)).toBeUndefined();
    expect(animateStatusChange(element)).toBeUndefined();
    expect(element.animate).not.toHaveBeenCalled();
  });

  it("animates when motion is allowed", () => {
    reduced(false);
    const element = fakeElement();
    expect(prefersReducedMotion()).toBe(false);
    expect(animateEnter(element)).toBeDefined();
    expect(element.animate).toHaveBeenCalledTimes(1);
  });

  it("treats a missing matchMedia as motion allowed rather than crashing", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("shows the final state when an element cannot be animated at all", () => {
    reduced(false);
    expect(canAnimate({})).toBe(false);
    expect(animateEnter({})).toBeUndefined();
    expect(animateEnter(null)).toBeUndefined();
  });
});

describe("what the motion is", () => {
  it("keeps feedback short and the arrival brief", () => {
    expect(MOTION.feedbackMs).toBeLessThanOrEqual(150);
    expect(MOTION.enterMs).toBeLessThanOrEqual(200);
    expect(MOTION.panelMs).toBeLessThanOrEqual(300);
  });

  it("never scales a surface up from nothing", () => {
    expect(MOTION.enterScale).toBeGreaterThan(0);
    expect(MOTION.enterScale).toBeLessThan(1);
  });

  it("rises only a few pixels, so nothing sweeps across the screen", () => {
    expect(MOTION.risePx).toBeLessThanOrEqual(8);
  });

  it("gives every CSS class a reduced-motion counterpart", () => {
    for (const value of [ENTER_CLASS, FEEDBACK_CLASS]) {
      expect(value).toMatch(/motion-reduce:/u);
    }
  });
});
