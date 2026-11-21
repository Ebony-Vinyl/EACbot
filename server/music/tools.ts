// The music tools a bot may call, and their schemas. Schemas stay flat (no
// oneOf/anyOf/const) and every refusal names a literal example, so a model that
// guesses wrong can correct itself from the message.
//
// The one rule that shapes every description: a control request is not a play.
// Until a client reports what its audio element did, the bot must not say a song
// is playing.
import type { MusicPlaylist, MusicPlayback, MusicQuality, MusicTrack } from "../../shared/music.ts";
import { MUSIC_QUALITIES, MUSIC_REPEAT_MODES } from "../../shared/music.ts";
import type { Player } from "./player.ts";
import { MUSIC_CONTROL_ACTIONS, MUSIC_QUEUE_ACTIONS } from "./player.ts";
import type { MusicStore } from "./store.ts";

export interface MusicTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TEXT = (max: number, description: string) => ({ type: "string", maxLength: max, description });

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): MusicTool {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

/** The `target` every control accepts: the current track, the one before it, or a queue item by id. */
const TARGET = {
  type: "string",
  maxLength: 120,
  description: `Which queued track: "current", "last" (the one that just played), or a queueItemId from MUSIC_QUEUE. Defaults to "current".`,
};

export const MUSIC_TOOLS: readonly MusicTool[] = [
  tool("MUSIC_SEARCH", "Search Kugou for songs, playlists or albums. Read only. Returns tracks with the id MUSIC_PLAY and MUSIC_QUEUE take.",
    {
      keyword: TEXT(120, "What to look for: a song title, an artist, an album."),
      kind: { type: "string", enum: ["track", "playlist", "album"], description: "What to search. Default track." },
      page: { type: "integer", minimum: 1, maximum: 200, description: "Page number. Default 1." },
      pageSize: { type: "integer", minimum: 1, maximum: 100, description: "Results per page. Default 20." },
    }, ["keyword"]),

  tool("MUSIC_PLAY", "Put tracks on the queue and start playing. This requests playback: it is confirmed only when the player reports back, so check MUSIC_NOW_PLAYING before saying a song is playing.",
    {
      trackIds: { type: "array", items: { type: "string" }, maxItems: 100, description: "Track ids from MUSIC_SEARCH, or a playlist's track ids. A single id is fine." },
      position: { type: "string", enum: ["end", "next", "now"], description: "Where to put them. Default end." },
    }, ["trackIds"]),

  tool("MUSIC_CONTROL", "Pause, resume, skip, seek, set the volume, change quality, repeat or shuffle. Requests playback; it is confirmed only by the player's own report.",
    {
      action: { type: "string", enum: [...MUSIC_CONTROL_ACTIONS], description: "What to do, e.g. pause." },
      target: TARGET,
      expectedRevision: { type: "integer", minimum: 1, description: "The revision from MUSIC_NOW_PLAYING you based this on. Omit only when you just read it." },
      positionSeconds: { type: "number", minimum: 0, description: "For seek: seconds from the start." },
      volume: { type: "number", minimum: 0, maximum: 100, description: "For volume: 0-100." },
      quality: { type: "string", enum: [...MUSIC_QUALITIES], description: "For quality: 128k, 320k, flac or hires." },
      repeat: { type: "string", enum: [...MUSIC_REPEAT_MODES], description: "For repeat: off, one or all." },
      shuffle: { type: "boolean", description: "For shuffle: true to shuffle, false to stop." },
    }, ["action"]),

  tool("MUSIC_QUEUE", "Read the queue, or add, remove, clear or reorder it.",
    {
      action: { type: "string", enum: [...MUSIC_QUEUE_ACTIONS, "read"], description: "read, add, remove, clear or move. Default read." },
      trackIds: { type: "array", items: { type: "string" }, maxItems: 100, description: "For add: track ids from MUSIC_SEARCH." },
      queueItemId: { type: "string", maxLength: 120, description: "For remove: the queueItemId from a read." },
      index: { type: "integer", minimum: 0, description: "For move: where the item is now." },
      to: { type: "integer", minimum: 0, description: "For move: where it should go." },
      expectedRevision: { type: "integer", minimum: 1, description: "The revision you based this on." },
    }),

  tool("MUSIC_NOW_PLAYING", "What the player holds right now: the track, the queue, the position, and whether a client has confirmed it is actually playing. Read this before any 'this song' or 'that one' reference.", {}),

  tool("MUSIC_LYRICS", "The lyrics for a track: timed lines, with word timings when Kugou has them.",
    {
      trackId: TEXT(240, "The track id. Omit for the current track."),
    }),

  tool("MUSIC_PLAYLIST", "Read the person's playlists, one playlist's tracks, or create, rename or delete one this server owns.",
    {
      action: { type: "string", enum: ["list", "read", "create", "rename", "delete", "add", "remove"], description: "What to do. Default list." },
      playlistId: TEXT(120, "The playlist id from list."),
      name: TEXT(200, "For create or rename: the playlist's name."),
      trackIds: { type: "array", items: { type: "string" }, maxItems: 200, description: "For add or remove: track ids." },
    }),

  tool("MUSIC_RECOMMEND", "Daily recommendations, private FM, charts, scenes, an artist, an album, long audio, or the person's cloud drive.",
    {
      kind: { type: "string", enum: ["daily", "fm", "rank", "scene", "artist", "album", "longaudio", "cloud"], description: "Which list. Default daily." },
      id: TEXT(120, "For rank, scene, artist or album: the id from a previous call."),
      page: { type: "integer", minimum: 1, maximum: 200, description: "Page number. Default 1." },
    }),

  tool("MUSIC_FAVORITE", "Read the person's favourites, or add a track to them or remove one.",
    {
      action: { type: "string", enum: ["list", "add", "remove"], description: "What to do. Default list." },
      trackId: TEXT(240, "For add or remove: the track id."),
    }),

  tool("MUSIC_PLAN", "Build a queue for a stretch of time and plan when it stops: for 'focus for two hours' or 'relax for half an hour'. Returns the queue it made and the stop plan, which the caller schedules.",
    {
      minutes: { type: "integer", minimum: 5, maximum: 720, description: "How long the session lasts." },
      mood: TEXT(120, "What the music should be like, in the person's words: 轻音乐, 专注, 不要太吵."),
      volume: { type: "number", minimum: 0, maximum: 100, description: "The volume to hold for the session." },
      stopAtEnd: { type: "boolean", description: "Stop playback when the time is up. Default true." },
    }, ["minutes"]),

  tool("MUSIC_IDENTIFY", "Identify what is playing around the person from a short microphone recording. Returns the candidate tracks; the person must confirm before it is queued.",
    {
      durationSeconds: { type: "integer", minimum: 3, maximum: 12, description: "How long to listen. Default 6." },
    }),

  tool("MUSIC_PREFERENCES", "Read or change the person's music preferences. A stated preference is their own words; an observed one is a counted habit and must not be read back as a rule.",
    {
      action: { type: "string", enum: ["read", "set", "delete"], description: "What to do. Default read." },
      key: TEXT(80, "For set or delete: e.g. 不喜欢太吵, favourite_genre."),
      value: TEXT(2_000, "For set: what they said."),
      kind: { type: "string", enum: ["stated", "observed"], description: "Default stated. Only use observed for a counted habit." },
    }),
];

export type MusicToolName = (typeof MUSIC_TOOLS)[number]["name"];

const byName = new Map(MUSIC_TOOLS.map((entry) => [entry.name, entry]));

export function isMusicToolName(name: unknown): name is MusicToolName {
  return typeof name === "string" && byName.has(name);
}

export function musicTool(name: MusicToolName): MusicTool {
  return byName.get(name)!;
}

export interface MusicToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const ok = (value: unknown): MusicToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (code: string, message: string): MusicToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
  isError: true,
});

