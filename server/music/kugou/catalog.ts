// Everything Kugou can list: search, songs, playlists, ranks, recommendations,
// private FM, artists, albums, comments, long audio, videos, scenes and the
// user's cloud drive. Each function maps Kugou's field names onto the wire
// contract and nothing else; a caller never sees a Kugou-shaped object.
import type {
  MusicAlbum,
  MusicArtist,
  MusicComment,
  MusicPlaylist,
  MusicQuality,
  MusicRank,
  MusicTrack,
} from "../../../shared/music.ts";
import { createHash } from "node:crypto";

import { LITE_APP_ID, LITE_CLIENT_VER, PLAY_CLIENT_VER, v5Signature } from "./signer.ts";
import { KugouError, liteQuery, type KugouTransport } from "./transport.ts";

/** What every catalogue call needs from the account, whether or not it is signed in. */
export interface CatalogueDevice {
  dfid: string;
  mid: string;
  uuid: string;
  userId: string;
  token: string;
  /** Best quality the account may ask for. */
  entitledQuality: MusicQuality;
}

/** Kugou names its quality tiers in its own vocabulary; this is the mapping. */
const QUALITY_TO_KUGOU: Readonly<Record<MusicQuality, string>> = {
  "128k": "128",
  "320k": "320",
  flac: "flac",
  hires: "high",
};

const KUGOU_TO_QUALITY: Readonly<Record<string, MusicQuality>> = Object.fromEntries(
  Object.entries(QUALITY_TO_KUGOU).map(([ours, theirs]) => [theirs, ours as MusicQuality]),
);

const md5 = (value: string): string => createHash("md5").update(value).digest("hex");

/** Strips the highlight tags Kugou puts around a search hit. */
function plain(value: unknown): string {
  return typeof value === "string" ? value.replace(/<[^>]+>/g, "").trim() : "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Artists arrive as one delimited string; a duet is several. */
function artistsOf(...candidates: unknown[]): string[] {
  for (const candidate of candidates) {
    const raw = text(candidate);
    if (!raw) continue;
    return raw.split(/[/、,&]| feat\.? /i).map((name) => name.trim()).filter(Boolean).slice(0, 16);
  }
  return [];
}

/** Kugou sends a cover in several shapes: a bare URL, `{url}`, or a size-keyed map. */
function coverOf(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^https?:\/\//.test(candidate)) return candidate;
    if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      const direct = text(record.url) || text(record.pic) || text(record.imgurl);
      if (direct) return direct;
      for (const key of ["480", "400", "240", "big", "middle", "small"]) {
        const sized = text(record[key]);
        if (sized) return sized;
      }
    }
  }
  return null;
}

/** Kugou reports a paid track as a non-zero pay type. */
function vipOf(row: Record<string, unknown>): boolean {
  const pay = num(row.PayType ?? row.pay_type ?? row.payType);
  const privilege = num(row.privilege ?? row.privilege_type);
  return pay !== 0 || privilege > 0;
}

/** One row of a search result or a playlist into a track. A row with no hash and no id is dropped. */
export function trackFromRow(row: Record<string, unknown>, source: "kugou" = "kugou"): MusicTrack | null {
  const hash = text(row.FileHash ?? row.filehash ?? row.hash).toLowerCase() || null;
  const audioId = text(row.AlbumAudioID ?? row.album_audio_id ?? row.audio_id ?? row.Audioid) || null;
  const albumId = text(row.AlbumID ?? row.album_id ?? row.albumid) || null;
  const title = plain(row.SongName ?? row.songname ?? row.song_name ?? row.filename ?? row.name);
  if (!title) return null;
  if (!hash && !audioId) return null;
  const id = hash ?? `${albumId ?? "0"}_${audioId}`;
  return {
    id: `${source}:${id}`,
    source,
    title: title.slice(0, 300),
    artists: artistsOf(row.SingerName, row.singername, row.author_name, row.singer),
    album: text(row.AlbumName ?? row.album_name ?? row.albumname) || null,
    albumId,
    durationSeconds: Math.round(num(row.Duration ?? row.duration ?? row.timelen)),
    hash,
    audioId,
    coverUrl: coverOf(row.Image, row.trans_param, row.album_img, row.img, row.cover),
    vip: vipOf(row),
    maxQuality: null,
    unsupportedReason: null,
  };
}

