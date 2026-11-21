// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { springTo } from "./use-spring";

function animation() {
  const result = {
    cancel: vi.fn(() => result.oncancel?.call(result as unknown as Animation, new Event("cancel") as AnimationPlaybackEvent)),
    oncancel: null as Animation["oncancel"],
    onfinish: null as Animation["onfinish"],
  };
  return result as unknown as Animation;
}

function installAnimate(element: HTMLElement) {
  const created: { animation: Animation; frames: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
  Object.defineProperty(element, "animate", {
    configurable: true,
    value: (frames: Keyframe[], options: KeyframeAnimationOptions) => {
      const instance = animation();
      created.push({ animation: instance, frames, options });
      return instance;
    },
  });
  return created;
}

afterEach(() => {
  delete document.documentElement.dataset.reducedMotion;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("springTo", () => {
  it("replaces only its own animation and continues from the current presentation", () => {
    const element = document.createElement("div");
    const created = installAnimate(element);
    const unrelated = animation();
    element.getAnimations = () => [unrelated];
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ transform: "matrix(1, 0, 0, 1, 8, 0)", opacity: "0.6" } as CSSStyleDeclaration);

    const first = springTo(element, { x: -20, opacity: 0 }, { x: 0, opacity: 1 });
    const second = springTo(element, { x: 0, opacity: 1 }, { x: 20, opacity: 0 }, true);

    expect(first?.cancel).toHaveBeenCalledOnce();
    expect(unrelated.cancel).not.toHaveBeenCalled();
    expect(created[1].frames[0]).toEqual({ transform: "matrix(1, 0, 0, 1, 8, 0)", opacity: "0.6" });
    expect(created[1].options.duration).toBe(220);
    expect(second).toBe(created[1].animation);
  });

  it("writes and settles the destination before clearing the completed fill effect", () => {
    const element = document.createElement("div");
    const created = installAnimate(element);

    springTo(element, { x: -20, opacity: 0 }, { x: 4, y: 2, scale: 0.9, opacity: 0.8 });
    created[0].animation.onfinish?.call(created[0].animation, new Event("finish") as AnimationPlaybackEvent);

    expect(element.style.transform).toBe("translate3d(4px, 2px, 0) scale(0.9)");
    expect(element.style.opacity).toBe("0.8");
    expect(created[0].animation.cancel).toHaveBeenCalledOnce();
  });

  it.each(["dataset", "media"] as const)("settles immediately for %s reduced motion", (source) => {
    const element = document.createElement("div");
    const created = installAnimate(element);
    if (source === "dataset") document.documentElement.dataset.reducedMotion = "true";
    else vi.stubGlobal("matchMedia", () => ({ matches: true }));

    expect(springTo(element, { x: -10, opacity: 0 }, { x: 0, opacity: 1 })).toBeNull();
    expect(created).toHaveLength(0);
    expect(element.style.transform).toBe("translate3d(0px, 0px, 0) scale(1)");
    expect(element.style.opacity).toBe("1");
  });

  it("settles the destination when WAAPI is missing or throws", () => {
    const unsupported = document.createElement("div");
    Object.defineProperty(unsupported, "animate", { configurable: true, value: undefined });
    expect(springTo(unsupported, { x: 4 }, { x: 0, opacity: 0.5 })).toBeNull();
    expect(unsupported.style.opacity).toBe("0.5");

    const failing = document.createElement("div");
    Object.defineProperty(failing, "animate", { configurable: true, value: () => { throw new Error("unsupported"); } });
    expect(springTo(failing, { x: 4 }, { x: 0, opacity: 0.5 })).toBeNull();
    expect(failing.style.opacity).toBe("0.5");
  });
});
