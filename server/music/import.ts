// Importing a playlist from NetEase Cloud Music or QQ Music: the person pastes a
// share link or an id, this reads the public playlist, and each song is matched
// against Kugou by "title + artist" so the result is a real Kugou queue rather
// than a list of names. A song that does not match is reported, not dropped
// silently.
import type { MusicTrack } from "../../shared/music.ts";
import { KugouError, type KugouTransport } from "./kugou/transport.ts";

export const IMPORT_PLATFORMS = ["netease", "qq"] as const;
export type ImportPlatform = (typeof IMPORT_PLATFORMS)[number];

/** One song as the source playlist names it, before matching. */
export interface ImportedSong {
  title: string;
  artists: string[];
  album: string | null;
  durationSeconds: number;
}

export interface ImportPreview {
  platform: ImportPlatform;
  playlistId: string;
  name: string;
  coverUrl: string | null;
  songs: ImportedSong[];
}

export interface ImportResult {
  playlistId: string;
  name: string;
  /** Songs matched to a Kugou track, ready to queue. */
  matched: MusicTrack[];
  /** Songs with no confident Kugou match, with why. */
  unmatched: Array<{ title: string; artists: string[]; reason: string }>;
}

/** Pulls a playlist id out of a share link, a short link's text, or a bare id. */
export function parsePlaylistId(platform: ImportPlatform, input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^\d{4,}$/.test(text)) return text;
  if (platform === "netease") {
    const match = text.match(/[?&#]id=(\d{4,})/) ?? text.match(/playlist\/(\d{4,})/) ?? text.match(/\/playlist\?id=(\d+)/);
    return match?.[1] ?? null;
  }
  const match = text.match(/[?&#]id=([A-Za-z0-9]{4,})/) ?? text.match(/taoge\/([A-Za-z0-9]+)/) ?? text.match(/disstid=(\d+)/);
  return match?.[1] ?? null;
}

interface NeteasePlaylist {
  playlist?: {
    name?: string;
    coverImgUrl?: string;
    tracks?: Array<{
      name?: string;
      ar?: Array<{ name?: string }>;
      artists?: Array<{ name?: string }>;
      al?: { name?: string };
      album?: { name?: string };
      dt?: number;
      duration?: number;
    }>;
  };
}

interface QqPlaylist {
  cdlist?: Array<{
    dissname?: string;
    logo?: string;
    songlist?: Array<{
      songname?: string;
      name?: string;
      singer?: Array<{ name?: string }>;
      albumname?: string;
      album?: { name?: string };
      interval?: number;
    }>;
  }>;
}

export interface PlaylistImporterOptions {
  transport: KugouTransport;
}

export interface PlaylistImporter {
  /** Reads the source playlist without touching Kugou. */
  preview(platform: ImportPlatform, id: string): Promise<ImportPreview>;
  /** Matches every song against a search function and reports what did not match. */
  match(preview: ImportPreview, search: (query: string) => Promise<MusicTrack[]>): Promise<ImportResult>;
}

/** Normalises a title for matching: full-width to half-width, lowercase, punctuation gone. */
export function normaliseTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）|【[^】]*】/g, " ")
    .replace(/[\s\-_.,·、，。！？!?'"“”‘’]+/g, "")
    .trim();
}

/** How confident a search result is a match: exact title and an artist in common beats a substring. */
export function matchScore(song: ImportedSong, track: MusicTrack): number {
  const wantedTitle = normaliseTitle(song.title);
  const foundTitle = normaliseTitle(track.title);
  if (!wantedTitle || !foundTitle) return 0;
  let score = 0;
  if (wantedTitle === foundTitle) score += 60;
  else if (foundTitle.includes(wantedTitle) || wantedTitle.includes(foundTitle)) score += 30;
  else return 0;
  const wantedArtists = song.artists.map(normaliseTitle).filter(Boolean);
  const foundArtists = track.artists.map(normaliseTitle).filter(Boolean);
  if (wantedArtists.some((artist) => foundArtists.some((found: string) => found === artist || found.includes(artist) || artist.includes(found)))) score += 35;
  else if (wantedArtists.length && foundArtists.length) score -= 20;
  if (song.durationSeconds && track.durationSeconds) {
    const delta = Math.abs(song.durationSeconds - track.durationSeconds);
    if (delta <= 3) score += 10;
    else if (delta > 30) score -= 15;
  }
  return score;
}

/** Anything below this is a guess, and a guessed song in a playlist is worse than a reported miss. */
export const MATCH_THRESHOLD = 50;

export function createPlaylistImporter(options: PlaylistImporterOptions): PlaylistImporter {
  const { transport } = options;

  return {
    async preview(platform, id) {
      if (platform === "netease") {
        const payload = await transport.request<NeteasePlaylist>({
          url: "https://music.163.com/api/v6/playlist/detail",
          params: { id, n: "1000", s: "0" },
          headers: { referer: "https://music.163.com/" },
          signature: "none",
        });
        const playlist = payload?.playlist;
        if (!playlist?.tracks?.length) throw new KugouError("not_found", "that NetEase playlist is empty or private", false);
        return {
          platform,
          playlistId: id,
          name: playlist.name ?? "Imported playlist",
          coverUrl: playlist.coverImgUrl ?? null,
          songs: playlist.tracks.map((track) => ({
            title: track.name ?? "",
            artists: (track.ar ?? track.artists ?? []).map((artist) => artist.name ?? "").filter(Boolean),
            album: track.al?.name ?? track.album?.name ?? null,
            durationSeconds: Math.round((track.dt ?? track.duration ?? 0) / 1_000),
          })).filter((song) => song.title),
        };
      }

      const payload = await transport.request<QqPlaylist>({
        url: "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg",
        params: { type: "1", json: "1", utf8: "1", onlysong: "0", disstid: id, format: "json" },
        headers: { referer: "https://y.qq.com/" },
        signature: "none",
      });
      const cd = payload?.cdlist?.[0];
      if (!cd?.songlist?.length) throw new KugouError("not_found", "that QQ playlist is empty or private", false);
      return {
        platform,
        playlistId: id,
        name: cd.dissname ?? "Imported playlist",
        coverUrl: cd.logo ?? null,
        songs: cd.songlist.map((song) => ({
          title: song.songname ?? song.name ?? "",
          artists: (song.singer ?? []).map((artist) => artist.name ?? "").filter(Boolean),
          album: song.albumname ?? song.album?.name ?? null,
          durationSeconds: Math.round(Number(song.interval ?? 0)),
        })).filter((song) => song.title),
      };
    },

    async match(preview, search) {
      const matched: MusicTrack[] = [];
      const unmatched: ImportResult["unmatched"] = [];
      const seen = new Set<string>();
      for (const song of preview.songs) {
        const query = [song.title, ...song.artists.slice(0, 1)].filter(Boolean).join(" ");
        let candidates: MusicTrack[] = [];
        try {
          candidates = await search(query);
        } catch (error) {
          unmatched.push({ title: song.title, artists: song.artists, reason: error instanceof Error ? error.message.slice(0, 160) : "the search failed" });
          continue;
        }
        let best: { track: MusicTrack; score: number } | null = null;
        for (const candidate of candidates) {
          const score = matchScore(song, candidate);
          if (!best || score > best.score) best = { track: candidate, score };
        }
        if (!best || best.score < MATCH_THRESHOLD) {
          unmatched.push({ title: song.title, artists: song.artists, reason: "no confident match on Kugou" });
          continue;
        }
        if (seen.has(best.track.id)) continue;
        seen.add(best.track.id);
        matched.push(best.track);
      }
      return { playlistId: preview.playlistId, name: preview.name, matched, unmatched };
    },
  };
}