function tracksFrom(rows: unknown): MusicTrack[] {
  if (!Array.isArray(rows)) return [];
  const tracks: MusicTrack[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const track = trackFromRow(row as Record<string, unknown>);
    if (!track || seen.has(track.id)) continue;
    seen.add(track.id);
    tracks.push(track);
  }
  return tracks;
}

function playlistFromRow(row: Record<string, unknown>, kind: MusicPlaylist["kind"]): MusicPlaylist | null {
  const sourceId = text(row.specialid ?? row.special_id ?? row.global_collection_id ?? row.listid ?? row.id);
  const name = plain(row.specialname ?? row.special_name ?? row.name ?? row.title);
  if (!sourceId || !name) return null;
  return {
    playlistId: `kugou:${sourceId}`,
    name: name.slice(0, 200),
    kind,
    sourceId,
    coverUrl: coverOf(row.imgurl, row.image, row.cover, row.pic),
    trackCount: Math.round(num(row.songcount ?? row.song_count ?? row.total)),
    local: false,
    createdAt: null,
  };
}

function playlistsFrom(rows: unknown, kind: MusicPlaylist["kind"]): MusicPlaylist[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => (row && typeof row === "object" ? playlistFromRow(row as Record<string, unknown>, kind) : null))
    .filter((row): row is MusicPlaylist => row !== null);
}

export interface KugouCatalogueOptions {
  transport: KugouTransport;
  device(): CatalogueDevice;
}