/** What the catalogue can do, as the tools need it. A host supplies one of these. */
export interface MusicToolCatalogue {
  search(input: { keyword: string; kind: "track" | "playlist" | "album"; page?: number; pageSize?: number }): Promise<unknown>;
  playUrl(track: MusicTrack, quality: MusicQuality): Promise<{ handle: string; mime: string; expiresAt: string }>;
  lyrics(track: MusicTrack): Promise<unknown>;
  recommend(input: { kind: string; id?: string; page?: number }): Promise<unknown>;
  favorite(track: MusicTrack, favorite: boolean): Promise<void>;
  playlists(kind: "created" | "collected"): Promise<MusicPlaylist[]>;
  playlistTracks(playlistId: string): Promise<{ name: string; tracks: MusicTrack[] }>;
  createPlaylist(name: string): Promise<MusicPlaylist>;
  addToPlaylist(playlistId: string, tracks: readonly MusicTrack[]): Promise<void>;
  removeFromPlaylist(playlistId: string, trackIds: readonly string[]): Promise<void>;
  /** Resolves track ids to tracks, for a queue or playlist edit. */
  tracksByIds(ids: readonly string[]): Promise<MusicTrack[]>;
  identify(input: { durationSeconds: number }): Promise<MusicTrack[]>;
  /** A radio: fills a queue for a mood, used by MUSIC_PLAN. */
  radio(input: { mood: string; minutes: number }): Promise<MusicTrack[]>;
}

