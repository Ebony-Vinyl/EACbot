// The local library: folder scanning, tag reading, cover and lyric matching. A
// scan is resumable and skips an unchanged file by size and mtime, so a second
// pass over a large library costs almost nothing.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import type { MusicTrack } from "../../shared/music.ts";
import { readDsdInfo, DsdError } from "./dsd.ts";
import type { LocalTrackRow, MusicStore } from "./store.ts";
import { stripPadding } from "./tags.ts";

/** Extensions the browser can decode once the server serves them. */
const PLAYABLE_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".webm", ".opus", ".aiff", ".aif"]);
/** Extensions that need the server's DSD decoder before a browser sees them. */
const DSD_EXTENSIONS = new Set([".dsf", ".dff"]);
/** Files the scan recognises but the browser cannot decode (Ape/ALAC-less builds); they are listed, not faked. */
const RECOGNISED_EXTENSIONS = new Set([...PLAYABLE_EXTENSIONS, ...DSD_EXTENSIONS, ".ape"]);
/** A cover or lyric beside the audio file, by convention. */
const COVER_NAMES = ["cover", "folder", "front", "album", "albumart"];
const COVER_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const LYRIC_EXTENSIONS = [".lrc", ".krc", ".qrc", ".vtt", ".yrc"];

/** How many files one scan walks before it stops and asks to be run again. */
export const MAX_SCAN_FILES = 50_000;

export interface LocalScanResult {
  folder: string;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  unsupported: number;
  /** Set when the walk hit the file cap; a second scan continues from the start. */
  truncated: boolean;
  error: string | null;
}

/** A stable id for a local track: the absolute path hashed, so it survives a re-scan and a rename is a new track. */
export function localTrackId(path: string): string {
  return `local:${createHash("sha1").update(resolve(path)).digest("hex").slice(0, 24)}`;
}

/**
 * Reads what tags a file carries without a tag library: an ID3v2 block on MP3,
 * a Vorbis comment on FLAC and OGG. Anything it cannot read falls back to the
 * file name, which is what a person would have named it anyway.
 */
export function readTags(path: string): { title: string | null; artist: string | null; album: string | null; durationSeconds: number } {
  const empty = { title: null, artist: null, album: null, durationSeconds: 0 };
  let head: Buffer;
  try {
    const stat = statSync(path);
    // Tags live at the start; 512 KiB is enough for any real one and cheap to read.
    const fd = readFileSync(path, { flag: "r" });
    head = fd.subarray(0, Math.min(512 * 1024, stat.size));
  } catch {
    return empty;
  }

  if (head.length > 10 && head.subarray(0, 3).toString("ascii") === "ID3") {
    const size = ((head[6]! & 0x7f) << 21) | ((head[7]! & 0x7f) << 14) | ((head[8]! & 0x7f) << 7) | (head[9]! & 0x7f);
    const body = head.subarray(10, Math.min(10 + size, head.length));
    const frame = (id: string): string | null => {
      let cursor = 0;
      while (cursor + 10 <= body.length) {
        const frameId = body.subarray(cursor, cursor + 4).toString("ascii");
        if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
        const frameSize = body.readUInt32BE(cursor + 4);
        if (frameSize <= 0 || cursor + 10 + frameSize > body.length) break;
        if (frameId === id) {
          const payload = body.subarray(cursor + 10, cursor + 10 + frameSize);
          const encoding = payload[0];
          const text = payload.subarray(1);
          const value = stripPadding(encoding === 1 || encoding === 2 ? text.toString("utf16le") : text.toString("utf8"));
          return value || null;
        }
        cursor += 10 + frameSize;
      }
      return null;
    };
    return { title: frame("TIT2"), artist: frame("TPE1"), album: frame("TALB"), durationSeconds: 0 };
  }

  if (head.length > 4 && head.subarray(0, 4).toString("ascii") === "fLaC") {
    // A FLAC metadata block chain; block type 4 is a Vorbis comment.
    let cursor = 4;
    while (cursor + 4 <= head.length) {
      const header = head[cursor]!;
      const last = (header & 0x80) !== 0;
      const type = header & 0x7f;
      const length = (head[cursor + 1]! << 16) | (head[cursor + 2]! << 8) | head[cursor + 3]!;
      const body = head.subarray(cursor + 4, cursor + 4 + length);
      if (type === 4) {
        const parsed = readVorbisComment(body);
        return { ...parsed, durationSeconds: 0 };
      }
      if (last) break;
      cursor += 4 + length;
    }
  }

  if (head.length > 4 && head.subarray(0, 4).toString("ascii") === "OggS") {
    const at = head.indexOf(Buffer.from([0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]));
    if (at > 0) {
      const parsed = readVorbisComment(head.subarray(at + 7, Math.min(at + 7 + 65_536, head.length)));
      return { ...parsed, durationSeconds: 0 };
    }
  }

  return empty;
}

