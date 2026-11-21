// The music store: one snapshot from the server, kept live by SSE frames, plus the
// engine that actually makes sound. Every control goes through the server first
// (so the queue and the revision are the server's), then the engine follows the
// snapshot. A receipt is sent only after the engine has done something.
import { useSyncExternalStore } from "react";

import type {
  MusicAccount,
  MusicAdapterSummary,
  MusicEq,
  MusicPlayback,
  MusicQuality,
  MusicReceipt,
  MusicSnapshot,
  MusicTrack,
  NowPlayingTheme,
} from "../../../shared/music.ts";
import { api } from "@/lib/music/ports";
import { listenLiveFrames } from "@/lib/music/ports";
import { MusicEngine } from "./engine";

interface MusicState {
  playback: MusicPlayback | null;
  account: MusicAccount | null;
  adapters: MusicAdapterSummary[];
  eq: MusicEq | null;
  theme: NowPlayingTheme;
  /** The track the engine holds a stream URL for, so a snapshot that only changed the volume does not reload. */
  loadedTrackId: string | null;
  loadedQuality: MusicQuality | null;
  /** True when the browser refused autoplay and the person must tap. */
  needsGesture: boolean;
  loading: boolean;
  error: { code: string; message: string } | null;
}

const EMPTY: MusicState = {
  playback: null,
  account: null,
  adapters: [],
  eq: null,
  theme: "standard",
  loadedTrackId: null,
  loadedQuality: null,
  needsGesture: false,
  loading: false,
  error: null,
};

let state: MusicState = EMPTY;
let engine: MusicEngine | null = null;
let unsubscribeFrames: (() => void) | null = null;
const listeners = new Set<() => void>();
/** Guards against two loads of the same track racing, e.g. a snapshot and a control landing together. */
let loadSequence = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function set(patch: Partial<MusicState>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): MusicState {
  return state;
}

/** The engine reports what it did; the server is the only place playback truth is recorded. */
async function receipt(input: MusicReceipt): Promise<void> {
  try {
    const answer = await api<{ playback: MusicPlayback }>("/api/music/receipts", {
      method: "POST",
      body: JSON.stringify(input),
    });
    set({ playback: answer.playback });
    if (answer.playback.current) {
      set({ loadedTrackId: answer.playback.current.track.id });
    }
  } catch {
    // A lost receipt is not fatal: the next snapshot still says the truth.
  }
}

function buildEngine(): MusicEngine {
  const created = new MusicEngine({
    events: {
      onPlaying: (trackId) => {
        set({ needsGesture: false });
        void receipt({ state: "playing", revision: state.playback?.revision ?? 1, ...(engine ? { positionSeconds: engine.positionSeconds } : {}) });
        void trackId;
      },
      onPaused: () => {
        void receipt({ state: "paused", revision: state.playback?.revision ?? 1, ...(engine ? { positionSeconds: engine.positionSeconds } : {}) });
      },
      onBuffering: () => {
        void receipt({ state: "buffering", revision: state.playback?.revision ?? 1 });
      },
      onEnded: () => {
        void receipt({ state: "ended", revision: state.playback?.revision ?? 1 });
      },
      onError: (_trackId, code, message) => {
        set({ error: { code, message } });
        void receipt({ state: "failed", revision: state.playback?.revision ?? 1, code, message });
      },
      onProgress: (positionSeconds, durationSeconds) => {
        // Progress is local: a receipt every quarter second would flood the server.
        if (state.playback) set({ playback: { ...state.playback, positionSeconds } });
        void durationSeconds;
      },
    },
  });
  if (state.eq) created.setEq(state.eq);
  return created;
}

