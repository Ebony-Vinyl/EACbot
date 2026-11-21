import { z } from "zod";

/**
 * The music wire contract. A source (Kugou, a local folder, Jellyfin) turns its
 * own vocabulary into these tracks and receipts; the player, the music view and
 * the bot tools know nothing else.
 *
 * Two words are load-bearing:
 * - `revision` is the player's monotonic version. Every control names the one it
 *   saw; a stale control is refused rather than applied to a queue it never saw.
 * - `playbackConfirmed` is false until a client that actually has an audio
 *   element reports what happened. Nothing in the server may claim a song played.
 */

const instant = z.string().datetime({ offset: true });

/** Where a track came from. The first four stream through this server; `video` does not. */
export const MUSIC_SOURCES = ["kugou", "local", "jellyfin", "cloud"] as const;
export type MusicSource = (typeof MUSIC_SOURCES)[number];

/** Quality tiers, worst to best. A source maps its own names onto these. */
export const MUSIC_QUALITIES = ["128k", "320k", "flac", "hires"] as const;
export type MusicQuality = (typeof MUSIC_QUALITIES)[number];

export const MUSIC_QUALITY_RANK: Readonly<Record<MusicQuality, number>> = { "128k": 0, "320k": 1, flac: 2, hires: 3 };

/** What the player is doing, as the client last reported it. */
export const PLAYBACK_STATES = ["idle", "buffering", "playing", "paused", "ended", "failed"] as const;
export type PlaybackState = (typeof PLAYBACK_STATES)[number];

/**
 * A track, whatever its source. `id` is `<source>:<source's own id>` and stable
 * across restarts; `hash` is the Kugou file hash when there is one, because that
 * is what a play URL is keyed by.
 */
export const musicTrackSchema = z.object({
  id: z.string().trim().min(1).max(240),
  source: z.enum(MUSIC_SOURCES),
  title: z.string().trim().min(1).max(300),
  artists: z.array(z.string().max(200)).max(16),
  album: z.string().max(300).nullable(),
  albumId: z.string().max(120).nullable(),
  /** Seconds. Zero when the source did not say. */
  durationSeconds: z.number().int().nonnegative(),
  /** The Kugou file hash, lowercased; absent for local and Jellyfin tracks. */
  hash: z.string().max(120).nullable(),
  /** The source's own audio id, needed by the play-url endpoint. */
  audioId: z.string().max(120).nullable(),
  coverUrl: z.string().max(2_000).nullable(),
  /** True when the source says this needs a paid account; the UI shows it rather than hiding the row. */
  vip: z.boolean(),
  /** The best quality this source will serve this track at, when it says. */
  maxQuality: z.enum(MUSIC_QUALITIES).nullable(),
  /** Set when the format cannot be decoded here at all (a DSF the local decoder rejected). */
  unsupportedReason: z.string().max(300).nullable(),
}).strict();
export type MusicTrack = z.infer<typeof musicTrackSchema>;

/** One entry in the queue: a track plus the handle that names it in this session. */
export const musicQueueItemSchema = z.object({
  queueItemId: z.string().trim().min(1).max(80),
  track: musicTrackSchema,
  addedAt: instant,
  addedBy: z.enum(["person", "bot", "radio"]),
}).strict();
export type MusicQueueItem = z.infer<typeof musicQueueItemSchema>;

export const MUSIC_REPEAT_MODES = ["off", "one", "all"] as const;
export type MusicRepeatMode = (typeof MUSIC_REPEAT_MODES)[number];