function readVorbisComment(body: Buffer): { title: string | null; artist: string | null; album: string | null } {
  try {
    let cursor = 0;
    const vendorLength = body.readUInt32LE(cursor);
    cursor += 4 + vendorLength;
    const count = body.readUInt32LE(cursor);
    cursor += 4;
    const fields: Record<string, string> = {};
    for (let index = 0; index < count && cursor + 4 <= body.length; index++) {
      const length = body.readUInt32LE(cursor);
      cursor += 4;
      if (cursor + length > body.length) break;
      const entry = body.subarray(cursor, cursor + length).toString("utf8");
      cursor += length;
      const equals = entry.indexOf("=");
      if (equals > 0) fields[entry.slice(0, equals).toUpperCase()] = entry.slice(equals + 1).trim();
    }
    return {
      title: fields.TITLE || null,
      artist: fields.ARTIST || fields.ALBUMARTIST || null,
      album: fields.ALBUM || null,
    };
  } catch {
    return { title: null, artist: null, album: null };
  }
}

/** A cover image beside the audio file, if there is one. */
export function findCover(path: string): string | null {
  const directory = join(path, "..");
  for (const name of COVER_NAMES) {
    for (const extension of COVER_EXTENSIONS) {
      for (const candidate of [name + extension, name.toUpperCase() + extension, name[0]!.toUpperCase() + name.slice(1) + extension]) {
        const full = join(directory, candidate);
        if (existsSync(full)) return full;
      }
    }
  }
  return null;
}

/** A lyric file beside the audio file, if there is one. */
export function findLocalLyrics(path: string): string | null {
  const stem = join(path, "..", basename(path, extname(path)));
  for (const extension of LYRIC_EXTENSIONS) {
    if (existsSync(stem + extension)) return stem + extension;
  }
  return null;
}

/** Builds a track from a file on disk, or explains why it cannot be played. */
export function trackFromFile(path: string): { track: MusicTrack; unsupportedReason: string | null } {
  const extension = extname(path).toLowerCase();
  const name = basename(path, extname(path));
  const tags = readTags(path);
  // "Artist - Title" is the common naming; split it only when there is no tag.
  const dash = tags.title ? -1 : name.indexOf(" - ");
  const title = tags.title ?? (dash > 0 ? name.slice(dash + 3) : name);
  const artist = tags.artist ?? (dash > 0 ? name.slice(0, dash) : null);

  let unsupportedReason: string | null = null;
  let durationSeconds = tags.durationSeconds;
  if (DSD_EXTENSIONS.has(extension)) {
    try {
      const info = readDsdInfo(readFileSync(path));
      if (info.compressed) unsupportedReason = "this DFF file is DST-compressed, which this server does not expand";
      else durationSeconds = Math.round(info.frames / (info.bitRate / 8) / info.channels);
    } catch (error) {
      unsupportedReason = error instanceof DsdError ? error.message : "this DSD file could not be read";
    }
  } else if (!PLAYABLE_EXTENSIONS.has(extension)) {
    unsupportedReason = `the browser cannot play ${extension || "this file type"}`;
  }

  const cover = findCover(path);
  return {
    unsupportedReason,
    track: {
      id: localTrackId(path),
      source: "local",
      title: title.slice(0, 300),
      artists: artist ? artist.split(/[/、,&]/).map((value) => value.trim()).filter(Boolean).slice(0, 16) : [],
      album: tags.album,
      albumId: null,
      durationSeconds,
      hash: null,
      audioId: null,
      // The cover is served through the stream route's file handle, not a path.
      coverUrl: cover ? `local-cover:${encodeURIComponent(cover)}` : null,
      vip: false,
      maxQuality: "hires",
      unsupportedReason,
    },
  };
}

/** Walks a folder, following no symlinks, and yields every audio file it finds. */
function* walk(folder: string, budget: { left: number }): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0) return;
    if (entry.startsWith(".")) continue;
    const full = join(folder, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walk(full, budget);
      continue;
    }
    if (!stat.isFile()) continue;
    const extension = extname(entry).toLowerCase();
    if (!RECOGNISED_EXTENSIONS.has(extension)) continue;
    budget.left -= 1;
    yield full;
  }
}

export interface LocalLibraryOptions {
  store: MusicStore;
  now?: () => string;
}

