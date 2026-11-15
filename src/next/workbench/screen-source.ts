/** One state source for a computer's picture, shared by the rail preview and
 * the fullscreen canvas.
 *
 * Both surfaces read the same store, so opening fullscreen never reconnects
 * and closing it never leaves the rail showing a different moment. A dropped
 * stream keeps the last frame it drew and says Reconnecting, because blanking
 * a screen someone was watching hides the one thing they still need.
 *
 * The picture is scaled by giving the terminal a new column and row count for
 * its container, never by a CSS transform: a transformed canvas puts every
 * pointer coordinate somewhere other than where the picture is.
 */

export type ScreenPhase = "off" | "starting" | "live" | "reconnecting" | "ended" | "error";

export interface ScreenState {
  readonly phase: ScreenPhase;
  /** The screen this state belongs to, or null when nothing is selected. */
  readonly screenId: string | null;
  readonly label: string;
  /** When the last frame arrived; the poster keeps its time, not "now". */
  readonly lastFrameAt: number | null;
  readonly hasFrame: boolean;
  readonly attempt: number;
  readonly retryable: boolean;
  readonly detail: string | null;
}

export const OFF_SCREEN: ScreenState = {
  phase: "off",
  screenId: null,
  label: "",
  lastFrameAt: null,
  hasFrame: false,
  attempt: 0,
  retryable: false,
  detail: null,
};

export interface ScreenStore {
  getSnapshot(): ScreenState;
  subscribe(listener: () => void): () => void;
  /** Applies a change; returns the new state. */
  update(change: (state: ScreenState) => ScreenState): ScreenState;
  reset(): void;
}

export function createScreenStore(initial: ScreenState = OFF_SCREEN): ScreenStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(change) {
      const next = change(state);
      if (sameState(state, next)) return state;
      state = next;
      for (const listener of listeners) listener();
      return state;
    },
    reset() {
      this.update(() => OFF_SCREEN);
    },
  };
}

function sameState(a: ScreenState, b: ScreenState): boolean {
  return a.phase === b.phase
    && a.screenId === b.screenId
    && a.label === b.label
    && a.lastFrameAt === b.lastFrameAt
    && a.hasFrame === b.hasFrame
    && a.attempt === b.attempt
    && a.retryable === b.retryable
    && a.detail === b.detail;
}

/** A frame arrived: the screen is live and its poster time moves. */
export function frameDrawn(state: ScreenState, at: number): ScreenState {
  return { ...state, phase: "live", hasFrame: true, lastFrameAt: at, attempt: 0, retryable: false, detail: null };
}

/** The stream dropped. The picture stays, so `hasFrame` and `lastFrameAt` do
 * not change: only the phase and the attempt count do. */
export function streamLost(state: ScreenState, attempt: number, detail: string | null = null): ScreenState {
  return { ...state, phase: "reconnecting", attempt, retryable: false, detail };
}

/** Retries ran out: the picture is still the last one drawn, and the person is
 * offered Retry rather than an endless spinner. */
export function streamFailed(state: ScreenState, detail: string): ScreenState {
  return { ...state, phase: "error", retryable: true, detail };
}

/** A new screen was selected. A frame from the previous one is not this one's,
 * so the poster starts empty until this screen paints. */
export function screenSelected(screenId: string, label: string): ScreenState {
  return { phase: "starting", screenId, label, lastFrameAt: null, hasFrame: false, attempt: 0, retryable: false, detail: null };
}

export function screenEnded(state: ScreenState, reason: string): ScreenState {
  return { ...state, phase: "ended", detail: reason };
}

/** What a person reads above the picture. Every phase has words, so no state
 * renders as a bare spinner. */
export function screenCopy(state: ScreenState): { title: string; detail: string } {
  switch (state.phase) {
    case "off":
      return { title: "No computer", detail: "Pick a running agent with a screen to watch it here." };
    case "starting":
      return { title: "Starting", detail: `Opening ${state.label || "the computer"}.` };
    case "live":
      return { title: "Live", detail: state.label };
    case "reconnecting":
      return {
        title: "Reconnecting",
        detail: state.hasFrame
          ? `The last picture is from ${timeLabel(state.lastFrameAt)}. Trying again (${state.attempt}).`
          : "Trying again.",
      };
    case "ended":
      return { title: "Ended", detail: state.detail ?? "The program on this computer exited." };
    case "error":
      return { title: "Disconnected", detail: state.detail ?? "The computer could not be reached." };
  }
}

function timeLabel(at: number | null): string {
  if (at === null) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/** A screen the multi-view may list: its agent is running and it has drawn
 * something. A screen still starting has nothing to show yet. */
export interface ScreenCandidate {
  readonly id: string;
  readonly label: string;
  readonly running: boolean;
  readonly hasFrame: boolean;
  /** The agent asked a person to take over this screen. */
  readonly handoffRequested?: boolean;
}

export function listableScreens(candidates: readonly ScreenCandidate[]): ScreenCandidate[] {
  return candidates.filter((candidate) => candidate.running && candidate.hasFrame);
}

/**
 * Which screen to show after `current` disappears. A screen with a handoff
 * request wins, then the first listed one, then nothing. The current screen is
 * kept while it is still listed.
 */
export function fallbackScreen(candidates: readonly ScreenCandidate[], current: string | null): string | null {
  const listed = listableScreens(candidates);
  if (current !== null && listed.some((candidate) => candidate.id === current)) return current;
  const handoff = listed.find((candidate) => candidate.handoffRequested === true);
  return handoff?.id ?? listed[0]?.id ?? null;
}

/**
 * Runs `work` but gives up after `ms`, reporting the timeout as an error. A
 * status request that never answers must become an error the person can retry,
 * not a spinner that never stops.
 */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  clock: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void } = globalThis,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: true } | { ok: false; timedOut: false; error: unknown }> {
  const controller = new AbortController();
  let timer: unknown = null;
  const timeout = new Promise<{ ok: false; timedOut: true }>((resolve) => {
    timer = clock.setTimeout(() => {
      controller.abort();
      resolve({ ok: false, timedOut: true });
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal).then((value) => ({ ok: true as const, value })), timeout]);
  } catch (error) {
    return { ok: false, timedOut: false, error };
  } finally {
    if (timer !== null) clock.clearTimeout(timer);
  }
}
