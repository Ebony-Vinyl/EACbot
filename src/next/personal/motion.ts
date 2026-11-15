/**
 * The motion this feature uses, and the one place it is turned off.
 *
 * Feedback is short and only ever confirms something a person just did: a row
 * arriving, a card settling, a status dot changing. Nothing loops, and nothing
 * moves a large distance — a list that slides teaches a person to wait for it.
 *
 * Durations follow the app's existing tokens (`src/styles.css`): ~120 ms for
 * feedback, 160–180 ms for a surface arriving with a 4 px rise, and 240 ms for
 * a panel's width. Every helper reads `prefers-reduced-motion` at call time,
 * so a person who turned motion off gets the final state immediately.
 */

export const MOTION = {
  /** A control acknowledging a press. */
  feedbackMs: 120,
  /** A card or popover arriving. */
  enterMs: 170,
  /** A panel changing width. */
  panelMs: 240,
  /** How far a surface rises as it arrives. */
  risePx: 4,
  /** The scale a surface starts at; never zero, because nothing appears from
   * nothing. */
  enterScale: 0.98,
} as const;

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export interface AnimationLike {
  cancel(): void;
  finished?: Promise<unknown>;
}

export interface Animatable {
  animate(keyframes: Keyframe[] | PropertyIndexedKeyframes, options: KeyframeAnimationOptions): AnimationLike;
}

/** True when an element can be animated at all. `Element.animate` is absent in
 * a test environment and in an old engine, where the final state is simply
 * shown. */
export function canAnimate(element: unknown): element is Animatable {
  return typeof element === "object" && element !== null && typeof (element as { animate?: unknown }).animate === "function";
}

/** A card arriving: a short rise and a barely-there scale. Returns the running
 * animation so a caller can cancel it when the element leaves first. */
export function animateEnter(element: unknown): AnimationLike | undefined {
  if (prefersReducedMotion() || !canAnimate(element)) return undefined;
  return element.animate(
    [
      { opacity: 0, transform: `translateY(${MOTION.risePx}px) scale(${MOTION.enterScale})` },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ],
    { duration: MOTION.enterMs, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" },
  );
}

/** A status dot changing, so a change is noticed without a breathing loop. */
export function animateStatusChange(element: unknown): AnimationLike | undefined {
  if (prefersReducedMotion() || !canAnimate(element)) return undefined;
  return element.animate(
    [{ transform: "scale(0.82)" }, { transform: "scale(1)" }],
    { duration: 130, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)", fill: "none" },
  );
}

/** A surface leaving. The element stays interactive-free while it fades; the
 * caller decides when to unmount, and this only shortens the wait. */
export function animateExit(element: unknown): AnimationLike | undefined {
  if (prefersReducedMotion() || !canAnimate(element)) return undefined;
  return element.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: MOTION.feedbackMs,
    easing: "ease-out",
    fill: "forwards",
  });
}

/** The class list a surface arriving uses when CSS, not script, owns the
 * motion. The `motion-reduce:` variant is the app's existing convention. */
export const ENTER_CLASS = "animate-pop-in motion-reduce:animate-none";
export const FEEDBACK_CLASS = "transition-transform duration-150 ease-out motion-reduce:transition-none";
