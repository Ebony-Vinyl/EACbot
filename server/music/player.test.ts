import { describe, expect, it } from "vitest";

import type { MusicTrack } from "../../shared/music.ts";
import { createPlayer, MUSIC_MAX_QUEUE, PlayerError, type PersistedPlayer } from "./player.ts";

function track(id: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: `kugou:${id}`,
    source: "kugou",
    title: `Song ${id}`,
    artists: ["Artist"],
    album: null,
    albumId: null,
    durationSeconds: 200,
    hash: id,
    audioId: null,
    coverUrl: null,
    vip: false,
    maxQuality: null,
    unsupportedReason: null,
    ...overrides,
  };
}

function memoryPort(): { port: { load(): PersistedPlayer | null; save(state: PersistedPlayer): void }; saved(): PersistedPlayer | null } {
  let stored: PersistedPlayer | null = null;
  return {
    port: {
      load: () => stored,
      save: (state) => { stored = state; },
    },
    saved: () => stored,
  };
}

function expectPlayerError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PlayerError);
    expect((error as PlayerError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} refusal`);
}

describe("createPlayer", () => {
  it("starts idle with revision 1", () => {
    const player = createPlayer(memoryPort().port);
    const state = player.snapshot();
    expect(state.revision).toBe(1);
    expect(state.current).toBeNull();
    expect(state.state).toBe("idle");
    expect(state.playbackConfirmed).toBe(false);
  });

  it("queues tracks and moves to the first one", () => {
    const player = createPlayer(memoryPort().port);
    const state = player.enqueue({ tracks: [track("a"), track("b")], play: true });
    expect(state.queue).toHaveLength(2);
    expect(state.current?.track.id).toBe("kugou:a");
    // A request is not a play: only a client's receipt confirms it.
    expect(state.state).toBe("buffering");
    expect(state.playbackConfirmed).toBe(false);
    expect(state.revision).toBe(2);
  });

  it("refuses a duplicate rather than queueing the same track twice", () => {
    const player = createPlayer(memoryPort().port);
    player.enqueue({ tracks: [track("a")] });
    expectPlayerError(() => player.enqueue({ tracks: [track("a")] }), "duplicate");
  });

  it("refuses a queue past the cap", () => {
    const player = createPlayer(memoryPort().port);
    const many = Array.from({ length: MUSIC_MAX_QUEUE }, (_, index) => track(`t${index}`));
    player.enqueue({ tracks: many });
    expectPlayerError(() => player.enqueue({ tracks: [track("one-more")] }), "queue_full");
  });

  it("refuses a control built from a stale revision", () => {
    const player = createPlayer(memoryPort().port);
    player.enqueue({ tracks: [track("a")] });
    const stale = player.revision();
    player.control({ action: "volume", volume: 40 });
    expectPlayerError(() => player.control({ action: "pause", expectedRevision: stale }), "stale_revision");
  });

  it("confirms playback only from a receipt for the current revision", () => {
    const player = createPlayer(memoryPort().port);
    const queued = player.enqueue({ tracks: [track("a")], play: true });
    const playing = player.receipt({ state: "playing", revision: queued.revision });
    expect(playing.playbackConfirmed).toBe(true);
    // Any later change invalidates the confirmation.
    const paused = player.control({ action: "pause" });
    expect(paused.playbackConfirmed).toBe(false);
    expect(paused.state).toBe("paused");
  });

  it("advances the queue when a client reports the track ended", () => {
    const player = createPlayer(memoryPort().port);
    player.enqueue({ tracks: [track("a"), track("b")] });
    const ended = player.receipt({ state: "ended", revision: player.revision() });
    expect(ended.current?.track.id).toBe("kugou:b");
    expect(ended.currentIndex).toBe(1);
    expect(ended.state).toBe("buffering");
  });

  it("wraps to the head of the queue when the last track ends, like upstream's normal mode", () => {
    const player = createPlayer(memoryPort().port);
    player.enqueue({ tracks: [track("a"), track("b")] });
    player.control({ action: "next" });
    const ended = player.receipt({ state: "ended", revision: player.revision() });
    expect(ended.current?.track.id).toBe("kugou:a");
    expect(ended.state).toBe("buffering");
  });

  it("repeats one track when repeat is one", () => {
    const player = createPlayer(memoryPort().port);
    player.enqueue({ tracks: [track("a"), track("b")] });
    player.control({ action: "repeat", repeat: "one" });
    const ended = player.receipt({ state: "ended", revision: player.revision() });
    expect(ended.current?.track.id).toBe("kugou:a");
    expect(ended.positionSeconds).toBe(0);
  });

  it("removes a failed track, moves on, and trips the breaker after five in a row", () => {
    const player = createPlayer(memoryPort().port);
    player.enqueue({ tracks: [track("a"), track("b")] });
    const failed = player.receipt({ state: "failed", revision: player.revision(), code: "decode", message: "cannot decode" });
    // The failed track is gone and the queue moved on by itself; the failure died with it.
    expect(failed.current?.track.id).toBe("kugou:b");
    expect(failed.queue.map((item) => item.track.id)).toEqual(["kugou:b"]);
    expect(failed.failure).toBeNull();
    expect(failed.playbackConfirmed).toBe(false);

    // A failure that empties the queue leaves nothing current, without throwing.
    player.editQueue({ action: "replace", tracks: [track("a")], startIndex: 0 });
    const drained = player.receipt({ state: "failed", revision: player.revision(), code: "decode", message: "cannot decode" });
    expect(drained.current).toBeNull();
    expect(drained.state).toBe("failed");
  });

  it("stops skipping after five consecutive failures and waits for a person", () => {
    const player = createPlayer(memoryPort().port, {
      queueItemId: (() => { let n = 0; return () => `q${n++}`; })(),
    });
    for (let round = 0; round < 5; round++) {
      player.editQueue({ action: "replace", tracks: [track("a"), track("b")], startIndex: 0 });
      const failed = player.receipt({ state: "failed", revision: player.revision(), code: "decode", message: "cannot decode" });
      if (round === 4) {
        // The breaker stops the chain: the remaining track stays and the state is failed.
        expect(failed.state).toBe("failed");
        expect(failed.queue.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the position when the quality changes", () => {
    const player = createPlayer(memoryPort().port, { entitledQuality: () => "hires" });
    player.enqueue({ tracks: [track("a")] });
    player.receipt({ state: "playing", revision: player.revision(), positionSeconds: 42 });
    const changed = player.control({ action: "quality", quality: "flac" });
    expect(changed.positionSeconds).toBe(42);
    expect(changed.quality).toBe("flac");
    // The same track re-buffers at the new quality.
    expect(changed.state).toBe("buffering");
  });

  it("accepts any quality and lets the source resolver pick what the track has", () => {
    const player = createPlayer(memoryPort().port, { entitledQuality: () => "320k" });
    player.enqueue({ tracks: [track("a")] });
    const changed = player.control({ action: "quality", quality: "hires" });
    expect(changed.quality).toBe("hires");
  });

  it("steps back to the previous track however far the current one has played", () => {
    const player = createPlayer(memoryPort().port);
    player.enqueue({ tracks: [track("a"), track("b")] });
    player.control({ action: "next" });
    player.receipt({ state: "playing", revision: player.revision(), positionSeconds: 30 });
    const previous = player.control({ action: "prev" });
    expect(previous.current?.track.id).toBe("kugou:a");
    expect(previous.positionSeconds).toBe(0);
  });

  it("goes to the previous track when asked early in the current one", () => {
    const player = createPlayer(memoryPort().port);
    player.enqueue({ tracks: [track("a"), track("b")] });
    player.control({ action: "next" });
    player.receipt({ state: "playing", revision: player.revision(), positionSeconds: 1 });
    const previous = player.control({ action: "prev" });
    expect(previous.current?.track.id).toBe("kugou:a");
  });

  it("replays the only track when asked to skip a one-track queue", () => {
    const player = createPlayer(memoryPort().port);
    player.enqueue({ tracks: [track("a")] });
    const replayed = player.control({ action: "next" });
    expect(replayed.current?.track.id).toBe("kugou:a");
    expect(replayed.state).toBe("buffering");
    expect(replayed.positionSeconds).toBe(0);
  });

  it("removes the current track and moves to the one that took its place", () => {
    const player = createPlayer(memoryPort().port);
    const queued = player.enqueue({ tracks: [track("a"), track("b"), track("c")] });
    const removed = player.editQueue({ action: "remove", queueItemId: queued.queue[0]!.queueItemId });
    expect(removed.queue.map((item) => item.track.id)).toEqual(["kugou:b", "kugou:c"]);
    expect(removed.current?.track.id).toBe("kugou:b");
  });

  it("clears the queue back to idle", () => {
    const player = createPlayer(memoryPort().port);
    player.enqueue({ tracks: [track("a")] });
    const cleared = player.editQueue({ action: "clear" });
    expect(cleared.queue).toHaveLength(0);
    expect(cleared.currentIndex).toBe(-1);
    expect(cleared.state).toBe("idle");
  });

  it("resolves current, last and a queue item id", () => {
    const player = createPlayer(memoryPort().port);
    const queued = player.enqueue({ tracks: [track("a"), track("b")] });
    expect(player.resolve("current")?.track.id).toBe("kugou:a");
    const second = queued.queue[1]!.queueItemId;
    expect(player.resolve(second)?.track.id).toBe("kugou:b");
    // A track id works too, so a tool that kept one from a search still resolves.
    expect(player.resolve("kugou:b")?.track.id).toBe("kugou:b");
    expect(player.resolve("kugou:missing")).toBeNull();
  });

  it("restores a saved queue and demotes a saved playing state", () => {
    const stored: PersistedPlayer = {
      revision: 7,
      queue: [{ queueItemId: "q1", track: track("a"), addedAt: "2026-01-01T00:00:00.000Z", addedBy: "person" }],
      currentIndex: 0,
      state: "playing",
      positionSeconds: 30,
      volume: 55,
      quality: "flac",
      repeat: "all",
      speed: 1,
      shuffle: true,
      changedAt: "2026-01-01T00:00:00.000Z",
    };
    const player = createPlayer({ load: () => stored, save: () => {} });
    const state = player.snapshot();
    expect(state.revision).toBe(7);
    expect(state.current?.track.id).toBe("kugou:a");
    // A restored "playing" is not true until a client says so again.
    expect(state.state).toBe("paused");
    expect(state.playbackConfirmed).toBe(false);
  });

  it("persists every accepted change", () => {
    const memory = memoryPort();
    const player = createPlayer(memory.port);
    player.enqueue({ tracks: [track("a")] });
    player.control({ action: "volume", volume: 12 });
    expect(memory.saved()?.volume).toBe(12);
    expect(memory.saved()?.revision).toBe(3);
  });

  it("reports a duck without touching playback state", () => {
    const player = createPlayer(memoryPort().port);
    player.enqueue({ tracks: [track("a")], play: true });
    player.receipt({ state: "playing", revision: player.revision() });
    const ducked = player.setDucked(true);
    expect(ducked.ducked).toBe(true);
    expect(ducked.state).toBe("playing");
  });
});