/** The player's authoritative state. One of these is the whole truth at a revision. */
export const musicPlaybackSchema = z.object({
  revision: z.number().int().min(1),
  current: musicQueueItemSchema.nullable(),
  queue: z.array(musicQueueItemSchema).max(500),
  /** Index into `queue` of `current`; -1 when nothing is current. */
  currentIndex: z.number().int().min(-1),
  state: z.enum(PLAYBACK_STATES),
  /** Seconds into the current track, as last reported. */
  positionSeconds: z.number().min(0),
  /** 0-100. */
  volume: z.number().min(0).max(100),
  quality: z.enum(MUSIC_QUALITIES),
  repeat: z.enum(MUSIC_REPEAT_MODES),
  shuffle: z.boolean(),
  /** 0.5-2.0; the renderer applies it with playbackRate, the timeline stays in real seconds. */
  speed: z.number().min(0.5).max(2),
  /** True only when the last receipt is for this revision and says a client is playing. */
  playbackConfirmed: z.boolean(),
  /** Why the last attempt failed, when it did. */
  failure: z.object({ code: z.string().max(120), message: z.string().max(600) }).nullable(),
  /** Set while speech holds audio focus, so the view can show why music went quiet. */
  ducked: z.boolean(),
  changedAt: instant,
}).strict();
export type MusicPlayback = z.infer<typeof musicPlaybackSchema>;

/** What a client tells the server it actually did. The only writer of playback truth. */
export const musicReceiptSchema = z.object({
  state: z.enum(["buffering", "playing", "paused", "ended", "failed"]),
  revision: z.number().int().min(1),
  /** Which queue item this describes; a receipt for a track that is no longer current is refused. */
  queueItemId: z.string().max(120).optional(),
  positionSeconds: z.number().min(0).optional(),
  /** Seconds the client actually decoded; lets the server drop a track that never starts. */
  durationSeconds: z.number().min(0).optional(),
  code: z.string().max(120).optional(),
  message: z.string().max(600).optional(),
}).strict();
export type MusicReceipt = z.infer<typeof musicReceiptSchema>;

/** One word of a lyric line, for word-by-word highlighting. */
export const lyricWordSchema = z.object({
  text: z.string().max(200),
  /** Milliseconds from the start of the track. */
  atMs: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
}).strict();
export type LyricWord = z.infer<typeof lyricWordSchema>;

export const lyricLineSchema = z.object({
  atMs: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  text: z.string().max(1_000),
  /** Present for KRC, absent for LRC: a plain LRC line has one span, the whole line. */
  words: z.array(lyricWordSchema).max(200),
  translation: z.string().max(1_000).nullable(),
  romanization: z.string().max(1_000).nullable(),
}).strict();
export type LyricLine = z.infer<typeof lyricLineSchema>;

export const MUSIC_LYRIC_FORMATS = ["krc", "lrc", "qrc", "yrc", "vtt", "txt", "none"] as const;
export type MusicLyricFormat = (typeof MUSIC_LYRIC_FORMATS)[number];

export const musicLyricsSchema = z.object({
  trackId: z.string().max(240),
  format: z.enum(MUSIC_LYRIC_FORMATS),
  lines: z.array(lyricLineSchema).max(4_000),
  /** Who wrote and composed it, when the source sent credits. */
  credits: z.array(z.object({ role: z.string().max(60), names: z.array(z.string().max(200)).max(20) }).strict()).max(20),
  /** Set when lyrics exist upstream but could not be fetched or decoded. */
  unavailableReason: z.string().max(300).nullable(),
}).strict();
export type MusicLyrics = z.infer<typeof musicLyricsSchema>;

export const MUSIC_PLAYLIST_KINDS = ["created", "collected", "album", "local", "jellyfin"] as const;
export type MusicPlaylistKind = (typeof MUSIC_PLAYLIST_KINDS)[number];

export const musicPlaylistSchema = z.object({
  playlistId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(MUSIC_PLAYLIST_KINDS),
  /** The source's own id, for one the server did not create. */
  sourceId: z.string().max(120).nullable(),
  coverUrl: z.string().max(2_000).nullable(),
  trackCount: z.number().int().nonnegative(),
  /** Set for a playlist this server owns; a remote one has no local copy. */
  local: z.boolean(),
  createdAt: instant.nullable(),
}).strict();
export type MusicPlaylist = z.infer<typeof musicPlaylistSchema>;

/** The personal FM's three loudness modes and its two song pools, as upstream cycles them. */
export const MUSIC_FM_MODES = ["normal", "small", "peak"] as const;
export const MUSIC_FM_POOLS = ["taste", "style"] as const;

