import { describe, expect, it } from "vitest";

import { AudioFocusManager } from "./audio-focus.ts";
import { AudioStreamTracker } from "./audio-stream.ts";
import type { AudioChunk } from "../../shared/plugins/audio.ts";

function manager(start = 1_000) {
  let now = start;
  let id = 0;
  const focus = new AudioFocusManager({ now: () => now, leaseId: () => `lease-${++id}` });
  return { focus, advance: (ms: number) => { now += ms; } };
}

const chunk = (overrides: Partial<AudioChunk> = {}): AudioChunk => ({
  streamId: "s1", generation: 0, sequence: 0, format: "pcm16", sampleRate: 24_000, channels: 1, data: "AA==", ...overrides,
});

describe("audio focus", () => {
  it("pauses music for speech and resumes it when the user did nothing", () => {
    const { focus } = manager();
    focus.musicStarted();
    const speech = focus.claim("speech", "tts", 10_000);
    expect(speech).toMatchObject({ ok: true, pausedMusic: true });
    expect(focus.snapshot().musicPlaying).toBe(false);
    if (!speech.ok) return;
    expect(focus.release(speech.lease.leaseId)).toMatchObject({ ok: true, restoredMusic: true });
    expect(focus.snapshot().musicPlaying).toBe(true);
  });

  it("does not resume music the person paused while speech was speaking", () => {
    const { focus } = manager();
    focus.musicStarted();
    const speech = focus.claim("speech", "tts", 10_000);
    expect(speech.ok).toBe(true);
    focus.userPause();
    if (!speech.ok) return;
    expect(focus.release(speech.lease.leaseId)).toMatchObject({ ok: true, restoredMusic: false });
    expect(focus.snapshot()).toMatchObject({ musicPlaying: false, musicPausedByUser: true });
  });

  it("does not re-apply a volume change made during the lease", () => {
    const { focus } = manager();
    focus.musicStarted();
    const speech = focus.claim("speech", "tts", 10_000);
    if (!speech.ok) return;
    focus.userVolumeChanged();
    expect(focus.release(speech.lease.leaseId)).toMatchObject({ ok: true, restoredMusic: false });
  });

  it("lets a higher priority alert preempt speech but refuses a lower one", () => {
    const { focus } = manager();
    const speech = focus.claim("speech", "tts", 10_000);
    expect(speech.ok).toBe(true);
    expect(focus.claim("music", "player", 10_000)).toMatchObject({ ok: false, code: "BUSY" });
    const alert = focus.claim("alert", "alarm", 10_000);
    expect(alert.ok).toBe(true);
    if (!speech.ok || !alert.ok) return;
    expect(focus.release(speech.lease.leaseId)).toMatchObject({ ok: false, code: "NOT_HOLDER" });
    expect(focus.release(alert.lease.leaseId)).toMatchObject({ ok: true });
  });

  it("expires a stale lease and rejects an out-of-range ttl", () => {
    const { focus, advance } = manager();
    const speech = focus.claim("speech", "tts", 1_000);
    expect(speech.ok).toBe(true);
    advance(1_001);
    expect(focus.snapshot().active).toBeNull();
    if (speech.ok) expect(focus.release(speech.lease.leaseId)).toMatchObject({ ok: true, restoredMusic: false });
    expect(focus.claim("speech", "tts", 10)).toMatchObject({ ok: false, code: "INVALID_TTL" });
  });

  it("restores music paused for speech after a preempting alert ends", () => {
    const { focus } = manager();
    focus.musicStarted();
    const speech = focus.claim("speech", "tts", 10_000);
    expect(speech).toMatchObject({ ok: true, pausedMusic: true });
    const alert = focus.claim("alert", "alarm", 10_000);
    expect(alert.ok).toBe(true);
    if (!alert.ok) return;
    expect(focus.release(alert.lease.leaseId)).toMatchObject({ ok: true, restoredMusic: true });
    expect(focus.snapshot().musicPlaying).toBe(true);
  });
});

describe("audio stream sequencing", () => {
  it("accepts in order, ignores duplicates and asks for a resync on a gap", () => {
    const tracker = new AudioStreamTracker();
    expect(tracker.accept(chunk())).toMatchObject({ action: "accepted", expected: 1 });
    expect(tracker.accept(chunk({ sequence: 1 }))).toMatchObject({ action: "accepted", expected: 2 });
    expect(tracker.accept(chunk({ sequence: 1 }))).toMatchObject({ action: "duplicate" });
    expect(tracker.accept(chunk({ sequence: 5 }))).toMatchObject({ action: "gap", expected: 2 });
  });

  it("drops a frame from an older generation and restarts on a new one", () => {
    const tracker = new AudioStreamTracker();
    tracker.accept(chunk());
    expect(tracker.accept(chunk({ generation: 1, sequence: 0 }))).toMatchObject({ action: "accepted" });
    expect(tracker.accept(chunk({ generation: 0, sequence: 1 }))).toMatchObject({ action: "stale" });
  });

  it("flags a format change instead of decoding it as the same stream", () => {
    const tracker = new AudioStreamTracker();
    tracker.accept(chunk());
    expect(tracker.accept(chunk({ sequence: 1, sampleRate: 48_000 }))).toMatchObject({ action: "format-mismatch" });
  });
});
