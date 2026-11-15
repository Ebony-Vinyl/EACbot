import { describe, expect, it } from "vitest";

import {
  OFF_SCREEN,
  createScreenStore,
  fallbackScreen,
  frameDrawn,
  listableScreens,
  screenCopy,
  screenEnded,
  screenSelected,
  streamFailed,
  streamLost,
  withDeadline,
  type ScreenCandidate,
} from "./screen-source.ts";

const candidate = (id: string, running = true, hasFrame = true, handoffRequested = false): ScreenCandidate =>
  ({ id, label: id, running, hasFrame, handoffRequested });

describe("the shared screen state", () => {
  it("notifies subscribers and stops after unsubscribe", () => {
    const store = createScreenStore();
    let calls = 0;
    const off = store.subscribe(() => void (calls += 1));
    store.update(() => screenSelected("s1", "Ada's computer"));
    expect(calls).toBe(1);
    off();
    store.update((state) => frameDrawn(state, 5));
    expect(calls).toBe(1);
  });

  it("does not notify when nothing changed", () => {
    const store = createScreenStore();
    let calls = 0;
    store.subscribe(() => void (calls += 1));
    store.update((state) => ({ ...state }));
    expect(calls).toBe(0);
  });

  it("goes live on the first frame and remembers when it drew", () => {
    const state = frameDrawn(screenSelected("s1", "Ada"), 1_000);
    expect(state).toMatchObject({ phase: "live", hasFrame: true, lastFrameAt: 1_000, attempt: 0 });
  });

  it("keeps the last picture while reconnecting", () => {
    const live = frameDrawn(screenSelected("s1", "Ada"), 1_000);
    const lost = streamLost(live, 2, "socket closed");
    expect(lost.phase).toBe("reconnecting");
    expect(lost.hasFrame).toBe(true);
    expect(lost.lastFrameAt).toBe(1_000);
    expect(screenCopy(lost).title).toBe("Reconnecting");
    expect(screenCopy(lost).detail).toContain("last picture");
  });

  it("offers Retry after the retries ran out, still showing the last picture", () => {
    const failed = streamFailed(frameDrawn(screenSelected("s1", "Ada"), 1_000), "unreachable");
    expect(failed).toMatchObject({ phase: "error", retryable: true, hasFrame: true });
    expect(screenCopy(failed).detail).toBe("unreachable");
  });

  it("does not carry a previous screen's picture to a new one", () => {
    const previous = frameDrawn(screenSelected("s1", "Ada"), 1_000);
    const next = screenSelected("s2", "Grace");
    expect(previous.hasFrame).toBe(true);
    expect(next).toMatchObject({ phase: "starting", screenId: "s2", hasFrame: false, lastFrameAt: null });
  });

  it("has words for every phase, including nothing selected", () => {
    for (const state of [OFF_SCREEN, screenSelected("s", "Ada"), screenEnded(screenSelected("s", "Ada"), "exited"), streamFailed(OFF_SCREEN, "x")]) {
      expect(screenCopy(state).title.length).toBeGreaterThan(0);
      expect(screenCopy(state).detail.length).toBeGreaterThan(0);
    }
  });

  it("resets to nothing selected", () => {
    const store = createScreenStore(frameDrawn(screenSelected("s1", "Ada"), 1));
    store.reset();
    expect(store.getSnapshot()).toEqual(OFF_SCREEN);
  });
});

describe("which screens the multi-view lists", () => {
  it("lists only running screens that have drawn something", () => {
    expect(listableScreens([candidate("a"), candidate("b", false), candidate("c", true, false)]).map((entry) => entry.id)).toEqual(["a"]);
  });

  it("keeps the current screen while it is still listed", () => {
    expect(fallbackScreen([candidate("a"), candidate("b")], "b")).toBe("b");
  });

  it("prefers a screen asking for a handoff when the current one goes away", () => {
    expect(fallbackScreen([candidate("a"), candidate("b", true, true, true)], "gone")).toBe("b");
  });

  it("falls back to the first listed screen, then to none", () => {
    expect(fallbackScreen([candidate("a"), candidate("b")], null)).toBe("a");
    expect(fallbackScreen([candidate("a", false)], "a")).toBeNull();
    expect(fallbackScreen([], "a")).toBeNull();
  });
});

describe("a status request with a deadline", () => {
  it("returns the value when it arrives in time", async () => {
    expect(await withDeadline(async () => "ok", 1_000)).toEqual({ ok: true, value: "ok" });
  });

  it("reports a timeout instead of spinning forever", async () => {
    expect(await withDeadline(() => new Promise<string>(() => {}), 5)).toEqual({ ok: false, timedOut: true });
  });

  it("reports a failure as a failure", async () => {
    const result = await withDeadline(async () => {
      throw new Error("no route");
    }, 1_000);
    expect(result).toMatchObject({ ok: false, timedOut: false });
  });
});
