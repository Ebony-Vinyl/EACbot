// Springs for the shell's panes, built on the Web Animations API.
//
// Why not a CSS transition: it has one fixed duration and no velocity, so a pane already moving when the target changes
// jerks, and a pane arriving always decelerates the same way whatever the distance.
//
// Why not requestAnimationFrame: the integrator has to run every frame, and a frame callback is throttled to nothing
// whenever the page is not being painted (a background tab, a hidden window, a minimised app). The pane would then sit
// frozen half-way. `Element.animate` is driven by the compositor instead, so it keeps its timing on its own.

import { useEffect, useRef } from "react";

/** A spring-shaped easing: a small overshoot then settle. The curve is the house one, tuned to land in ~360ms. */
const SPRING_EASING = "cubic-bezier(0.22, 1.35, 0.36, 1)";
const SPRING_MS = 360;
const LEAVE_MS = 220;
const LEAVE_EASING = "cubic-bezier(0.4, 0, 0.6, 1)";
const ownedAnimations = new WeakMap<HTMLElement, Animation>();

export interface SpringFrame {
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
}

function frameToKeyframes(from: SpringFrame, to: SpringFrame): Keyframe[] {
  const style = (f: SpringFrame) => `translate3d(${f.x ?? 0}px, ${f.y ?? 0}px, 0) scale(${f.scale ?? 1})`;
  return [
    { transform: style(from), opacity: String(from.opacity ?? 1) },
    { transform: style(to), opacity: String(to.opacity ?? 1) },
  ];
}

function reducedMotion(): boolean {
  try {
    if (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true") return true;
  } catch {}
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/**
 * Plays `element` from `from` to `to` with the spring easing, replacing only motion started by this helper.
 */
export function springTo(element: HTMLElement, from: SpringFrame, to: SpringFrame, leaving = false): Animation | null {
  const previous = ownedAnimations.get(element);
  let interrupted: Keyframe | undefined;
  if (previous) {
    try {
      const computed = globalThis.getComputedStyle?.(element);
      if (computed) interrupted = { transform: computed.transform === "none" ? undefined : computed.transform, opacity: computed.opacity || "1" };
    } catch {
      interrupted = undefined;
    }
    ownedAnimations.delete(element);
    previous.cancel();
  }

  const finishImmediately = () => {
    element.style.transform = `translate3d(${to.x ?? 0}px, ${to.y ?? 0}px, 0) scale(${to.scale ?? 1})`;
    element.style.opacity = String(to.opacity ?? 1);
  };
  if (reducedMotion() || typeof element.animate !== "function") {
    finishImmediately();
    return null;
  }

  let animation: Animation;
  try {
    const frames = frameToKeyframes(from, to);
    animation = element.animate(interrupted ? [interrupted, frames[1]] : frames, {
      duration: leaving ? LEAVE_MS : SPRING_MS,
      easing: leaving ? LEAVE_EASING : SPRING_EASING,
      fill: "both",
    });
  } catch {
    finishImmediately();
    return null;
  }

  ownedAnimations.set(element, animation);
  animation.onfinish = () => {
    if (ownedAnimations.get(element) !== animation) return;
    ownedAnimations.delete(element);
    finishImmediately();
    animation.cancel();
  };
  animation.oncancel = () => {
    if (ownedAnimations.get(element) === animation) ownedAnimations.delete(element);
  };
  return animation;
}

/** Springs an element in whenever `token` changes. Used by the panes that appear once and stay. */
export function useSpringIn(ref: React.RefObject<HTMLElement | null>, token: unknown, from: SpringFrame): void {
  const played = useRef<unknown>(undefined);
  useEffect(() => {
    const element = ref.current;
    if (!element || played.current === token) return;
    played.current = token;
    const animation = springTo(element, from, { x: 0, y: 0, scale: 1, opacity: 1 });
    return () => animation?.cancel();
  }, [ref, token, from]);
}