export interface MusicToolContext {
  player: Player;
  store: MusicStore;
  catalogue: MusicToolCatalogue;
  /** Called when a tool needs the person to confirm a sensitive action (deleting a playlist). */
  confirm?(question: string): Promise<boolean>;
  /** The bot acting, for a preference scoped to one bot. */
  botId?: string;
}

/** A track as a bot should read it: no vendor internals, only what a card shows. */
function brief(track: MusicTrack) {
  return {
    id: track.id,
    title: track.title,
    artists: track.artists,
    album: track.album,
    durationSeconds: track.durationSeconds,
    vip: track.vip,
    ...(track.unsupportedReason ? { unsupported: track.unsupportedReason } : {}),
  };
}

/** The playback state as a bot must read it, with the one thing it must not mistake spelled out. */
function playbackReport(playback: MusicPlayback) {
  return {
    revision: playback.revision,
    state: playback.state,
    playbackConfirmed: playback.playbackConfirmed,
    current: playback.current ? { queueItemId: playback.current.queueItemId, ...brief(playback.current.track) } : null,
    positionSeconds: Math.round(playback.positionSeconds),
    volume: playback.volume,
    quality: playback.quality,
    repeat: playback.repeat,
    shuffle: playback.shuffle,
    queueLength: playback.queue.length,
    ducked: playback.ducked,
    ...(playback.failure ? { failure: playback.failure } : {}),
    ...(playback.playbackConfirmed
      ? {}
      : { note: "No client has confirmed this is playing. Do not say a song is playing until playbackConfirmed is true; say what you queued and that it is waiting for the player." }),
  };
}