export interface SearchPage {
  tracks: MusicTrack[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface KugouCatalogue {
  searchTracks(input: { keyword: string; page?: number; pageSize?: number }): Promise<SearchPage>;
  searchPlaylists(input: { keyword: string; page?: number; pageSize?: number }): Promise<{ playlists: MusicPlaylist[]; page: number; hasMore: boolean }>;
  searchAlbums(input: { keyword: string; page?: number; pageSize?: number }): Promise<{ albums: MusicAlbum[]; page: number; hasMore: boolean }>;
  /** A playable URL for a track at a quality, or a typed refusal. */
  playUrl(input: { hash: string; albumId?: string | null; audioId?: string | null; quality: MusicQuality }): Promise<{ url: string; quality: MusicQuality; free: boolean; expiresInSeconds: number }>;
  /** The qualities this track's file tree actually has, per the privilege-lite endpoint. */
  privilegeQualities(hash: string, albumId?: string | null): Promise<MusicQuality[]>;
  /** A stream URL for one of the person's own cloud-drive files. */
  cloudUrl(input: { hash: string; albumAudioId?: string | null; audioId?: string | null; name?: string | null }): Promise<string>;
  playlistTracks(playlistId: string, input?: { page?: number; pageSize?: number }): Promise<{ name: string; tracks: MusicTrack[]; page: number; hasMore: boolean }>;
  playlists(kind: "created" | "collected"): Promise<MusicPlaylist[]>;
  createPlaylist(name: string): Promise<MusicPlaylist>;
  addToPlaylist(playlistId: string, trackIds: readonly string[]): Promise<void>;
  removeFromPlaylist(playlistId: string, trackIds: readonly string[]): Promise<void>;
  ranks(): Promise<Array<{ rankId: string; name: string; coverUrl: string | null }>>;
  rank(rankId: string, input?: { page?: number; pageSize?: number }): Promise<MusicRank>;
  dailyRecommendations(): Promise<{ tracks: MusicTrack[]; playlists: MusicPlaylist[] }>;
  privateFm(input?: { mode?: "next" | "trash" }): Promise<MusicTrack[]>;
  scenes(): Promise<Array<{ sceneId: string; name: string; coverUrl: string | null }>>;
  sceneTracks(sceneId: string): Promise<MusicTrack[]>;
  artist(artistId: string): Promise<{ artist: MusicArtist; tracks: MusicTrack[]; albums: MusicAlbum[] }>;
  album(albumId: string): Promise<MusicAlbum>;
  comments(input: { trackId: string; page?: number; pageSize?: number }): Promise<{ comments: MusicComment[]; page: number; hasMore: boolean }>;
  postComment(trackId: string, body: string): Promise<MusicComment | null>;
  likeComment(commentId: string, like: boolean): Promise<void>;
  longAudio(input: { page?: number; pageSize?: number }): Promise<SearchPage>;
  videoUrl(hash: string): Promise<{ url: string; durationSeconds: number }>;
  cloudTracks(input?: { page?: number; pageSize?: number }): Promise<SearchPage>;
  favorite(trackId: string, favorite: boolean): Promise<void>;
  /** Reports a real play, so Kugou's recommendations stay accurate. */
  reportPlay(track: MusicTrack, playedSeconds: number): Promise<void>;
}

export function createKugouCatalogue(options: KugouCatalogueOptions): KugouCatalogue {
  const { transport, device } = options;

  /** The play URL is the one call that refuses a track it will not serve; its reasons are the interesting part. */
  const playUrl: KugouCatalogue["playUrl"] = async (input) => {
    const current = device();
    const quality = QUALITY_TO_KUGOU[input.quality];
    const params: Record<string, string> = {
      album_id: input.albumId ?? "0",
      area_code: "1",
      hash: input.hash.toLowerCase(),
      ssa_flag: "is_fromtrack",
      version: PLAY_CLIENT_VER,
      page_id: "967177915",
      quality,
      album_audio_id: input.audioId ?? "0",
      behavior: "play",
      pid: "411",
      cmd: "26",
      pidversion: "3001",
      // Upstream never asks for the free part here; a paywall surfaces as a refusal instead.
      IsFreePart: "0",
      ppage_id: "463267751,428496857,439288576,456801020,463260431",
      cdnBackup: "1",
      module: "",
      clientver: PLAY_CLIENT_VER,
      dfid: current.dfid || "-",
      mid: current.mid,
      userid: current.userId,
      token: current.token,
      signature: v5Signature(input.hash, current.mid, current.userId),
    };
    const payload = await transport.request<{
      status?: number;
      err_code?: number;
      error?: string;
      url?: string | string[];
      timeLength?: number;
      free_part?: number;
    }>({ url: "https://trackercdn.kugou.com/v5/url", params, signature: "none" });

    const status = num(payload?.status);
    if (status !== 1) {
      const reason = text(payload?.error);
      // 2 is "no such file"; anything about privilege is the paid wall.
      if (status === 2 || /not exist|不存在/i.test(reason)) {
        throw new KugouError("not_found", reason || "Kugou has no playable file for this track", false);
      }
      if (/vip|privilege|购买|付费/i.test(reason)) {
        throw new KugouError("vip_required", reason || "this track needs a paid account at that quality; ask for a lower quality or sign in", false);
      }
      throw new KugouError("source_unavailable", reason || `Kugou refused the play request (status ${status})`, false);
    }
    const candidates = Array.isArray(payload.url) ? payload.url : [payload.url];
    const url = candidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
    if (!url) throw new KugouError("empty_url", "Kugou answered the play request but handed out no URL", false);
    return {
      url,
      quality: input.quality,
      free: num(payload.free_part) === 1,
      // The signed URL is short-lived; the server re-resolves rather than handing out a stale one.
      expiresInSeconds: 3_600,
    };
  };

  /** The qualities the track's own file tree carries, found by walking relate_goods. */
  const privilegeQualities: KugouCatalogue["privilegeQualities"] = async (hash, albumId) => {
    const body = JSON.stringify({
      appid: LITE_APP_ID,
      area_code: 1,
      behavior: "play",
      clientver: LITE_CLIENT_VER,
      need_hash_offset: 0,
      relate: 1,
      support_verify: 1,
      resource: [{ type: "audio", page_id: 0, hash: hash.toLowerCase(), album_id: albumId ?? "0" }],
      qualities: ["128", "320", "flac", "high", "viper_atmos", "viper_tape", "viper_clear", "super", "multitrack"],
    });
    const payload = await transport.request<{ data?: unknown[]; status?: number }>({
      url: "https://media.store.kugou.com/v2/get_res_privilege/lite",
      method: "POST",
      body,
      contentType: "application/json",
      signature: "none",
      router: "media.store.kugou.com",
    });
    const found = new Set<MusicQuality>();
    const walk = (rows: unknown[]): void => {
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const name = typeof record.quality === "string" ? record.quality.trim().toLowerCase() : "";
        const mapped = KUGOU_TO_QUALITY[name];
        if (mapped) found.add(mapped);
        const related = record.relate_goods;
        if (Array.isArray(related)) walk(related);
      }
    };
    if (Array.isArray(payload?.data)) walk(payload.data);
    return [...found];
  };

  /** One of the person's own cloud files; the status and URL must both be usable. */
  const cloudUrl: KugouCatalogue["cloudUrl"] = async (input) => {
    const hash = input.hash.toLowerCase();
    const pid = "20026";
    const payload = await transport.request<{ status?: number; url?: string }>({
      url: "https://gateway.kugou.com/bsstrackercdngz/v2/query_musicclound_url",
      params: liteQuery({
        hash,
        ssa_flag: "is_fromtrack",
        version: "20102",
        ssl: "0",
        album_audio_id: input.albumAudioId ?? "0",
        pid,
        audio_id: input.audioId ?? "0",
        kv_id: "2",
        key: md5(`musicclound${hash}${pid}ebd1ac3134c880bda6a2194537843caa0162e2e7`),
        bucket: "musicclound",
        name: input.name ?? "",
        with_res_tag: "0",
      }),
      router: "bsstrackercdngz.kugou.com",
    });
    const url = typeof payload?.url === "string" ? payload.url : "";
    if (Number(payload?.status ?? 0) !== 1 || !url.trim()) {
      throw new KugouError("source_unavailable", "Kugou could not serve this cloud-drive file right now", false);
    }
    return url;
  };

  return {
    privilegeQualities,
    cloudUrl,

    async searchTracks(input) {
      const page = Math.max(Math.trunc(input.page ?? 1), 1);
      const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? 20), 1), 100);
      const payload = await transport.request<{ data?: { lists?: unknown[]; total?: number }; status?: number }>({
        url: "https://songsearch.kugou.com/song/search/v2",
        params: liteQuery({ keyword: input.keyword.trim(), page: String(page), pagesize: String(pageSize), platform: "WebFilter", tag: "em", sver: "2", with_res_tag: "1" }),
      });
      const tracks = tracksFrom(payload?.data?.lists);
      const total = num(payload?.data?.total);
      return { tracks, page, pageSize, total, hasMore: tracks.length >= pageSize && (total === 0 || page * pageSize < total) };
    },

    async searchPlaylists(input) {
      const page = Math.max(Math.trunc(input.page ?? 1), 1);
      const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? 20), 1), 100);
      const payload = await transport.request<{ data?: { info?: unknown[]; total?: number } }>({
        url: "https://complexsearch.kugou.com/v2/search/song",
        params: liteQuery({ keyword: input.keyword.trim(), page: String(page), pagesize: String(pageSize), searchtype: "special", platform: "WebFilter" }),
      });
      const playlists = playlistsFrom(payload?.data?.info, "collected");
      return { playlists, page, hasMore: playlists.length >= pageSize };
    },

    async searchAlbums(input) {
      const page = Math.max(Math.trunc(input.page ?? 1), 1);
      const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? 20), 1), 100);
      const payload = await transport.request<{ data?: { info?: unknown[] } }>({
        url: "https://complexsearch.kugou.com/v2/search/song",
        params: liteQuery({ keyword: input.keyword.trim(), page: String(page), pagesize: String(pageSize), searchtype: "album", platform: "WebFilter" }),
      });
      const rows = Array.isArray(payload?.data?.info) ? payload.data.info : [];
      const albums: MusicAlbum[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const albumId = text(record.albumid ?? record.AlbumID ?? record.album_id);
        const name = plain(record.albumname ?? record.AlbumName ?? record.name);
        if (!albumId || !name) continue;
        albums.push({
          albumId,
          name: name.slice(0, 300),
          artist: plain(record.singername ?? record.SingerName ?? record.author_name),
          coverUrl: coverOf(record.imgurl, record.image, record.cover),
          releaseDate: text(record.publish_time ?? record.publishtime) || null,
          trackCount: Math.round(num(record.songcount ?? record.song_count)),
          tracks: [],
        });
      }
      return { albums, page, hasMore: albums.length >= pageSize };
    },

    playUrl,

    async playlistTracks(playlistId, input) {
      const sourceId = playlistId.replace(/^kugou:/, "");
      const page = Math.max(Math.trunc(input?.page ?? 1), 1);
      const pageSize = Math.min(Math.max(Math.trunc(input?.pageSize ?? 100), 1), 500);
      const payload = await transport.request<{
        data?: { info?: unknown[]; specialname?: string; name?: string; total?: number; list?: { info?: unknown[] } };
        info?: unknown[];
        name?: string;
      }>({
        url: "https://www.kugou.com/yy/special/single/mobile/special.html",
        params: liteQuery({ specialid: sourceId, page: String(page), pagesize: String(pageSize), plat: "0", version: "8000" }),
      });
      const rows = payload?.data?.info ?? payload?.data?.list?.info ?? payload?.info ?? [];
      const tracks = tracksFrom(rows);
      return {
        name: plain(payload?.data?.specialname ?? payload?.data?.name ?? payload?.name) || "Playlist",
        tracks,
        page,
        hasMore: tracks.length >= pageSize,
      };
    },

    async playlists(kind) {
      const current = device();
      if (!current.token) throw new KugouError("not_logged_in", "sign in to Kugou to see your playlists", false);
      const payload = await transport.request<{ data?: { info?: unknown[] }; info?: unknown[] }>({
        url: "https://www.kugou.com/yy/special/index/special.html",
        params: liteQuery({ userid: current.userId, token: current.token, type: kind === "created" ? "1" : "2", page: "1", pagesize: "200", plat: "0" }),
      });
      return playlistsFrom(payload?.data?.info ?? payload?.info, kind);
    },

    async createPlaylist(name) {
      const current = device();
      if (!current.token) throw new KugouError("not_logged_in", "sign in to Kugou to create a playlist", false);
      const payload = await transport.request<{ data?: { specialid?: string | number; specialname?: string }; status?: number }>({
        url: "https://www.kugou.com/yy/special/create",
        method: "POST",
        params: liteQuery({ userid: current.userId, token: current.token, name: name.trim(), plat: "0" }),
      });
      const sourceId = text(payload?.data?.specialid);
      if (!sourceId) throw new KugouError("source_unavailable", "Kugou did not create the playlist", false);
      return {
        playlistId: `kugou:${sourceId}`,
        name: plain(payload?.data?.specialname) || name.trim(),
        kind: "created",
        sourceId,
        coverUrl: null,
        trackCount: 0,
        local: false,
        createdAt: new Date().toISOString(),
      };
    },

    async addToPlaylist(playlistId, trackIds) {
      const current = device();
      if (!current.token) throw new KugouError("not_logged_in", "sign in to Kugou to change a playlist", false);
      const hashes = trackIds.map((id) => id.replace(/^kugou:/, "")).filter(Boolean);
      if (!hashes.length) throw new KugouError("invalid_input", "no tracks to add", false);
      const payload = await transport.request<{ status?: number; error?: string }>({
        url: "https://www.kugou.com/yy/special/song/add",
        method: "POST",
        params: liteQuery({ specialid: playlistId.replace(/^kugou:/, ""), userid: current.userId, token: current.token, data: hashes.join(","), plat: "0" }),
      });
      if (Number(payload?.status ?? 1) !== 1) throw new KugouError("source_unavailable", payload?.error || "Kugou refused the change", false);
    },

    async removeFromPlaylist(playlistId, trackIds) {
      const current = device();
      if (!current.token) throw new KugouError("not_logged_in", "sign in to Kugou to change a playlist", false);
      const hashes = trackIds.map((id) => id.replace(/^kugou:/, "")).filter(Boolean);
      if (!hashes.length) throw new KugouError("invalid_input", "no tracks to remove", false);
      const payload = await transport.request<{ status?: number; error?: string }>({
        url: "https://www.kugou.com/yy/special/song/del",
        method: "POST",
        params: liteQuery({ specialid: playlistId.replace(/^kugou:/, ""), userid: current.userId, token: current.token, data: hashes.join(","), plat: "0" }),
      });
      if (Number(payload?.status ?? 1) !== 1) throw new KugouError("source_unavailable", payload?.error || "Kugou refused the change", false);
    },

    async ranks() {
      const payload = await transport.request<{ data?: { info?: unknown[] }; info?: unknown[] }>({
        url: "https://www.kugou.com/yy/rank/home/1-8888.html",
        params: liteQuery({ plat: "0", withsong: "0" }),
      });
      const rows = payload?.data?.info ?? payload?.info ?? [];
      if (!Array.isArray(rows)) return [];
      const ranks: Array<{ rankId: string; name: string; coverUrl: string | null }> = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const rankId = text(record.rankid ?? record.rank_id ?? record.id);
        const name = plain(record.rankname ?? record.rank_name ?? record.name);
        if (!rankId || !name) continue;
        ranks.push({ rankId, name, coverUrl: coverOf(record.imgurl, record.image, record.cover) });
      }
      return ranks;
    },

    async rank(rankId, input) {
      const page = Math.max(Math.trunc(input?.page ?? 1), 1);
      const pageSize = Math.min(Math.max(Math.trunc(input?.pageSize ?? 30), 1), 200);
      const payload = await transport.request<{ data?: { info?: unknown[]; rankname?: string; imgurl?: string; total?: number }; info?: unknown[] }>({
        url: "https://www.kugou.com/yy/rank/home/mobile/rank.html",
        params: liteQuery({ rankid: rankId, page: String(page), pagesize: String(pageSize), plat: "0" }),
      });
      const tracks = tracksFrom(payload?.data?.info ?? payload?.info);
      return {
        rankId,
        name: plain(payload?.data?.rankname) || "Rank",
        coverUrl: coverOf(payload?.data?.imgurl),
        entries: tracks,
        page,
        pageSize,
        hasMore: tracks.length >= pageSize,
      };
    },

    async dailyRecommendations() {
      const current = device();
      const payload = await transport.request<{ data?: { info?: unknown[]; song_list?: unknown[]; special_list?: unknown[] }; info?: unknown[] }>({
        url: "https://www.kugou.com/yy/index.php",
        params: liteQuery({ r: "play/getdata", plat: "0", userid: current.userId, token: current.token, type: "daily" }),
      });
      const data = payload?.data ?? {};
      return {
        tracks: tracksFrom(data.info ?? data.song_list ?? payload?.info),
        playlists: playlistsFrom(data.special_list, "collected"),
      };
    },

    async privateFm(input) {
      const current = device();
      const payload = await transport.request<{ data?: { info?: unknown[] }; info?: unknown[] }>({
        url: "https://www.kugou.com/yy/index.php",
        params: liteQuery({ r: "play/getdata", plat: "0", userid: current.userId, token: current.token, type: "fm", mode: input?.mode === "trash" ? "trash" : "next" }),
      });
      return tracksFrom(payload?.data?.info ?? payload?.info);
    },

    async scenes() {
      const payload = await transport.request<{ data?: { info?: unknown[] } }>({
        url: "https://www.kugou.com/yy/index.php",
        params: liteQuery({ r: "play/getdata", plat: "0", type: "scene" }),
      });
      const rows = Array.isArray(payload?.data?.info) ? payload.data.info : [];
      const scenes: Array<{ sceneId: string; name: string; coverUrl: string | null }> = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const sceneId = text(record.sceneid ?? record.id);
        const name = plain(record.name ?? record.scenename);
        if (!sceneId || !name) continue;
        scenes.push({ sceneId, name, coverUrl: coverOf(record.imgurl, record.image) });
      }
      return scenes;
    },

    async sceneTracks(sceneId) {
      const payload = await transport.request<{ data?: { info?: unknown[] } }>({
        url: "https://www.kugou.com/yy/index.php",
        params: liteQuery({ r: "play/getdata", plat: "0", type: "scene_song", sceneid: sceneId }),
      });
      return tracksFrom(payload?.data?.info);
    },

    async artist(artistId) {
      const payload = await transport.request<{
        data?: { info?: Record<string, unknown>; song_list?: unknown[]; album_list?: unknown[] };
      }>({
        url: "https://www.kugou.com/yy/singer/home/mobile/index.html",
        params: liteQuery({ singerid: artistId, plat: "0", pagesize: "50" }),
      });
      const info = payload?.data?.info ?? {};
      const albums: MusicAlbum[] = [];
      for (const row of Array.isArray(payload?.data?.album_list) ? payload!.data!.album_list! : []) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const albumId = text(record.albumid ?? record.album_id);
        const name = plain(record.albumname ?? record.album_name);
        if (!albumId || !name) continue;
        albums.push({
          albumId,
          name: name.slice(0, 300),
          artist: plain(info.singername ?? info.name),
          coverUrl: coverOf(record.imgurl, record.image),
          releaseDate: text(record.publishtime) || null,
          trackCount: Math.round(num(record.songcount)),
          tracks: [],
        });
      }
      const tracks = tracksFrom(payload?.data?.song_list);
      return {
        artist: {
          artistId,
          name: plain(info.singername ?? info.name) || "Artist",
          avatarUrl: coverOf(info.imgurl, info.image),
          bio: plain(info.intro ?? info.profile) || null,
          trackCount: Math.round(num(info.songcount)) || tracks.length,
          albumCount: Math.round(num(info.albumcount)) || albums.length,
        },
        tracks,
        albums,
      };
    },

    async album(albumId) {
      const payload = await transport.request<{ data?: { info?: Record<string, unknown>; song_list?: unknown[] } }>({
        url: "https://www.kugou.com/yy/album/single/mobile/index.html",
        params: liteQuery({ albumid: albumId, plat: "0", pagesize: "200" }),
      });
      const info = payload?.data?.info ?? {};
      return {
        albumId,
        name: plain(info.albumname ?? info.name) || "Album",
        artist: plain(info.singername ?? info.author_name),
        coverUrl: coverOf(info.imgurl, info.image),
        releaseDate: text(info.publishtime) || null,
        trackCount: Math.round(num(info.songcount)) || (payload?.data?.song_list?.length ?? 0),
        tracks: tracksFrom(payload?.data?.song_list),
      };
    },

    async comments(input) {
      const hash = input.trackId.replace(/^kugou:/, "");
      const page = Math.max(Math.trunc(input.page ?? 1), 1);
      const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? 30), 1), 100);
      const payload = await transport.request<{
        data?: { list?: unknown[]; total?: number };
        list?: unknown[];
      }>({
        url: "https://mcomment.kugou.com/index.php",
        params: liteQuery({ r: "comments/getcomments", code: "fc4be23b4e972707f36b8a828a1b1d8b", hash, page: String(page), pagesize: String(pageSize), plat: "0" }),
      });
      const rows = payload?.data?.list ?? payload?.list ?? [];
      const comments: MusicComment[] = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const commentId = text(record.id ?? record.commentid);
        const body = plain(record.content ?? record.text);
        if (!commentId || !body) continue;
        comments.push({
          commentId,
          author: plain(record.username ?? record.nickname) || "Listener",
          avatarUrl: coverOf(record.user_pic, record.avatar),
          text: body.slice(0, 2_000),
          likes: Math.round(num(record.like_count ?? record.likes)),
          at: text(record.addtime ?? record.time),
          replies: [],
        });
      }
      return { comments, page, hasMore: comments.length >= pageSize };
    },

    async postComment(trackId, body) {
      const current = device();
      if (!current.token) throw new KugouError("not_logged_in", "sign in to Kugou to comment", false);
      const trimmed = body.trim();
      if (!trimmed) throw new KugouError("invalid_input", "a comment needs text", false);
      const payload = await transport.request<{ data?: { id?: string | number }; status?: number; error?: string }>({
        url: "https://mcomment.kugou.com/index.php",
        method: "POST",
        params: liteQuery({
          r: "comments/addcomments",
          code: "fc4be23b4e972707f36b8a828a1b1d8b",
          hash: trackId.replace(/^kugou:/, ""),
          content: trimmed.slice(0, 500),
          userid: current.userId,
          token: current.token,
          plat: "0",
        }),
      });
      if (Number(payload?.status ?? 1) !== 1) throw new KugouError("source_unavailable", payload?.error || "Kugou refused the comment", false);
      const commentId = text(payload?.data?.id);
      return commentId
        ? { commentId, author: "You", avatarUrl: null, text: trimmed.slice(0, 2_000), likes: 0, at: new Date().toISOString(), replies: [] }
        : null;
    },

    async likeComment(commentId, like) {
      const current = device();
      if (!current.token) throw new KugouError("not_logged_in", "sign in to Kugou to like a comment", false);
      await transport.request({
        url: "https://mcomment.kugou.com/index.php",
        method: "POST",
        params: liteQuery({
          r: like ? "comments/like" : "comments/unlike",
          commentid: commentId,
          userid: current.userId,
          token: current.token,
          plat: "0",
        }),
      });
    },

    async longAudio(input) {
      const page = Math.max(Math.trunc(input.page ?? 1), 1);
      const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? 20), 1), 100);
      const payload = await transport.request<{ data?: { info?: unknown[] } }>({
        url: "https://www.kugou.com/yy/index.php",
        params: liteQuery({ r: "play/getdata", plat: "0", type: "longaudio", page: String(page), pagesize: String(pageSize) }),
      });
      const tracks = tracksFrom(payload?.data?.info);
      return { tracks, page, pageSize, total: tracks.length, hasMore: tracks.length >= pageSize };
    },

    async videoUrl(hash) {
      const current = device();
      const payload = await transport.request<{ data?: { info?: Array<Record<string, unknown>> }; info?: Array<Record<string, unknown>> }>({
        url: "https://www.kugou.com/yy/index.php",
        params: liteQuery({ r: "play/getdata", plat: "0", hash: hash.toLowerCase(), dfid: current.dfid, mid: current.mid, userid: current.userId, token: current.token }),
      });
      const info = (payload?.data?.info ?? payload?.info ?? [])[0];
      const url = text(info?.video_url ?? info?.mvurl ?? info?.url);
      if (!url) throw new KugouError("not_found", "this track has no video", false);
      return { url, durationSeconds: Math.round(num(info?.duration ?? info?.timelen)) };
    },

    async cloudTracks(input) {
      const current = device();
      if (!current.token) throw new KugouError("not_logged_in", "sign in to Kugou to see your cloud drive", false);
      const page = Math.max(Math.trunc(input?.page ?? 1), 1);
      const pageSize = Math.min(Math.max(Math.trunc(input?.pageSize ?? 50), 1), 200);
      const payload = await transport.request<{ data?: { info?: unknown[] } }>({
        url: "https://www.kugou.com/yy/index.php",
        params: liteQuery({ r: "play/getdata", plat: "0", type: "cloud", userid: current.userId, token: current.token, page: String(page), pagesize: String(pageSize) }),
      });
      const tracks = tracksFrom(payload?.data?.info);
      return { tracks, page, pageSize, total: tracks.length, hasMore: tracks.length >= pageSize };
    },

    async favorite(trackId, favorite) {
      const current = device();
      if (!current.token) throw new KugouError("not_logged_in", "sign in to Kugou to change favourites", false);
      const payload = await transport.request<{ status?: number; error?: string }>({
        url: "https://www.kugou.com/yy/index.php",
        method: "POST",
        params: liteQuery({
          r: favorite ? "play/addfavorite" : "play/delfavorite",
          hash: trackId.replace(/^kugou:/, ""),
          userid: current.userId,
          token: current.token,
          plat: "0",
        }),
      });
      if (Number(payload?.status ?? 1) !== 1) throw new KugouError("source_unavailable", payload?.error || "Kugou refused the change", false);
    },

    async reportPlay(track, playedSeconds) {
      // Reporting is best-effort: a failure changes no state a person can see.
      if (!track.hash) return;
      const current = device();
      try {
        await transport.request({
          url: "https://t.kugou.com/v1/play/report",
          method: "POST",
          params: liteQuery({ plat: "0", dfid: current.dfid, mid: current.mid, userid: current.userId, token: current.token }),
          body: JSON.stringify({ hash: track.hash, playtime: Math.round(playedSeconds), album_id: track.albumId ?? "0", audio_id: track.audioId ?? "0" }),
          contentType: "application/json",
        });
      } catch { /* a report is telemetry, never a failure the person needs to see */ }
    },
  };
}