export const MUSIC_DISCOVER_SECTIONS = ["daily", "fm", "rank", "scene", "recommend", "cloud"] as const;
export type MusicDiscoverSection = (typeof MUSIC_DISCOVER_SECTIONS)[number];

export const musicRankSchema = z.object({
  rankId: z.string().max(120),
  name: z.string().max(200),
  coverUrl: z.string().max(2_000).nullable(),
  /** A page of entries, already ordered by the source. */
  entries: z.array(musicTrackSchema).max(200),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  hasMore: z.boolean(),
}).strict();
export type MusicRank = z.infer<typeof musicRankSchema>;

export const musicArtistSchema = z.object({
  artistId: z.string().max(120),
  name: z.string().max(200),
  avatarUrl: z.string().max(2_000).nullable(),
  /** A one-line biography, when the source sends one. */
  bio: z.string().max(2_000).nullable(),
  trackCount: z.number().int().nonnegative(),
  albumCount: z.number().int().nonnegative(),
}).strict();
export type MusicArtist = z.infer<typeof musicArtistSchema>;

export const musicAlbumSchema = z.object({
  albumId: z.string().max(120),
  name: z.string().max(300),
  artist: z.string().max(200),
  coverUrl: z.string().max(2_000).nullable(),
  releaseDate: z.string().max(40).nullable(),
  trackCount: z.number().int().nonnegative(),
  tracks: z.array(musicTrackSchema).max(500),
}).strict();
export type MusicAlbum = z.infer<typeof musicAlbumSchema>;

export const musicCommentSchema = z.object({
  commentId: z.string().max(120),
  author: z.string().max(200),
  avatarUrl: z.string().max(2_000).nullable(),
  text: z.string().max(2_000),
  likes: z.number().int().nonnegative(),
  at: z.string().max(60),
  replies: z.array(z.object({
    commentId: z.string().max(120),
    author: z.string().max(200),
    text: z.string().max(2_000),
    likes: z.number().int().nonnegative(),
    at: z.string().max(60),
  }).strict()).max(50),
}).strict();
export type MusicComment = z.infer<typeof musicCommentSchema>;

/** The account, as much of it as a view needs. The token never leaves the server. */
export const musicAccountSchema = z.object({
  loggedIn: z.boolean(),
  userId: z.string().max(120).nullable(),
  nickname: z.string().max(200).nullable(),
  avatarUrl: z.string().max(2_000).nullable(),
  vip: z.boolean(),
  /** The tier name the source gave, e.g. "豪华VIP"; null when it said nothing. */
  vipLabel: z.string().max(120).nullable(),
  /** Which quality the account is entitled to. */
  entitledQuality: z.enum(MUSIC_QUALITIES),
}).strict();
export type MusicAccount = z.infer<typeof musicAccountSchema>;

export const MUSIC_ERROR_CODES = [
  "not_logged_in",
  "expired_session",
  "risk_control",
  "unreachable",
  "vip_required",
  "unsupported_format",
  "unknown_track",
  "unknown_playlist",
  "invalid_input",
  "stale_revision",
  "empty_queue",
  "queue_full",
  "duplicate",
  "not_found",
  "unsupported_action",
  "source_unavailable",
] as const;
export type MusicErrorCode = (typeof MUSIC_ERROR_CODES)[number];

/** One adapter's health, as the view's adapter card shows it. */
export const musicAdapterSchema = z.object({
  adapterId: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(120),
  kind: z.enum(["kugou", "local", "jellyfin"]),
  status: z.enum(["ready", "logged_out", "unreachable", "disabled"]),
  statusReason: z.string().max(500).optional(),
  trackCount: z.number().int().nonnegative(),
}).strict();
export type MusicAdapterSummary = z.infer<typeof musicAdapterSchema>;

/** Everything the music view needs on first paint, in one response. */
export const musicSnapshotSchema = z.object({
  playback: musicPlaybackSchema,
  account: musicAccountSchema,
  adapters: z.array(musicAdapterSchema).max(16),
  playlists: z.array(musicPlaylistSchema).max(500),
  at: instant,
}).strict();
export type MusicSnapshot = z.infer<typeof musicSnapshotSchema>;