export async function runMusicTool(context: MusicToolContext, name: string, args: Record<string, unknown>): Promise<MusicToolResult> {
  if (!isMusicToolName(name)) return fail("unknown_tool", `no music tool named "${String(name).slice(0, 60)}"`);
  const { player, store, catalogue } = context;

  const ids = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];

  try {
    switch (name) {
      case "MUSIC_SEARCH": {
        const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
        if (!keyword) return fail("invalid_input", `keyword is required, e.g. {"keyword": "晴天"}`);
        const kind = args.kind === "playlist" || args.kind === "album" ? args.kind : "track";
        const result = await catalogue.search({
          keyword,
          kind,
          ...(typeof args.page === "number" ? { page: args.page } : {}),
          ...(typeof args.pageSize === "number" ? { pageSize: args.pageSize } : {}),
        }) as Record<string, unknown>;
        if (kind === "track" && Array.isArray(result.tracks)) {
          return ok({ ...result, tracks: (result.tracks as MusicTrack[]).map(brief) });
        }
        return ok(result);
      }

      case "MUSIC_PLAY": {
        const trackIds = ids(args.trackIds);
        if (!trackIds.length) return fail("invalid_input", `trackIds is required: the ids from MUSIC_SEARCH, e.g. {"trackIds": ["kugou:abc123"]}`);
        const tracks = await catalogue.tracksByIds(trackIds);
        if (!tracks.length) return fail("unknown_track", `none of those track ids is known; search again with MUSIC_SEARCH`);
        const position = args.position === "next" || args.position === "now" ? args.position : "end";
        const playback = player.enqueue({ tracks, position, by: "bot", play: true });
        return ok({
          ...playbackReport(playback),
          queued: tracks.map(brief),
          ...(tracks.length < trackIds.length ? { missing: trackIds.length - tracks.length } : {}),
        });
      }

      case "MUSIC_CONTROL": {
        const action = args.action;
        if (!MUSIC_CONTROL_ACTIONS.includes(action as never)) {
          return fail("unsupported_action", `action must be one of ${MUSIC_CONTROL_ACTIONS.join(", ")}: e.g. "pause"`);
        }
        if (args.target !== undefined && typeof args.target === "string" && args.target !== "current" && args.target !== "last") {
          const target = player.resolve(args.target);
          if (!target) return fail("not_found", `no queue item "${args.target.slice(0, 60)}"; call MUSIC_QUEUE to read the ids`);
        }
        const playback = player.control({
          action: action as (typeof MUSIC_CONTROL_ACTIONS)[number],
          ...(typeof args.expectedRevision === "number" ? { expectedRevision: args.expectedRevision } : {}),
          ...(typeof args.positionSeconds === "number" ? { positionSeconds: args.positionSeconds } : {}),
          ...(typeof args.volume === "number" ? { volume: args.volume } : {}),
          ...(typeof args.quality === "string" ? { quality: args.quality as MusicQuality } : {}),
          ...(typeof args.repeat === "string" ? { repeat: args.repeat as (typeof MUSIC_REPEAT_MODES)[number] } : {}),
          ...(typeof args.shuffle === "boolean" ? { shuffle: args.shuffle } : {}),
        });
        return ok(playbackReport(playback));
      }

      case "MUSIC_QUEUE": {
        const action = typeof args.action === "string" ? args.action : "read";
        if (action === "read") {
          const playback = player.snapshot();
          return ok({
            revision: playback.revision,
            currentIndex: playback.currentIndex,
            count: playback.queue.length,
            queue: playback.queue.map((item: { queueItemId: string; addedBy: string; track: MusicTrack }, index: number) => ({ index, queueItemId: item.queueItemId, addedBy: item.addedBy, ...brief(item.track) })),
          });
        }
        if (action === "add") {
          const trackIds = ids(args.trackIds);
          if (!trackIds.length) return fail("invalid_input", `action add needs trackIds, e.g. {"action": "add", "trackIds": ["kugou:abc123"]}`);
          const tracks = await catalogue.tracksByIds(trackIds);
          if (!tracks.length) return fail("unknown_track", "none of those track ids is known; search again with MUSIC_SEARCH");
          return ok(playbackReport(player.enqueue({ tracks, by: "bot" })));
        }
        if (action === "remove") {
          if (typeof args.queueItemId !== "string") return fail("invalid_input", `action remove needs queueItemId; call MUSIC_QUEUE with no action to read them`);
          return ok(playbackReport(player.editQueue({
            action: "remove",
            queueItemId: args.queueItemId,
            ...(typeof args.expectedRevision === "number" ? { expectedRevision: args.expectedRevision } : {}),
          })));
        }
        if (action === "clear") {
          return ok(playbackReport(player.editQueue({ action: "clear", ...(typeof args.expectedRevision === "number" ? { expectedRevision: args.expectedRevision } : {}) })));
        }
        if (action === "move") {
          return ok(playbackReport(player.editQueue({
            action: "move",
            ...(typeof args.index === "number" ? { index: args.index } : {}),
            ...(typeof args.to === "number" ? { to: args.to } : {}),
            ...(typeof args.expectedRevision === "number" ? { expectedRevision: args.expectedRevision } : {}),
          })));
        }
        return fail("unsupported_action", `action must be read, add, remove, clear or move`);
      }

      case "MUSIC_NOW_PLAYING": {
        const playback = player.snapshot();
        return ok({ ...playbackReport(playback), changedAt: playback.changedAt });
      }

      case "MUSIC_LYRICS": {
        const trackId = typeof args.trackId === "string" ? args.trackId.trim() : "";
        const track = trackId
          ? (await catalogue.tracksByIds([trackId]))[0] ?? null
          : player.currentTrack();
        if (!track) return fail("unknown_track", trackId ? `no track "${trackId.slice(0, 80)}"` : "nothing is playing and no trackId was given");
        return ok(await catalogue.lyrics(track));
      }

      case "MUSIC_PLAYLIST": {
        const action = typeof args.action === "string" ? args.action : "list";
        if (action === "list") {
          const local = store.playlists();
          let remote: MusicPlaylist[] = [];
          try {
            remote = await catalogue.playlists("created");
          } catch {
            // A signed-out account has no remote playlists; the local ones still list.
          }
          return ok({ playlists: [...local, ...remote].map((playlist) => ({ ...playlist })) });
        }
        if (action === "read") {
          if (typeof args.playlistId !== "string") return fail("invalid_input", `action read needs playlistId; call MUSIC_PLAYLIST with action list first`);
          const local = store.playlist(args.playlistId);
          if (local) {
            return ok({ playlist: local, tracks: store.playlistTracks(local.playlistId).map((track, index) => ({ index, ...brief(track) })) });
          }
          const remote = await catalogue.playlistTracks(args.playlistId);
          return ok({ playlist: { playlistId: args.playlistId, name: remote.name }, tracks: remote.tracks.map((track, index) => ({ index, ...brief(track) })) });
        }
        if (action === "create") {
          if (typeof args.name !== "string" || !args.name.trim()) return fail("invalid_input", `action create needs name, e.g. {"action": "create", "name": "深夜"}`);
          return ok({ playlist: store.createPlaylist(args.name.trim()) });
        }
        if (action === "rename") {
          if (typeof args.playlistId !== "string" || typeof args.name !== "string") {
            return fail("invalid_input", `action rename needs playlistId and name`);
          }
          store.renamePlaylist(args.playlistId, args.name);
          return ok({ playlist: store.playlist(args.playlistId) });
        }
        if (action === "delete") {
          if (typeof args.playlistId !== "string") return fail("invalid_input", `action delete needs playlistId`);
          const playlist = store.playlist(args.playlistId);
          if (!playlist) return fail("unknown_playlist", `no playlist "${args.playlistId.slice(0, 80)}"; call MUSIC_PLAYLIST with action list`);
          if (context.confirm) {
            const approved = await context.confirm(`Delete the playlist "${playlist.name}" and its ${playlist.trackCount} entries?`);
            if (!approved) return fail("refused", `the person did not approve deleting "${playlist.name}"`);
          }
          store.deletePlaylist(args.playlistId);
          return ok({ deleted: args.playlistId });
        }
        if (action === "add" || action === "remove") {
          if (typeof args.playlistId !== "string") return fail("invalid_input", `action ${action} needs playlistId`);
          const trackIds = ids(args.trackIds);
          if (!trackIds.length) return fail("invalid_input", `action ${action} needs trackIds`);
          if (store.playlist(args.playlistId)) {
            if (action === "add") {
              const tracks = await catalogue.tracksByIds(trackIds);
              const added = store.addToPlaylist(args.playlistId, tracks);
              return ok({ added, playlist: store.playlist(args.playlistId) });
            }
            const removed = store.removeFromPlaylist(args.playlistId, trackIds);
            return ok({ removed, playlist: store.playlist(args.playlistId) });
          }
          if (action === "add") await catalogue.addToPlaylist(args.playlistId, await catalogue.tracksByIds(trackIds));
          else await catalogue.removeFromPlaylist(args.playlistId, trackIds);
          return ok({ playlistId: args.playlistId, updated: true });
        }
        return fail("unsupported_action", "action must be list, read, create, rename, delete, add or remove");
      }

      case "MUSIC_RECOMMEND": {
        const kind = typeof args.kind === "string" ? args.kind : "daily";
        const result = await catalogue.recommend({
          kind,
          ...(typeof args.id === "string" ? { id: args.id } : {}),
          ...(typeof args.page === "number" ? { page: args.page } : {}),
        }) as Record<string, unknown>;
        if (Array.isArray(result.tracks)) return ok({ ...result, tracks: (result.tracks as MusicTrack[]).map(brief) });
        if (Array.isArray(result.entries)) return ok({ ...result, entries: (result.entries as MusicTrack[]).map(brief) });
        return ok(result);
      }

      case "MUSIC_FAVORITE": {
        const action = typeof args.action === "string" ? args.action : "list";
        if (action === "list") return ok({ favorites: store.favorites().map(brief) });
        if (typeof args.trackId !== "string") return fail("invalid_input", `action ${action} needs trackId`);
        const track = (await catalogue.tracksByIds([args.trackId]))[0] ?? null;
        if (!track) return fail("unknown_track", `no track "${args.trackId.slice(0, 80)}"; search again with MUSIC_SEARCH`);
        const favorite = action === "add";
        store.setFavorite(track, favorite);
        try {
          await catalogue.favorite(track, favorite);
        } catch {
          // The local copy is the truth here; a remote failure is worth a note, not a failure.
          return ok({ track: brief(track), favorite, note: "saved here, but Kugou did not confirm the change on the account" });
        }
        return ok({ track: brief(track), favorite });
      }

      case "MUSIC_PLAN": {
        const minutes = typeof args.minutes === "number" ? Math.min(Math.max(Math.trunc(args.minutes), 5), 720) : 0;
        if (!minutes) return fail("invalid_input", `minutes is required, e.g. {"minutes": 120, "mood": "专注"}`);
        const mood = typeof args.mood === "string" ? args.mood.trim() : "";
        const tracks = await catalogue.radio({ mood, minutes });
        if (!tracks.length) return fail("not_found", `no tracks matched "${mood || "the request"}"; ask the person for a different mood or artist`);
        // Fit the queue to the time: roughly one track per four minutes.
        const wanted = Math.max(1, Math.ceil(minutes / 4));
        const fitted = tracks.slice(0, Math.min(wanted, 200));
        const playback = player.enqueue({ tracks: fitted, position: "replace" as never, by: "bot", play: true });
        if (typeof args.volume === "number") player.control({ action: "volume", volume: args.volume });
        return ok({
          ...playbackReport(playback),
          plan: {
            minutes,
            mood: mood || null,
            stopAtEnd: args.stopAtEnd !== false,
            tracks: fitted.length,
            note: "Schedule the stop yourself: create a routine that pauses the player at the end of the session.",
          },
          queued: fitted.map(brief),
        });
      }

      case "MUSIC_IDENTIFY": {
        const durationSeconds = typeof args.durationSeconds === "number" ? Math.min(Math.max(Math.trunc(args.durationSeconds), 3), 12) : 6;
        const tracks = await catalogue.identify({ durationSeconds });
        if (!tracks.length) return ok({ matches: [], note: "nothing matched; the room may be too quiet, or the song is not in Kugou's catalogue" });
        return ok({ matches: tracks.slice(0, 5).map(brief), note: "Ask the person which one it is before queueing it." });
      }

      case "MUSIC_PREFERENCES": {
        const action = typeof args.action === "string" ? args.action : "read";
        const scope = context.botId ? { scope: "bot" as const, botId: context.botId } : { scope: "global" as const };
        if (action === "read") {
          return ok({
            preferences: store.preferences(scope).map((entry) => ({ key: entry.key, value: entry.value, kind: entry.kind, updatedAt: entry.updatedAt })),
            note: "A stated preference is the person's own words. An observed one is a counted habit: mention it as a guess, never as a rule.",
          });
        }
        if (typeof args.key !== "string" || !args.key.trim()) return fail("invalid_input", `action ${action} needs key, e.g. {"action": "set", "key": "不喜欢太吵", "value": "晚上十点后放轻音乐"}`);
        if (action === "delete") {
          const deleted = store.deletePreference({ key: args.key.trim(), ...scope });
          return ok({ deleted, key: args.key.trim() });
        }
        if (typeof args.value !== "string" || !args.value.trim()) return fail("invalid_input", `action set needs value`);
        const kind = args.kind === "observed" ? "observed" : "stated";
        const saved = store.setPreference({ key: args.key.trim(), value: args.value.trim(), kind, ...scope });
        return ok({ preference: saved });
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unknown_track";
    return fail(code, error instanceof Error ? error.message : String(error));
  }
  return fail("unknown_tool", `no music tool named "${String(name).slice(0, 60)}"`);
}

export const MUSIC_INSTRUCTIONS = [
  "The music tools drive the person's own player. A control request is a request, not a fact: MUSIC_NOW_PLAYING reports playbackConfirmed, and until it is true you must not say a song is playing.",
  "A track is named by the id MUSIC_SEARCH returns. When the person says \"this one\" or \"that one\", call MUSIC_NOW_PLAYING first and use the queueItemId it reports; never guess which song they mean.",
  "A receipt that says failed is the truth: do not skip to another track to hide it, and do not claim the track played.",
  "A track marked vip needs a paid account. Offer a lower quality or a different track; do not suggest working around it.",
  "MUSIC_PLAN builds the queue; the stop at the end of the session is a routine the caller schedules. Say both parts plainly.",
  "Preferences the person stated are theirs to change; call MUSIC_PREFERENCES with their own words rather than inventing a category.",
].join(" ");
