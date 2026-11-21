// The music player's persisted state, split the way upstream's cache service is:
// playback settings are written through at once, while the queue cache is
// debounced and carries a schema version plus a song key, so a restart finds the
// same track again even when indexes moved. The queue cache is a rebuildable
// warm copy — a corrupt or empty one falls back to "no queue", never to an error.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { MusicPlayback, MusicQuality, MusicRepeatMode, MusicQueueItem } from "../../shared/music.ts";
import type { PersistedPlayer, PlayerStatePort } from "./player.ts";

export const MUSIC_PLAYER_FILE = "music-player.json";
export const MUSIC_QUEUE_FILE = "music-queue.json";

const QUEUE_SCHEMA_VERSION = 1;
/** The queue cache lands this long after the last change, like upstream's 250 ms debounce. */
const QUEUE_SAVE_DEBOUNCE_MS = 250;

interface SettingsShape {
  volume: number;
  quality: MusicQuality;
  repeat: MusicRepeatMode;
  shuffle: boolean;
  speed: number;
}

interface QueueShape {
  schemaVersion: number;
  updatedAt: string;
  currentSongKey: string;
  queue: MusicQueueItem[];
}

const QUALITIES = new Set<MusicQuality>(["128k", "320k", "flac", "hires"]);
const REPEATS = new Set<MusicRepeatMode>(["off", "one", "all"]);

/** Upstream drops cache rows that could never be resolved again; so do we. */
function resolvable(item: MusicQueueItem): boolean {
  const track = item.track;
  if (!item.queueItemId || !track?.id) return false;
  return Boolean(track.hash || track.albumId || track.audioId || track.title || track.source !== "kugou");
}

/** hash first, then a local file path, then a provider file id, then name and singer. */
export function songKeyOf(item: MusicQueueItem): string {
  const track = item.track;
  if (track.hash) return `hash:${track.hash.toLowerCase()}`;
  if (track.audioId) return `file:${track.audioId}`;
  return `song:${track.title}:${track.artists.join(",")}`;
}

function settingsFrom(record: Record<string, unknown>): SettingsShape {
  return {
    volume: Number.isFinite(record.volume) ? Math.min(Math.max(Number(record.volume), 0), 100) : 70,
    quality: QUALITIES.has(record.quality as MusicQuality) ? record.quality as MusicQuality : "320k",
    repeat: REPEATS.has(record.repeat as MusicRepeatMode) ? record.repeat as MusicRepeatMode : "off",
    shuffle: record.shuffle === true,
    speed: Number.isFinite(record.speed) ? Math.min(Math.max(Number(record.speed), 0.5), 2) : 1,
  };
}

function queueFrom(record: Record<string, unknown>): QueueShape | null {
  const version = Number(record.schemaVersion ?? QUEUE_SCHEMA_VERSION);
  if (version !== QUEUE_SCHEMA_VERSION) return null;
  if (!Array.isArray(record.queue)) return null;
  const queue = (record.queue as unknown[]).filter((item): item is MusicQueueItem =>
    Boolean(item) && typeof item === "object" && resolvable(item as MusicQueueItem));
  // A cache whose every row is unusable is not a cache.
  if (!queue.length) return null;
  return {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
    currentSongKey: typeof record.currentSongKey === "string" ? record.currentSongKey : "",
    queue,
  };
}

/** The key the saved queue says is current, matched against the restored rows. */
function restoreIndex(saved: QueueShape): number {
  if (saved.currentSongKey) {
    const at = saved.queue.findIndex((item) => songKeyOf(item) === saved.currentSongKey);
    if (at >= 0) return at;
  }
  return 0;
}

export function createFilePlayerPort(dataDir: string): PlayerStatePort {
  const settingsFile = join(dataDir, MUSIC_PLAYER_FILE);
  const queueFile = join(dataDir, MUSIC_QUEUE_FILE);
  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingQueue: QueueShape | null = null;

  const writeJson = (file: string, value: unknown): void => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      chmodSync(file, 0o600);
    } catch {
      // A read-only data directory must not break playback; the next change retries.
    }
  };

  const flushQueue = (): void => {
    queueTimer = null;
    if (!pendingQueue) return;
    writeJson(queueFile, pendingQueue);
    pendingQueue = null;
  };

  return {
    load() {
      let settings: SettingsShape = { volume: 70, quality: "320k", repeat: "off", shuffle: false, speed: 1 };
      try {
        const raw = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
        if (raw && typeof raw === "object") settings = settingsFrom(raw);
      } catch {
        // No settings yet: the defaults above stand.
      }
      let saved: QueueShape | null = null;
      try {
        const raw = JSON.parse(readFileSync(queueFile, "utf8")) as Record<string, unknown>;
        if (raw && typeof raw === "object") saved = queueFrom(raw);
      } catch {
        saved = null;
      }
      // A restored queue resumes silent at the top of its saved current track, like upstream.
      if (!saved) {
        return {
          revision: 1,
          queue: [],
          currentIndex: -1,
          state: "idle",
          positionSeconds: 0,
          ...settings,
          changedAt: new Date().toISOString(),
        };
      }
      const currentIndex = restoreIndex(saved);
      return {
        revision: 1,
        queue: saved.queue,
        currentIndex,
        state: "paused",
        positionSeconds: 0,
        ...settings,
        changedAt: saved.updatedAt,
      };
    },

    save(state: PersistedPlayer) {
      const settings: SettingsShape = { volume: state.volume, quality: state.quality, repeat: state.repeat, shuffle: state.shuffle, speed: state.speed };
      writeJson(settingsFile, settings);
      if (!state.queue.length) {
        // An empty queue deletes the cache rather than storing an empty row.
        if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
        pendingQueue = null;
        try { rmSync(queueFile, { force: true }); } catch { /* already gone */ }
        return;
      }
      pendingQueue = {
        schemaVersion: QUEUE_SCHEMA_VERSION,
        updatedAt: state.changedAt,
        currentSongKey: state.queue[state.currentIndex] ? songKeyOf(state.queue[state.currentIndex]!) : "",
        queue: state.queue,
      };
      // The queue is a warm copy: coalesce bursts of changes (seek, receipts) into one write.
      if (!queueTimer) queueTimer = setTimeout(flushQueue, QUEUE_SAVE_DEBOUNCE_MS);
    },
  };
}

/** The wire snapshot of a restored state, before the player has run. */
export function playbackFromStored(stored: PersistedPlayer): MusicPlayback {
  const current = stored.queue[stored.currentIndex] ?? null;
  return {
    revision: stored.revision,
    current,
    queue: stored.queue,
    currentIndex: stored.currentIndex,
    // A restored "playing" is not true until a client says so again.
    state: stored.state === "playing" ? "paused" : stored.state,
    positionSeconds: stored.positionSeconds,
    volume: stored.volume,
    quality: stored.quality,
    repeat: stored.repeat,
    shuffle: stored.shuffle,
    speed: stored.speed,
    playbackConfirmed: false,
    failure: null,
    ducked: false,
    changedAt: stored.changedAt,
  };
}