/** Loads whatever the snapshot says should be playing, if the engine is not already on it. */
async function followSnapshot(playback: MusicPlayback): Promise<void> {
  const current = playback.current;
  if (!current) {
    engine?.pause();
    set({ loadedTrackId: null, loadedQuality: null });
    return;
  }
  const track = current.track;
  const shouldSound = playback.state === "playing" || playback.state === "buffering";
  const alreadyLoaded = state.loadedTrackId === track.id && state.loadedQuality === playback.quality;
  if (!engine) {
    if (!shouldSound) return;
    return;
  }
  if (alreadyLoaded) {
    if (playback.state === "paused") engine.pause();
    if (playback.state === "playing" && engine.positionSeconds === 0) engine.play();
    return;
  }
  const sequence = ++loadSequence;
  set({ loading: true, error: null });
  try {
    const answer = await api<{ handles: Array<{ trackId: string; url?: string; error?: { code: string; message: string } }> }>("/api/music/stream", {
      method: "POST",
      body: JSON.stringify({ trackIds: [track.id], quality: playback.quality }),
    });
    if (sequence !== loadSequence) return;
    const handle = answer.handles[0];
    if (!handle?.url) {
      const error = handle?.error ?? { code: "source_unavailable", message: "the server could not resolve this track" };
      set({ error, loading: false });
      if (shouldSound) void receipt({ state: "failed", revision: playback.revision, code: error.code, message: error.message });
      return;
    }
    set({ loadedTrackId: track.id, loadedQuality: playback.quality, loading: false });
    await engine.load({
      track,
      url: handle.url,
      quality: playback.quality,
      ...(playback.positionSeconds > 1 ? { startAt: playback.positionSeconds } : {}),
      autoplay: shouldSound,
    });
    set({ needsGesture: engine.gestureRequired });
  } catch (error) {
    if (sequence !== loadSequence) return;
    const body = (error as { body?: { error?: { code: string; message: string } } }).body;
    set({
      loading: false,
      error: body?.error ?? { code: "source_unavailable", message: error instanceof Error ? error.message : String(error) },
    });
  }
}

