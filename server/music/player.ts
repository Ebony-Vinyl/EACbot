// The player's authoritative state. Every control names the revision it saw, so
// a command built from a stale snapshot is refused instead of applied to a queue
// the caller never saw. Only a client that actually holds an audio element may
// report what happened; until then `playbackConfirmed` stays false and no tool
// may say a song is playing.
//
// Queue semantics follow upstream's PlaybackQueueManager: shuffle physically
// reorders the queue around the current track (the original order is kept for
// restore), repeat modes are mutually exclusive with it, "normal" loops, and a
// failed track is removed and skipped automatically until five failures in a row
// trip the breaker.
import { randomUUID } from "node:crypto";

import {
  bestQuality,
  MUSIC_QUALITY_RANK,
  type MusicPlayback,
  type MusicQueueItem,
  type MusicQuality,
  type MusicReceipt,
  type MusicRepeatMode,
  type MusicTrack,
  type PlaybackState,
} from "../../shared/music.ts";

/** A queue longer than this is a mistake, not a playlist. */
export const MUSIC_MAX_QUEUE = 1_000;
/** Consecutive failures after which auto-skip stops and waits for a person. */
export const MUSIC_FAILURE_BREAKER = 5;

export type PlayerErrorCode =
  | "stale_revision"
  | "stale_receipt"
  | "empty_queue"
  | "queue_full"
  | "duplicate"
  | "not_found"
  | "invalid_input"
  | "unsupported_action"
  | "vip_required";

export class PlayerError extends Error {
  readonly code: PlayerErrorCode;
  constructor(code: PlayerErrorCode, message: string) {
    super(message);
    this.name = "PlayerError";
    this.code = code;
  }
}
export const MUSIC_CONTROL_ACTIONS = ["play", "pause", "resume", "next", "prev", "seek", "volume", "quality", "repeat", "shuffle", "speed"] as const;
export type MusicControlAction = (typeof MUSIC_CONTROL_ACTIONS)[number];

export const MUSIC_QUEUE_ACTIONS = ["add", "remove", "clear", "move", "replace"] as const;
export type MusicQueueAction = (typeof MUSIC_QUEUE_ACTIONS)[number];

export interface PlayerOptions {
  now?: () => string;
  /** A queue item id generator, swappable so a test can name its own entries. */
  queueItemId?: () => string;
  /** The quality ceiling the account may use. */
  entitledQuality?: () => MusicQuality;
  /** The quality the person asked for. */
  preferredQuality?: () => MusicQuality;
  /** Called after every accepted change, so the host can broadcast one frame. */
  changed?: (playback: MusicPlayback) => void;
  /** Called when a queue item first reports `playing`, so history records one play. */
  played?: (track: MusicTrack, queueItemId: string) => void;
  /** Called when a queue item reports `ended`, with the seconds it actually played. */
  endedPlayed?: (track: MusicTrack, playedSeconds: number) => void;
}

/** The persisted slice: everything except what only a live client can know. */
export interface PersistedPlayer {
  revision: number;
  queue: MusicQueueItem[];
  currentIndex: number;
  state: PlaybackState;
  positionSeconds: number;
  volume: number;
  quality: MusicQuality;
  repeat: MusicRepeatMode;
  shuffle: boolean;
  speed: number;
  changedAt: string;
}

export interface PlayerStatePort {
  load(): PersistedPlayer | null;
  save(state: PersistedPlayer): void;
}