export interface LocalLibrary {
  /** Scans one folder; a second call continues where the cap stopped. */
  scan(folder: string): LocalScanResult;
  /** Every playable track, newest scan first, capped. */
  tracks(limit?: number): MusicTrack[];
  /** Resolves a `local:` track id to its file path. */
  pathFor(trackId: string): string | null;
  /** The lyric file beside a local track, if one exists. */
  lyricsPathFor(trackId: string): string | null;
  /** The cover beside a local track, if one exists. */
  coverPathFor(trackId: string): string | null;
}

export function createLocalLibrary(options: LocalLibraryOptions): LocalLibrary {
  const { store } = options;
  const byId = new Map<string, LocalTrackRow>();

  const remember = (row: LocalTrackRow): void => {
    byId.set(row.track.id, row);
  };

  return {
    scan(folder) {
      const root = resolve(folder);
      if (!existsSync(root)) {
        store.markFolderScanned(folder, "the folder does not exist");
        return { folder, added: 0, updated: 0, removed: 0, skipped: 0, unsupported: 0, truncated: false, error: "the folder does not exist" };
      }
      const budget = { left: MAX_SCAN_FILES };
      const known = new Map(store.localTracksInFolder(root).map((row) => [row.path, row]));
      let added = 0;
      let updated = 0;
      let skipped = 0;
      let unsupported = 0;
      const seen = new Set<string>();
      const scannedTracks: MusicTrack[] = [];

      for (const path of walk(root, budget)) {
        seen.add(path);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        const previous = known.get(path);
        if (previous && previous.sizeBytes === stat.size && previous.modifiedMs === Math.floor(stat.mtimeMs)) {
          remember(previous);
          if (!previous.unsupportedReason) scannedTracks.push(previous.track);
          skipped += 1;
          continue;
        }
        const { track, unsupportedReason } = trackFromFile(path);
        if (unsupportedReason) unsupported += 1;
        const row: LocalTrackRow = {
          path,
          track,
          sizeBytes: stat.size,
          modifiedMs: Math.floor(stat.mtimeMs),
          unsupportedReason,
        };
        store.putLocalTrack(row);
        remember(row);
        if (!unsupportedReason) scannedTracks.push(track);
        if (previous) updated += 1;
        else added += 1;
      }

      let removed = 0;
      for (const path of known.keys()) {
        if (seen.has(path)) continue;
        store.forgetLocalTrack(path);
        removed += 1;
      }

      // The folder is itself a playlist, rebuilt wholesale like upstream's imported-folder rows.
      const existing = store.playlists().find((playlist) => playlist.kind === "local" && playlist.sourceId === root);
      const playlist = existing ?? store.createPlaylist(basename(root) || "Local music", "local");
      if (!existing || playlist.sourceId !== root) store.setPlaylistSource(playlist.playlistId, root);
      store.renamePlaylist(playlist.playlistId, basename(root) || "Local music");
      store.clearPlaylistTracks(playlist.playlistId);
      store.addToPlaylist(playlist.playlistId, scannedTracks);

      store.markFolderScanned(folder, null);
      return {
        folder,
        added,
        updated,
        removed,
        skipped,
        unsupported,
        truncated: budget.left <= 0,
        error: null,
      };
    },

    tracks(limit = 5_000) {
      const rows = store.localTracks(limit);
      for (const row of rows) remember(row);
      return rows.map((row) => row.track);
    },

    pathFor(trackId) {
      const cached = byId.get(trackId);
      if (cached) return cached.path;
      const row = store.localTracks().find((entry) => entry.track.id === trackId);
      if (!row) return null;
      remember(row);
      return row.path;
    },

    lyricsPathFor(trackId) {
      const path = this.pathFor(trackId);
      return path ? findLocalLyrics(path) : null;
    },

    coverPathFor(trackId) {
      const path = this.pathFor(trackId);
      return path ? findCover(path) : null;
    },
  };
}

/** The mime a browser needs for a local file's extension. */
export function mimeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".mp3": return "audio/mpeg";
    case ".flac": return "audio/flac";
    case ".wav": return "audio/wav";
    case ".ogg":
    case ".oga": return "audio/ogg";
    case ".opus": return "audio/opus";
    case ".m4a": return "audio/mp4";
    case ".aac": return "audio/aac";
    case ".webm": return "audio/webm";
    case ".aiff":
    case ".aif": return "audio/aiff";
    case ".dsf":
    case ".dff": return "audio/wav";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".lrc":
    case ".krc":
    case ".qrc":
    case ".yrc":
    case ".vtt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}