export const musicStore = {
  subscribe,
  getSnapshot: snapshot,

  /** One initial read; SSE keeps it current afterwards. */
  async load(): Promise<void> {
    set({ loading: true });
    try {
      const [snapshotAnswer, eqAnswer, themeAnswer] = await Promise.all([
        api<MusicSnapshot>("/api/music"),
        api<{ eq: MusicEq }>("/api/music/eq").catch(() => ({ eq: null })),
        api<{ theme: NowPlayingTheme }>("/api/music/theme").catch(() => ({ theme: "standard" as NowPlayingTheme })),
      ]);
      set({
        playback: snapshotAnswer.playback,
        account: snapshotAnswer.account,
        adapters: snapshotAnswer.adapters,
        eq: eqAnswer.eq,
        theme: themeAnswer.theme,
        loading: false,
      });
      engine?.setEq(eqAnswer.eq ?? { gains: [], preset: "flat", enabled: false });
    } catch (error) {
      const body = (error as { body?: { error?: { code: string; message: string } } }).body;
      set({ loading: false, error: body?.error ?? { code: "source_unavailable", message: error instanceof Error ? error.message : String(error) } });
    }
  },

  /** Starts listening for the server's music frames. Idempotent. */
  connect(): void {
    if (unsubscribeFrames) return;
    unsubscribeFrames = listenLiveFrames({
      onFrame: (frame) => {
        if (frame.kind === "music.state" && frame.playback) {
          const playback = frame.playback as MusicPlayback;
          set({ playback });
          void followSnapshot(playback);
        }
        if (frame.kind === "music.account" && frame.account) set({ account: frame.account as MusicAccount });
        if (frame.kind === "music.eq" && frame.eq) {
          set({ eq: frame.eq as MusicEq });
          engine?.setEq(frame.eq as MusicEq);
        }
        if (frame.kind === "music.theme" && typeof frame.theme === "string") set({ theme: frame.theme as NowPlayingTheme });
      },
    });
  },

  /** Creates the audio graph. Must be called from a click the first time. */
  async unlock(): Promise<void> {
    engine ??= buildEngine();
    await engine.unlock();
    set({ needsGesture: engine.gestureRequired });
    if (state.playback) void followSnapshot(state.playback);
  },

  /** The analyser the visualizer and the mascot read. */
  analyser(): AnalyserNode | null {
    return engine?.analyserNode ?? null;
  },

  async control(input: {
    action: "play" | "pause" | "resume" | "next" | "prev" | "seek" | "volume" | "quality" | "repeat" | "shuffle";
    positionSeconds?: number;
    volume?: number;
    quality?: MusicQuality;
    repeat?: "off" | "one" | "all";
    shuffle?: boolean;
  }): Promise<void> {
    try {
      const answer = await api<{ playback: MusicPlayback }>("/api/music/control", {
        method: "POST",
        body: JSON.stringify({ ...input, expectedRevision: state.playback?.revision }),
      });
      set({ playback: answer.playback, error: null });
      // A volume change is the graph's job, not a reload.
      if (input.action === "volume" && input.volume !== undefined) engine?.setVolume(input.volume);
      if (input.action === "pause") engine?.pause();
      if (input.action === "seek" && input.positionSeconds !== undefined) engine?.seek(input.positionSeconds);
      if (input.action !== "volume" && input.action !== "seek") void followSnapshot(answer.playback);
    } catch (error) {
      const body = (error as { body?: { error?: { code: string; message: string } } }).body;
      set({ error: body?.error ?? { code: "source_unavailable", message: error instanceof Error ? error.message : String(error) } });
    }
  },

  async playTracks(trackIds: readonly string[], position: "end" | "next" | "now" = "end"): Promise<void> {
    try {
      const answer = await api<{ playback: MusicPlayback }>("/api/music/queue", {
        method: "POST",
        body: JSON.stringify({ action: "add", trackIds, position }),
      });
      set({ playback: answer.playback, error: null });
      await this.control({ action: "play" });
    } catch (error) {
      const body = (error as { body?: { error?: { code: string; message: string } } }).body;
      set({ error: body?.error ?? { code: "source_unavailable", message: error instanceof Error ? error.message : String(error) } });
    }
  },

  async editQueue(input: { action: "add" | "remove" | "clear" | "move" | "replace"; queueItemId?: string; index?: number; to?: number; trackIds?: string[]; position?: "end" | "next" }): Promise<void> {
    try {
      const answer = await api<{ playback: MusicPlayback }>("/api/music/queue", {
        method: "POST",
        body: JSON.stringify({ ...input, expectedRevision: state.playback?.revision }),
      });
      set({ playback: answer.playback });
      if (input.action === "add") return;
      void followSnapshot(answer.playback);
    } catch (error) {
      const body = (error as { body?: { error?: { code: string; message: string } } }).body;
      set({ error: body?.error ?? { code: "source_unavailable", message: error instanceof Error ? error.message : String(error) } });
    }
  },

  async setEq(eq: MusicEq): Promise<void> {
    const answer = await api<{ eq: MusicEq }>("/api/music/eq", { method: "PUT", body: JSON.stringify(eq) });
    set({ eq: answer.eq });
    engine?.setEq(answer.eq);
  },

  async setTheme(theme: NowPlayingTheme): Promise<void> {
    const answer = await api<{ theme: NowPlayingTheme }>("/api/music/theme", { method: "PUT", body: JSON.stringify({ theme }) });
    set({ theme: answer.theme });
  },

  /** A renderer-side speed: the server's timeline stays in real seconds, so nothing on the wire changes. */
  setRate(rate: number): void {
    engine?.setRate(rate);
  },

  /** Music ducked or restored: the server already knows through its focus leases, so this only applies it. */
  applyDucked(ducked: boolean): void {
    if (ducked) engine?.duck();
    else engine?.unduck();
  },

  clearError(): void {
    set({ error: null });
  },

  async disconnect(): Promise<void> {
    unsubscribeFrames?.();
    unsubscribeFrames = null;
    engine?.dispose();
    engine = null;
    state = EMPTY;
    emit();
  },
};

/** The hook a component reads the music state with. */
export function useMusic(): MusicState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The current track's label, for a compact bar. */
export function trackLabelOf(track: MusicTrack | null | undefined): string {
  if (!track) return "";
  return track.artists.length ? `${track.title} — ${track.artists.join(", ")}` : track.title;
}