export interface Player {
  snapshot(): MusicPlayback;
  /** The current revision, for a caller that only needs to name it. */
  revision(): number;
  /** Puts tracks on the queue and, when asked, starts one of them. */
  enqueue(input: { tracks: readonly MusicTrack[]; position?: "end" | "next" | "now"; startIndex?: number; by?: MusicQueueItem["addedBy"]; play?: boolean; expectedRevision?: number }): MusicPlayback;
  /** Edits the queue. `replace` is what a radio uses to hand over a fresh set. */
  editQueue(input: { action: MusicQueueAction; queueItemId?: string; index?: number; to?: number; tracks?: readonly MusicTrack[]; startIndex?: number; expectedRevision?: number }): MusicPlayback;
  control(input: { action: MusicControlAction; expectedRevision?: number; positionSeconds?: number; volume?: number; quality?: MusicQuality; repeat?: MusicRepeatMode; shuffle?: boolean; speed?: number }): MusicPlayback;
  /** A client's report of what its audio element did. The only writer of playback truth. */
  receipt(input: MusicReceipt): MusicPlayback;
  /** Marks music ducked or restored as speech takes and releases audio focus. */
  setDucked(ducked: boolean): MusicPlayback;
  /** The track the queue says is current, without the wire wrapper. */
  currentTrack(): MusicTrack | null;
  /** Resolves a `target` a tool was given to a queue item. */
  resolve(target: "current" | "last" | string): MusicQueueItem | null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function createPlayer(port: PlayerStatePort, options: PlayerOptions = {}): Player {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.queueItemId ?? (() => `q_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`);
  const entitled = options.entitledQuality ?? (() => "320k" as MusicQuality);
  const preferred = options.preferredQuality ?? (() => "320k" as MusicQuality);

  const restored = port.load();
  let revision = restored?.revision ?? 1;
  let queue: MusicQueueItem[] = restored?.queue ?? [];
  let currentIndex = restored?.currentIndex ?? -1;
  // A saved "playing" is not true until a client says so again: nothing is sounding at boot.
  let state: PlaybackState = restored?.state === "playing" ? "paused" : restored?.state ?? "idle";
  // A restored queue resumes silent at the top of the saved current track, like upstream.
  let positionSeconds = 0;
  let volume = restored?.volume ?? 70;
  let quality: MusicQuality = restored?.quality ?? preferred();
  let repeat: MusicRepeatMode = restored?.repeat ?? "off";
  let shuffle = restored?.shuffle ?? false;
  let speed = restored?.speed ?? 1;
  let ducked = false;
  let failure: { code: string; message: string } | null = null;
  let consecutiveFailures = 0;
  /** The revision a receipt has to name to count as confirmation of the current one. */
  let confirmedRevision = 0;
  let changedAt = restored?.changedAt ?? now();
  /** `last` is what "that one" means after a track has moved on. */
  let lastTrack: MusicTrack | null = queue[currentIndex]?.track ?? null;
  /** The order to put back when shuffle turns off, as queue item ids in play order. */
  let originalOrder: string[] = queue.map((item) => item.queueItemId);
  /** Queue items whose `playing` already reached history, so a seek does not double-count. */
  const recordedPlays = new Set<string>();

  const persist = (): void => {
    port.save({
      revision,
      queue,
      currentIndex,
      state,
      positionSeconds,
      volume,
      quality,
      repeat,
      shuffle,
      speed,
      changedAt,
    });
  };

  const snapshot = (): MusicPlayback => {
    const current = queue[currentIndex] ?? null;
    return {
      revision,
      current,
      queue,
      currentIndex,
      state,
      positionSeconds,
      volume,
      quality,
      repeat,
      shuffle,
      speed,
      playbackConfirmed: confirmedRevision === revision && state === "playing",
      failure,
      ducked,
      changedAt,
    };
  };

  /** Every accepted change goes through here: bump the revision, persist, and tell the host. */
  const commit = (): MusicPlayback => {
    revision += 1;
    changedAt = now();
    persist();
    const next = snapshot();
    options.changed?.(next);
    return next;
  };

  const checkRevision = (expected: number | undefined): void => {
    if (expected === undefined) return;
    if (!Number.isInteger(expected)) throw new PlayerError("invalid_input", "expectedRevision must be an integer");
    if (expected !== revision) {
      throw new PlayerError("stale_revision", `the playback state moved on (now revision ${revision}, you sent ${expected}); call MUSIC_NOW_PLAYING and redo the request against the fresh snapshot`);
    }
  };

  /** The best quality the account may use for a track, honouring what the person asked for. */
  const qualityFor = (track: MusicTrack): MusicQuality => {
    const ceiling = entitled();
    const wanted = bestQuality(preferred(), [ceiling]) ?? ceiling;
    const allowed: MusicQuality[] = [];
    for (const candidate of ["128k", "320k", "flac", "hires"] as MusicQuality[]) {
      if (MUSIC_QUALITY_RANK[candidate] <= MUSIC_QUALITY_RANK[wanted]) allowed.push(candidate);
    }
    const trackCeiling = track.maxQuality ? bestQuality(track.maxQuality, allowed) : wanted;
    return trackCeiling ?? "128k";
  };

  /** Starts a queue item: the state becomes buffering until a client reports playing. */
  const start = (index: number): void => {
    currentIndex = clamp(index, 0, Math.max(queue.length - 1, 0));
    const item = queue[currentIndex];
    if (!item) {
      currentIndex = -1;
      state = "idle";
      positionSeconds = 0;
      return;
    }
    lastTrack = item.track;
    quality = qualityFor(item.track);
    positionSeconds = 0;
    state = "buffering";
    failure = null;
  };

  /** Shuffle moves the current track to the front and shuffles the rest; the previous order is kept. */
  const applyShuffle = (): void => {
    if (currentIndex < 0 || queue.length < 2) return;
    const current = queue[currentIndex]!;
    const rest = queue.filter((_, index) => index !== currentIndex);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j]!, rest[i]!];
    }
    queue = [current, ...rest];
    currentIndex = 0;
  };

  const restoreOrder = (): void => {
    if (!originalOrder.length) return;
    const byId = new Map(queue.map((item) => [item.queueItemId, item] as const));
    const ordered = originalOrder.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
    const added = queue.filter((item) => !originalOrder.includes(item.queueItemId));
    const currentId = queue[currentIndex]?.queueItemId;
    queue = [...ordered, ...added];
    currentIndex = currentId ? queue.findIndex((item) => item.queueItemId === currentId) : -1;
  };

  /** One place for "what plays next": repeat-one replays, everything else walks the (possibly shuffled) queue and wraps. */
  const advance = (direction: 1 | -1): void => {
    if (!queue.length) throw new PlayerError("empty_queue", "nothing is queued; add a track with MUSIC_QUEUE first");
    if (queue.length === 1) {
      start(0);
      return;
    }
    const nextIndex = (currentIndex + direction + queue.length) % queue.length;
    start(nextIndex);
  };

  return {
    snapshot,
    revision: () => revision,
    currentTrack: () => queue[currentIndex]?.track ?? null,

    resolve(target) {
      if (target === "current") return queue[currentIndex] ?? null;
      if (target === "last") {
        if (!lastTrack) return null;
        const found = queue.find((item) => item.track.id === lastTrack!.id);
        return found ?? { queueItemId: `last:${lastTrack.id}`, track: lastTrack, addedAt: changedAt, addedBy: "person" };
      }
      return queue.find((item) => item.queueItemId === target)
        ?? queue.find((item) => item.track.id === target)
        ?? null;
    },

    enqueue(input) {
      checkRevision(input.expectedRevision);
      const tracks = input.tracks.filter((track) => track && track.id);
      if (!tracks.length) throw new PlayerError("invalid_input", "no tracks to queue");
      const at = now();
      const by = input.by ?? "person";
      const items = tracks.map((track) => ({ queueItemId: newId(), track, addedAt: at, addedBy: by }));
      const position = input.position ?? "end";
      // "next" moves tracks that are already queued (upstream removes them before inserting);
      // plain adds keep the duplicate refusal so a bot cannot quietly stack the same song.
      const fresh = position === "next"
        ? items.filter((item) => item.track.id !== queue[currentIndex]?.track.id)
        : items.filter((item) => !queue.some((existing) => existing.track.id === item.track.id));
      const dedupedForNext = position === "next"
        ? queue.filter((existing) => !items.some((item) => item.track.id === existing.track.id) || existing.queueItemId === queue[currentIndex]?.queueItemId)
        : queue;
      if (!fresh.length) throw new PlayerError("duplicate", "every track in this request is already on the queue");
      if (dedupedForNext.length + fresh.length > MUSIC_MAX_QUEUE) {
        throw new PlayerError("queue_full", `the queue holds at most ${MUSIC_MAX_QUEUE} tracks`);
      }
      const wasEmpty = queue.length === 0;
      if (position === "now") {
        queue = [...fresh, ...dedupedForNext];
        start(input.startIndex ?? 0);
      } else if (position === "next") {
        const insertAt = currentIndex >= 0 ? currentIndex + 1 : 0;
        queue = [...dedupedForNext.slice(0, insertAt), ...fresh, ...dedupedForNext.slice(insertAt)];
        if (input.startIndex !== undefined) start(insertAt + input.startIndex);
        else if (currentIndex < 0) start(0);
      } else {
        const insertAt = queue.length;
        queue = [...queue, ...fresh];
        if (input.startIndex !== undefined) start(insertAt + input.startIndex);
        else if (currentIndex < 0) start(insertAt);
      }
      if (wasEmpty && state !== "buffering") start(input.startIndex ?? 0);
      if (input.play === true && state !== "playing") state = "buffering";
      return commit();
    },

    editQueue(input) {
      checkRevision(input.expectedRevision);
      switch (input.action) {
        case "add": {
          if (!input.tracks?.length) throw new PlayerError("invalid_input", "action add needs tracks");
          return this.enqueue({ tracks: input.tracks, by: "person", startIndex: input.startIndex });
        }
        case "remove": {
          if (!input.queueItemId) throw new PlayerError("invalid_input", `action remove needs queueItemId; call MUSIC_QUEUE to read them`);
          const at = queue.findIndex((item) => item.queueItemId === input.queueItemId);
          if (at < 0) throw new PlayerError("not_found", `no queue item "${input.queueItemId.slice(0, 60)}"`);
          queue = queue.filter((_, index) => index !== at);
          if (at < currentIndex) currentIndex -= 1;
          else if (at === currentIndex) {
            if (queue.length === 0) {
              currentIndex = -1;
              state = "idle";
              positionSeconds = 0;
            } else {
              start(Math.min(at, queue.length - 1));
            }
          }
          return commit();
        }
        case "clear": {
          queue = [];
          currentIndex = -1;
          state = "idle";
          positionSeconds = 0;
          failure = null;
          consecutiveFailures = 0;
          return commit();
        }
        case "move": {
          const from = input.index;
          const to = input.to;
          if (!Number.isInteger(from) || !Number.isInteger(to)) throw new PlayerError("invalid_input", `action move needs index and to`);
          if (from! < 0 || from! >= queue.length || to! < 0 || to! >= queue.length) {
            throw new PlayerError("invalid_input", `index and to must be between 0 and ${queue.length - 1}`);
          }
          const currentItem = queue[currentIndex];
          const next = [...queue];
          const [moved] = next.splice(from!, 1);
          next.splice(to!, 0, moved!);
          queue = next;
          currentIndex = currentItem ? queue.findIndex((item) => item.queueItemId === currentItem.queueItemId) : -1;
          return commit();
        }
        case "replace": {
          if (!input.tracks) throw new PlayerError("invalid_input", "action replace needs tracks");
          const at = now();
          queue = input.tracks.map((track) => ({ queueItemId: newId(), track, addedAt: at, addedBy: "radio" as const }));
          originalOrder = queue.map((item) => item.queueItemId);
          start(input.startIndex ?? 0);
          return commit();
        }
      }
    },

    control(input) {
      checkRevision(input.expectedRevision);
      switch (input.action) {
        case "play": {
          if (!queue.length) throw new PlayerError("empty_queue", "nothing is queued; add a track with MUSIC_QUEUE first");
          if (currentIndex < 0) start(0);
          else state = "buffering";
          failure = null;
          return commit();
        }
        case "pause": {
          if (state === "playing" || state === "buffering") state = "paused";
          return commit();
        }
        case "resume": {
          if (!queue.length) throw new PlayerError("empty_queue", "nothing is queued");
          if (currentIndex < 0) start(0);
          else state = "buffering";
          failure = null;
          return commit();
        }
        case "next": {
          // Manual skip ignores repeat-one and always walks forward, wrapping around.
          advance(1);
          return commit();
        }
        case "prev": {
          advance(-1);
          return commit();
        }
        case "seek": {
          if (!Number.isFinite(input.positionSeconds)) throw new PlayerError("invalid_input", `seek needs positionSeconds, e.g. 42`);
          const duration = queue[currentIndex]?.track.durationSeconds ?? 0;
          positionSeconds = Math.max(0, duration > 0 ? Math.min(input.positionSeconds!, duration) : input.positionSeconds!);
          return commit();
        }
        case "volume": {
          if (!Number.isFinite(input.volume)) throw new PlayerError("invalid_input", `volume needs a number 0-100, e.g. 60`);
          volume = clamp(Math.round(input.volume!), 0, 100);
          return commit();
        }
        case "quality": {
          if (!input.quality) throw new PlayerError("invalid_input", `quality must be one of 128k, 320k, flac, hires`);
          // Upstream never refuses a quality here: the source resolver picks the best
          // the track actually has, at or under what was asked. The server downgrades.
          quality = input.quality;
          // A quality change re-buffers the same track at the same position.
          if (currentIndex >= 0) state = state === "playing" ? "buffering" : state;
          return commit();
        }
        case "repeat": {
          if (!input.repeat) throw new PlayerError("invalid_input", `repeat must be off, one or all`);
          repeat = input.repeat;
          // Upstream keeps the two modes mutually exclusive.
          if (repeat === "one" && shuffle) {
            shuffle = false;
            restoreOrder();
          }
          return commit();
        }
        case "shuffle": {
          const next = input.shuffle ?? !shuffle;
          if (next === shuffle) return snapshot();
          shuffle = next;
          if (shuffle) {
            repeat = "off";
            applyShuffle();
          } else {
            restoreOrder();
          }
          return commit();
        }
        case "speed": {
          if (!Number.isFinite(input.speed)) throw new PlayerError("invalid_input", `speed needs a number 0.5-2, e.g. 1.25`);
          speed = clamp(input.speed!, 0.5, 2);
          return commit();
        }
      }
    },

    receipt(input) {
      if (!Number.isInteger(input.revision) || input.revision < 1 || input.revision > revision) {
        throw new PlayerError("invalid_input", "revision must be a snapshot revision the client acted on");
      }
      const expectedItem = queue[currentIndex];
      // A receipt for a track that is no longer current must not overwrite the new one.
      if (input.queueItemId && expectedItem && input.queueItemId !== expectedItem.queueItemId) {
        throw new PlayerError("stale_receipt", "this receipt describes a track that is no longer current; refresh the snapshot");
      }
      if (input.positionSeconds !== undefined && Number.isFinite(input.positionSeconds)) positionSeconds = Math.max(0, input.positionSeconds);
      // The receipt describes the state it produces, so the revision it confirms is the new one.
      revision += 1;
      switch (input.state) {
        case "buffering":
          state = "buffering";
          failure = null;
          break;
        case "playing": {
          state = "playing";
          failure = null;
          consecutiveFailures = 0;
          confirmedRevision = revision;
          if (expectedItem && !recordedPlays.has(expectedItem.queueItemId)) {
            recordedPlays.add(expectedItem.queueItemId);
            options.played?.(expectedItem.track, expectedItem.queueItemId);
          }
          break;
        }
        case "paused":
          state = "paused";
          confirmedRevision = 0;
          break;
        case "ended": {
          confirmedRevision = 0;
          if (expectedItem) options.endedPlayed?.(expectedItem.track, positionSeconds);
          if (repeat === "one") {
            positionSeconds = 0;
            state = "buffering";
          } else {
            advance(1);
          }
          break;
        }
        case "failed": {
          confirmedRevision = 0;
          consecutiveFailures += 1;
          failure = { code: input.code ?? "playback_failed", message: input.message ?? "the client could not play this track" };
          if (consecutiveFailures >= MUSIC_FAILURE_BREAKER) {
            // The breaker stops the skip chain: a broken source must not empty the queue.
            consecutiveFailures = 0;
            state = "failed";
            break;
          }
          // Upstream removes the failed track and moves on automatically.
          if (expectedItem) {
            const at = currentIndex;
            queue = queue.filter((_, index) => index !== at);
            recordedPlays.delete(expectedItem.queueItemId);
            if (!queue.length) {
              currentIndex = -1;
              state = "failed";
              positionSeconds = 0;
            } else {
              start(Math.min(at, queue.length - 1));
            }
          } else {
            state = "failed";
          }
          break;
        }
      }
      changedAt = now();
      persist();
      const next = snapshot();
      options.changed?.(next);
      return next;
    },

    setDucked(next) {
      if (ducked === next) return snapshot();
      ducked = next;
      revision += 1;
      changedAt = now();
      persist();
      const playback = snapshot();
      options.changed?.(playback);
      return playback;
    },
  };
}
