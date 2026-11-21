// The personal FM session: a preview of what the station will play, plus the
// upcoming/history stacks that turn "next", "dislike" and "previous" into report
// calls against persnfm.service.kugou.com's v2 personal_recommend endpoint. The
// state machine follows upstream's PersonalFmService, including the identity-key
// dedupe that keeps a song from ever appearing twice in one session.
import { MUSIC_FM_MODES, MUSIC_FM_POOLS, type MusicTrack } from "../../../shared/music.ts";
import { md5, LITE_APP_ID, LITE_CLIENT_VER, LITE_SALT } from "./signer.ts";
import { KugouError, type KugouTransport } from "./transport.ts";

const FAKE_DEVICE_ID = "ca981cfc583a4c37f28d2d49000013c16a0a";

export interface FmSessionState {
  mode: (typeof MUSIC_FM_MODES)[number];
  poolId: (typeof MUSIC_FM_POOLS)[number];
  active: boolean;
  current: MusicTrack | null;
  upcoming: MusicTrack[];
  history: MusicTrack[];
}

export interface FmDevice {
  dfid: string;
  mid: string;
  userId: string;
  token: string;
  vipType: string | null;
}

export interface PersonalFmOptions {
  transport: KugouTransport;
  device(): FmDevice;
  /** How many songs a preview holds, as upstream's station card shows. */
  previewSize?: number;
}

/** hash first, then the numeric audio id, then title and singer and duration. */
export function fmSongKey(track: MusicTrack): string {
  if (track.hash) return `hash:${track.hash.toLowerCase()}`;
  if (track.audioId) return `audio:${track.audioId}`;
  return `name:${track.title}:${track.artists.join(",")}:${track.durationSeconds}`;
}

function trackFromFmRow(row: Record<string, unknown>): MusicTrack | null {
  const hash = typeof row.hash === "string" ? row.hash.toLowerCase() : "";
  const title = typeof row.songname === "string" ? row.songname.trim() : "";
  if (!hash && !title) return null;
  const singers = Array.isArray(row.singerinfo)
    ? (row.singerinfo as unknown[]).map((info) => (info as Record<string, unknown>)?.name).filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
    : [];
  const author = typeof row.author_name === "string" ? row.author_name.trim() : "";
  const privilege = Number(row.privilege ?? 0);
  return {
    id: `kugou:${hash || String(row.songid ?? row.mixsongid ?? title)}`,
    source: "kugou",
    title,
    artists: singers.length ? singers : author ? [author] : [],
    album: null,
    albumId: typeof row.album_id === "string" && row.album_id ? row.album_id : null,
    durationSeconds: Math.max(Math.round(Number(row.time_length ?? 0)), 0),
    hash: hash || null,
    audioId: row.songid !== undefined && row.songid !== null ? String(row.songid) : row.mixsongid ? String(row.mixsongid) : null,
    coverUrl: null,
    vip: privilege >= 8,
    maxQuality: null,
    unsupportedReason: null,
  };
}

function dedupePush(target: MusicTrack[], track: MusicTrack, seen: Set<string>): void {
  const key = fmSongKey(track);
  if (seen.has(key)) return;
  seen.add(key);
  target.push(track);
}