/** A library folder the person added, with what the last scan found. */
export const musicLibraryFolderSchema = z.object({
  path: z.string().trim().min(1).max(2_000),
  trackCount: z.number().int().nonnegative(),
  scannedAt: instant.nullable(),
  error: z.string().max(300).nullable(),
}).strict();
export type MusicLibraryFolder = z.infer<typeof musicLibraryFolderSchema>;

/** The 10 bands the equalizer exposes, in Hz, in the order the curve draws them. */
export const MUSIC_EQ_BANDS_HZ = [32, 63, 125, 250, 500, 1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** The filter kind per band, by index: shelves at the ends, peaking between. Every client builds the same graph. */
export const MUSIC_EQ_BAND_TYPES = ["lowshelf", "peaking", "peaking", "peaking", "peaking", "peaking", "peaking", "peaking", "peaking", "highshelf"] as const;

/** Every peaking band's width. 1.0 is a musical octave-ish shape, not a surgical notch. */
export const MUSIC_EQ_Q = 1.0;

export const musicEqSchema = z.object({
  /** One gain per band, -12..+12 dB. */
  gains: z.array(z.number().min(-15).max(15)).length(MUSIC_EQ_BANDS_HZ.length),
  preset: z.string().max(60),
  enabled: z.boolean(),
}).strict();
export type MusicEq = z.infer<typeof musicEqSchema>;

export const MUSIC_EQ_PRESETS: Readonly<Record<string, readonly number[]>> = {
  // Upstream's EqualizerPresets table, band for band.
  acoustic: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pop: [-2, 0, -5, -1, 0, 0, 0, -3, 0, 0],
  rock: [4, 1, -2, 0, 0, -2, 0, -2, 1, 4],
  jazz: [0, 0, 0, -1, -1, -3, 0, 0, 0, 0],
  classical: [0, 0, 0, 0, 1, 3, 1, 6, 2, 6],
  hiphop: [3, 0, -3, 0, 0, -3, 0, 0, 0, 2],
  blues: [2, 2, -6, -2, 3, 1, 0, 1, 0, 2],
  electronic: [3, 1, -1, 0, 0, -3, 0, 0, 0, 0],
  metal: [2, 0, 0, -1, -1, -4, 0, 0, 0, 0],
  custom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

export function musicEqPreset(name: string): number[] | null {
  const preset = MUSIC_EQ_PRESETS[name];
  return preset ? [...preset] : null;
}

/** The six now-playing themes the upstream client ships. */
export const NOW_PLAYING_THEMES = ["standard", "pendolo", "fume", "sonnet", "lumiere", "tempera"] as const;
export type NowPlayingTheme = (typeof NOW_PLAYING_THEMES)[number];

/** Lumiere, Sonnet and Tempera share one shell and differ by preset, as upstream does. */
export const SILK_PRESETS: ReadonlySet<NowPlayingTheme> = new Set(["sonnet", "lumiere", "tempera"]);

export function isSilkTheme(theme: NowPlayingTheme): boolean {
  return SILK_PRESETS.has(theme);
}

/** Which qualities a source will actually serve, best first. */
export function qualityRank(quality: MusicQuality): number {
  return MUSIC_QUALITY_RANK[quality];
}

/** The best quality at or below `wanted` that `allowed` contains; null when none fit. */
export function bestQuality(wanted: MusicQuality, allowed: readonly MusicQuality[]): MusicQuality | null {
  const ceiling = MUSIC_QUALITY_RANK[wanted];
  let best: MusicQuality | null = null;
  for (const quality of allowed) {
    if (MUSIC_QUALITY_RANK[quality] > ceiling) continue;
    if (!best || MUSIC_QUALITY_RANK[quality] > MUSIC_QUALITY_RANK[best]) best = quality;
  }
  return best;
}

/** A track's display name: "Title — Artist". */
export function trackLabel(track: Pick<MusicTrack, "title" | "artists">): string {
  return track.artists.length ? `${track.title} — ${track.artists.join(", ")}` : track.title;
}

/** `mm:ss`, or `h:mm:ss` past an hour. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