export function createPersonalFm(options: PersonalFmOptions) {
  const { transport } = options;
  const previewSize = options.previewSize ?? 5;
  let mode: FmSessionState["mode"] = "normal";
  let poolId: FmSessionState["poolId"] = "taste";
  let active = false;
  let current: MusicTrack | null = null;
  let upcoming: MusicTrack[] = [];
  let history: MusicTrack[] = [];

  /** One call to the station: a report when a track is named, a fetch otherwise. */
  const recommend = async (input: { action?: "play" | "garbage"; hash?: string; songId?: string; playtimeSeconds?: number; isOverplay?: boolean; remainSongCount?: number }): Promise<MusicTrack[]> => {
    const device = options.device();
    const clienttime = Date.now();
    const body: Record<string, unknown> = {
      appid: LITE_APP_ID,
      clienttime,
      mid: device.mid || "-",
      action: input.action ?? "play",
      recommend_source_locked: 0,
      song_pool_id: poolId === "style" ? 1 : 0,
      callerid: 0,
      m_type: 1,
      platform: "android",
      area_code: 1,
      remain_songcnt: Math.max(0, input.remainSongCount ?? upcoming.length),
      clientver: LITE_CLIENT_VER,
      is_overplay: input.isOverplay ? 1 : 0,
      mode,
      fakem: FAKE_DEVICE_ID,
      key: md5(`${LITE_APP_ID}${LITE_SALT}${LITE_CLIENT_VER}${clienttime}`),
    };
    if (device.userId && device.userId !== "0") {
      body.userid = device.userId;
      body.kguid = device.userId;
    }
    if (device.token) body.token = device.token;
    if (device.vipType) body.vip_type = device.vipType;
    if (input.hash) body.hash = input.hash;
    if (input.songId) body.songid = input.songId;
    if (input.playtimeSeconds !== undefined) body.playtime = Math.max(0, Math.round(input.playtimeSeconds));

    const payload = await transport.request<{ song_list?: unknown[]; data?: { song_list?: unknown[]; mode?: string }; mode?: string; status?: number }>({
      url: "https://gateway.kugou.com/v2/personal_recommend",
      method: "POST",
      body: JSON.stringify(body),
      contentType: "application/json",
      signature: "lite",
      router: "persnfm.service.kugou.com",
    });
    const rows = (Array.isArray(payload?.song_list) ? payload.song_list : Array.isArray(payload?.data?.song_list) ? payload.data?.song_list : []) as unknown[];
    return rows.map((row) => trackFromFmRow(row as Record<string, unknown>)).filter((track): track is MusicTrack => track !== null);
  };

  /** Adds whatever the station returned to the upcoming stack, skipping everything already seen. */
  const absorb = (tracks: readonly MusicTrack[]): void => {
    const seen = new Set<string>();
    if (current) seen.add(fmSongKey(current));
    for (const track of history) seen.add(fmSongKey(track));
    for (const track of upcoming) seen.add(fmSongKey(track));
    for (const track of tracks) dedupePush(upcoming, track, seen);
  };

  const advanceCore = (): void => {
    const next = upcoming.shift();
    if (!next) {
      throw new KugouError("not_found", active
        ? "the personal FM has nothing queued; ask for a refresh"
        : "the personal FM returned no songs; sign in and try again", false);
    }
    if (current) history.push(current);
    current = next;
    active = true;
  };

  return {
    state(): FmSessionState {
      return { mode, poolId, active, current, upcoming: [...upcoming], history: [...history] };
    },

    /** Loads a preview and, when a start song is given, puts it first. */
    async start(startSong?: MusicTrack): Promise<FmSessionState> {
      const fetched = await recommend({});
      const seen = new Set<string>();
      const fresh: MusicTrack[] = [];
      for (const track of fetched) dedupePush(fresh, track, seen);
      if (startSong) {
        const rest = fresh.filter((track) => fmSongKey(track) !== fmSongKey(startSong));
        upcoming = rest.slice(0, previewSize);
        current = startSong;
      } else {
        current = fresh[0] ?? null;
        upcoming = fresh.slice(1, previewSize);
      }
      history = [];
      active = current !== null;
      if (!current) throw new KugouError("not_found", "the personal FM returned no songs; sign in and try again", false);
      return this.state();
    },

    /** Reports the finished play and moves to the station's next pick. */
    async next(playedSeconds?: number): Promise<FmSessionState> {
      if (current) {
        const report = await recommend({
          action: "play",
          hash: current.hash ?? undefined,
          songId: current.audioId ?? undefined,
          playtimeSeconds: playedSeconds,
          isOverplay: true,
        }).catch(() => [] as MusicTrack[]);
        absorb(report);
      }
      advanceCore();
      return this.state();
    },

    /** Throws the current track away and moves on; the station is told it was disliked. */
    async dislike(): Promise<FmSessionState> {
      if (current) {
        const report = await recommend({
          action: "garbage",
          hash: current.hash ?? undefined,
          songId: current.audioId ?? undefined,
        }).catch(() => [] as MusicTrack[]);
        absorb(report);
      }
      advanceCore();
      return this.state();
    },

    /** Steps back through the history stack; the stepped-off song waits at the head of upcoming. */
    previous(): FmSessionState {
      const last = history.pop();
      if (!last) throw new KugouError("not_found", "the personal FM has no earlier song to return to", false);
      if (current) upcoming.unshift(current);
      current = last;
      return this.state();
    },

    /** The auto-transition hook: when the player's ended track is the FM's next pick, the session follows it. */
    advanceForAutoTransition(trackId: string): FmSessionState | null {
      if (!active || !trackId) return null;
      const at = upcoming.findIndex((track) => track.id === trackId);
      if (at < 0) return null;
      const [taken] = upcoming.splice(at, 1);
      if (current) history.push(current);
      current = taken ?? null;
      return this.state();
    },

    /** normal → small → peak → normal, restarting the session when it is live. */
    cycleMode(): FmSessionState {
      const order = MUSIC_FM_MODES;
      mode = order[(order.indexOf(mode) + 1) % order.length]!;
      return this.state();
    },

    /** taste ⇄ style; the caller decides whether to restart the session. */
    togglePool(): FmSessionState {
      poolId = poolId === "taste" ? "style" : "taste";
      return this.state();
    },

    reset(): FmSessionState {
      active = false;
      current = null;
      upcoming = [];
      history = [];
      return this.state();
    },
  };
}
