// The music library's durable half: playlists this server owns, favourites, the
// play history, the person's stated preferences, and the local-file index. The
// player's live state is in player.ts; nothing here knows about HTTP or Kugou.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  MusicPlaylist,
  MusicPlaylistKind,
  MusicTrack,
  MusicQuality,
} from "../../shared/music.ts";

const DB_FILE = "music.db";
/** A queue, playlist or history read never returns more than this, so one call cannot flood a client. */
export const MUSIC_MAX_ROWS = 5_000;

export type MusicStoreErrorCode = "invalid_input" | "unknown_playlist" | "unknown_track" | "store_failure" | "queue_full";

export class MusicStoreError extends Error {
  readonly code: MusicStoreErrorCode;
  constructor(code: MusicStoreErrorCode, message: string) {
    super(message);
    this.name = "MusicStoreError";
    this.code = code;
  }
}

/** One row of the local-file index. `path` is absolute and unique. */
export interface LocalTrackRow {
  path: string;
  track: MusicTrack;
  /** File size and mtime, so a rescan can skip an unchanged file. */
  sizeBytes: number;
  modifiedMs: number;
  /** Set when the file could not be decoded (a DSF the decoder rejected). */
  unsupportedReason: string | null;
}

/** A preference the person stated, with where it came from. */
export interface MusicPreference {
  key: string;
  value: string;
  /** `stated` is the person's own words; `observed` is a counted behaviour and is never read back as a rule. */
  kind: "stated" | "observed";
  scope: "global" | "bot";
  botId: string | null;
  updatedAt: string;
}

export interface MusicHistoryEntry {
  track: MusicTrack;
  at: string;
  /** Seconds actually played, as the client reported. */
  playedSeconds: number;
  /** How the track started: the person, a bot, or a radio. */
  by: "person" | "bot" | "radio";
}

export interface MusicStoreOptions {
  dataDir: string;
  now?: () => string;
}

function trackJson(track: MusicTrack): string {
  return JSON.stringify(track);
}

function trackFromJson(value: unknown): MusicTrack | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && typeof (parsed as MusicTrack).id === "string" ? parsed as MusicTrack : null;
  } catch {
    return null;
  }
}

export class MusicStore {
  private db: DatabaseSync | null = null;
  private readonly statements = new Map<string, StatementSync>();
  private readonly file: string;
  private readonly now: () => string;

  constructor(options: MusicStoreOptions) {
    this.file = join(options.dataDir, DB_FILE);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    closeSync(openSync(this.file, "a", 0o600));
    try {
      chmodSync(this.file, 0o600);
    } catch { /* a filesystem without modes is fine */ }
    const db = new DatabaseSync(this.file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS music_playlists (
        playlist_id TEXT NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_id TEXT,
        cover_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS music_playlist_tracks (
        playlist_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        track_id TEXT NOT NULL,
        track_json TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (playlist_id, position)
      );
      CREATE INDEX IF NOT EXISTS music_playlist_tracks_id ON music_playlist_tracks(playlist_id, track_id);
      CREATE TABLE IF NOT EXISTS music_favorites (
        track_id TEXT NOT NULL PRIMARY KEY,
        track_json TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS music_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT NOT NULL,
        track_json TEXT NOT NULL,
        at TEXT NOT NULL,
        played_seconds REAL NOT NULL DEFAULT 0,
        by TEXT NOT NULL,
        user_key TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS music_history_at ON music_history(at DESC);
      CREATE INDEX IF NOT EXISTS music_history_user ON music_history(user_key, at DESC);
    `);
    // A database created before the history had a user scope gains the column here.
    try {
      db.exec("SELECT user_key FROM music_history LIMIT 1");
    } catch {
      db.exec("ALTER TABLE music_history ADD COLUMN user_key TEXT NOT NULL DEFAULT ''");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS music_preferences (
        key TEXT NOT NULL,
        scope TEXT NOT NULL,
        bot_id TEXT NOT NULL DEFAULT '',
        value TEXT NOT NULL,
        kind TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (key, scope, bot_id)
      );
      CREATE TABLE IF NOT EXISTS music_local_tracks (
        path TEXT NOT NULL PRIMARY KEY,
        track_id TEXT NOT NULL,
        track_json TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        modified_ms INTEGER NOT NULL,
        unsupported_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS music_local_tracks_id ON music_local_tracks(track_id);
      CREATE TABLE IF NOT EXISTS music_library_folders (
        path TEXT NOT NULL PRIMARY KEY,
        scanned_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS music_settings (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.db = db;
    return db;
  }

  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.open().prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  close(): void {
    this.statements.clear();
    // Windows keeps the WAL locked until it is checkpointed, so a test's rmSync would EPERM.
    try {
      this.db?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Closing twice, or closing an already-dead database, is fine.
    }
    this.db?.close();
    this.db = null;
  }

  // ---- playlists ----

  /** Every playlist this server owns. A remote playlist is not stored here. */
  playlists(): MusicPlaylist[] {
    const rows = this.prepare("SELECT playlist_id, name, kind, source_id, cover_url, created_at FROM music_playlists ORDER BY created_at").all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const playlistId = String(row.playlist_id);
      const count = this.prepare("SELECT COUNT(*) AS n FROM music_playlist_tracks WHERE playlist_id = ?").get(playlistId) as { n?: number } | undefined;
      return {
        playlistId,
        name: String(row.name),
        kind: String(row.kind) as MusicPlaylistKind,
        sourceId: row.source_id === null || row.source_id === undefined ? null : String(row.source_id),
        coverUrl: row.cover_url === null || row.cover_url === undefined ? null : String(row.cover_url),
        trackCount: Number(count?.n ?? 0),
        local: true,
        createdAt: String(row.created_at),
      };
    });
  }

  playlist(playlistId: string): MusicPlaylist | null {
    const row = this.prepare("SELECT playlist_id, name, kind, source_id, cover_url, created_at FROM music_playlists WHERE playlist_id = ?").get(playlistId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const count = this.prepare("SELECT COUNT(*) AS n FROM music_playlist_tracks WHERE playlist_id = ?").get(playlistId) as { n?: number } | undefined;
    return {
      playlistId: String(row.playlist_id),
      name: String(row.name),
      kind: String(row.kind) as MusicPlaylistKind,
      sourceId: row.source_id === null || row.source_id === undefined ? null : String(row.source_id),
      coverUrl: row.cover_url === null || row.cover_url === undefined ? null : String(row.cover_url),
      trackCount: Number(count?.n ?? 0),
      local: true,
      createdAt: String(row.created_at),
    };
  }

  createPlaylist(name: string, kind: MusicPlaylistKind = "local"): MusicPlaylist {
    const trimmed = name.trim();
    if (!trimmed) throw new MusicStoreError("invalid_input", "a playlist needs a name");
    const playlistId = `local:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const at = this.now();
    this.prepare("INSERT INTO music_playlists (playlist_id, name, kind, source_id, cover_url, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)")
      .run(playlistId, trimmed.slice(0, 200), kind, at, at);
    return { playlistId, name: trimmed.slice(0, 200), kind, sourceId: null, coverUrl: null, trackCount: 0, local: true, createdAt: at };
  }

  renamePlaylist(playlistId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) throw new MusicStoreError("invalid_input", "a playlist needs a name");
    const result = this.prepare("UPDATE music_playlists SET name = ?, updated_at = ? WHERE playlist_id = ?").run(trimmed.slice(0, 200), this.now(), playlistId);
    if (!Number(result.changes)) throw new MusicStoreError("unknown_playlist", `no playlist "${playlistId.slice(0, 80)}"`);
  }

  deletePlaylist(playlistId: string): void {
    const result = this.prepare("DELETE FROM music_playlists WHERE playlist_id = ?").run(playlistId);
    if (!Number(result.changes)) throw new MusicStoreError("unknown_playlist", `no playlist "${playlistId.slice(0, 80)}"`);
    this.prepare("DELETE FROM music_playlist_tracks WHERE playlist_id = ?").run(playlistId);
  }

  /** Points a playlist at the source it was imported from, so a refresh finds it again. */
  setPlaylistSource(playlistId: string, sourceId: string): void {
    this.prepare("UPDATE music_playlists SET source_id = ?, updated_at = ? WHERE playlist_id = ?").run(sourceId.slice(0, 200), this.now(), playlistId);
  }

  /** Empties a playlist's rows, ready for a wholesale rebuild. */
  clearPlaylistTracks(playlistId: string): void {
    this.prepare("DELETE FROM music_playlist_tracks WHERE playlist_id = ?").run(playlistId);
  }

  playlistTracks(playlistId: string, limit = MUSIC_MAX_ROWS): MusicTrack[] {
    const rows = this.prepare("SELECT track_json FROM music_playlist_tracks WHERE playlist_id = ? ORDER BY position LIMIT ?").all(playlistId, limit) as Array<{ track_json: string }>;
    return rows.map((row) => trackFromJson(row.track_json)).filter((track): track is MusicTrack => track !== null);
  }

  addToPlaylist(playlistId: string, tracks: readonly MusicTrack[]): number {
    if (!this.playlist(playlistId)) throw new MusicStoreError("unknown_playlist", `no playlist "${playlistId.slice(0, 80)}"`);
    const at = this.now();
    let added = 0;
    for (const track of tracks) {
      const existing = this.prepare("SELECT 1 AS hit FROM music_playlist_tracks WHERE playlist_id = ? AND track_id = ? LIMIT 1").get(playlistId, track.id);
      if (existing) continue;
      const next = this.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM music_playlist_tracks WHERE playlist_id = ?").get(playlistId) as { pos?: number } | undefined;
      this.prepare("INSERT INTO music_playlist_tracks (playlist_id, position, track_id, track_json, added_at) VALUES (?, ?, ?, ?, ?)")
        .run(playlistId, Number(next?.pos ?? 0), track.id, trackJson(track), at);
      added += 1;
    }
    if (added) this.prepare("UPDATE music_playlists SET updated_at = ? WHERE playlist_id = ?").run(at, playlistId);
    return added;
  }

  removeFromPlaylist(playlistId: string, trackIds: readonly string[]): number {
    const wanted = new Set(trackIds);
    if (!wanted.size) return 0;
    const rows = this.prepare("SELECT position, track_id FROM music_playlist_tracks WHERE playlist_id = ? ORDER BY position").all(playlistId) as Array<{ position: number; track_id: string }>;
    let removed = 0;
    for (const row of rows) {
      if (!wanted.has(row.track_id)) continue;
      this.prepare("DELETE FROM music_playlist_tracks WHERE playlist_id = ? AND position = ?").run(playlistId, row.position);
      removed += 1;
    }
    if (removed) {
      // Positions stay dense, so a later insert lands at the end rather than after a hole.
      const left = this.prepare("SELECT position, track_id, track_json, added_at FROM music_playlist_tracks WHERE playlist_id = ? ORDER BY position").all(playlistId) as Array<{ position: number; track_id: string; track_json: string; added_at: string }>;
      this.prepare("DELETE FROM music_playlist_tracks WHERE playlist_id = ?").run(playlistId);
      left.forEach((row, index) => {
        this.prepare("INSERT INTO music_playlist_tracks (playlist_id, position, track_id, track_json, added_at) VALUES (?, ?, ?, ?, ?)")
          .run(playlistId, index, row.track_id, row.track_json, row.added_at);
      });
      this.prepare("UPDATE music_playlists SET updated_at = ? WHERE playlist_id = ?").run(this.now(), playlistId);
    }
    return removed;
  }

  // ---- favourites ----

  favorites(): MusicTrack[] {
    const rows = this.prepare("SELECT track_json FROM music_favorites ORDER BY added_at DESC LIMIT ?").all(MUSIC_MAX_ROWS) as Array<{ track_json: string }>;
    return rows.map((row) => trackFromJson(row.track_json)).filter((track): track is MusicTrack => track !== null);
  }

  isFavorite(trackId: string): boolean {
    return Boolean(this.prepare("SELECT 1 AS hit FROM music_favorites WHERE track_id = ? LIMIT 1").get(trackId));
  }

  setFavorite(track: MusicTrack, favorite: boolean): void {
    if (favorite) this.prepare("INSERT OR REPLACE INTO music_favorites (track_id, track_json, added_at) VALUES (?, ?, ?)").run(track.id, trackJson(track), this.now());
    else this.prepare("DELETE FROM music_favorites WHERE track_id = ?").run(track.id);
  }

  // ---- history ----

  recordPlay(track: MusicTrack, playedSeconds: number, by: MusicHistoryEntry["by"], userKey = ""): void {
    // The same song returns to the top instead of stacking, and the list stays short.
    this.prepare("DELETE FROM music_history WHERE user_key = ? AND track_id = ?").run(userKey, track.id);
    this.prepare("INSERT INTO music_history (track_id, track_json, at, played_seconds, by, user_key) VALUES (?, ?, ?, ?, ?, ?)")
      .run(track.id, trackJson(track), this.now(), Math.max(0, playedSeconds), by, userKey);
    this.prepare("DELETE FROM music_history WHERE user_key = ? AND id NOT IN (SELECT id FROM music_history WHERE user_key = ? ORDER BY id DESC LIMIT 100)").run(userKey, userKey);
  }

  history(limit = 100): MusicHistoryEntry[] {
    const rows = this.prepare("SELECT track_json, at, played_seconds, by FROM music_history ORDER BY id DESC LIMIT ?").all(Math.min(Math.max(limit, 1), MUSIC_MAX_ROWS)) as Array<Record<string, unknown>>;
    const entries: MusicHistoryEntry[] = [];
    for (const row of rows) {
      const track = trackFromJson(row.track_json);
      if (!track) continue;
      entries.push({
        track,
        at: String(row.at),
        playedSeconds: Number(row.played_seconds ?? 0),
        by: String(row.by) as MusicHistoryEntry["by"],
      });
    }
    return entries;
  }

  clearHistory(): void {
    this.prepare("DELETE FROM music_history").run();
  }

  // ---- preferences ----

  preferences(scope: { scope: "global" | "bot"; botId?: string | null }): MusicPreference[] {
    const botId = scope.scope === "bot" ? scope.botId ?? "" : "";
    const rows = this.prepare("SELECT key, value, kind, scope, bot_id, updated_at FROM music_preferences WHERE scope = ? AND bot_id = ? ORDER BY key")
      .all(scope.scope, botId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      key: String(row.key),
      value: String(row.value),
      kind: String(row.kind) as MusicPreference["kind"],
      scope: String(row.scope) as MusicPreference["scope"],
      botId: String(row.bot_id) || null,
      updatedAt: String(row.updated_at),
    }));
  }

  setPreference(input: { key: string; value: string; kind: MusicPreference["kind"]; scope: "global" | "bot"; botId?: string | null }): MusicPreference {
    const key = input.key.trim();
    if (!key) throw new MusicStoreError("invalid_input", "a preference needs a key");
    const botId = input.scope === "bot" ? input.botId ?? "" : "";
    const at = this.now();
    this.prepare("INSERT OR REPLACE INTO music_preferences (key, scope, bot_id, value, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key.slice(0, 80), input.scope, botId, input.value.slice(0, 2_000), input.kind, at);
    return { key: key.slice(0, 80), value: input.value.slice(0, 2_000), kind: input.kind, scope: input.scope, botId: botId || null, updatedAt: at };
  }

  deletePreference(input: { key: string; scope: "global" | "bot"; botId?: string | null }): boolean {
    const botId = input.scope === "bot" ? input.botId ?? "" : "";
    const result = this.prepare("DELETE FROM music_preferences WHERE key = ? AND scope = ? AND bot_id = ?").run(input.key, input.scope, botId);
    return Number(result.changes) > 0;
  }

  // ---- local library ----

  localFolders(): Array<{ path: string; scannedAt: string | null; error: string | null }> {
    const rows = this.prepare("SELECT path, scanned_at, error FROM music_library_folders ORDER BY path").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      path: String(row.path),
      scannedAt: row.scanned_at === null || row.scanned_at === undefined ? null : String(row.scanned_at),
      error: row.error === null || row.error === undefined ? null : String(row.error),
    }));
  }

  addLocalFolder(path: string): void {
    this.prepare("INSERT OR IGNORE INTO music_library_folders (path, scanned_at, error) VALUES (?, NULL, NULL)").run(path);
  }

  removeLocalFolder(path: string): void {
    this.prepare("DELETE FROM music_library_folders WHERE path = ?").run(path);
    this.prepare("DELETE FROM music_local_tracks WHERE path LIKE ?").run(`${path.replace(/[\\/]$/, "")}%`);
  }

  markFolderScanned(path: string, error: string | null): void {
    this.prepare("UPDATE music_library_folders SET scanned_at = ?, error = ? WHERE path = ?").run(this.now(), error, path);
  }

  /** The stored rows for one folder, so a rescan can skip an unchanged file. */
  localTracksInFolder(folder: string, limit = MUSIC_MAX_ROWS): LocalTrackRow[] {
    const rows = this.prepare("SELECT path, track_json, size_bytes, modified_ms, unsupported_reason FROM music_local_tracks WHERE path LIKE ? LIMIT ?")
      .all(`${folder.replace(/[\\/]$/, "")}%`, limit) as Array<Record<string, unknown>>;
    const tracks: LocalTrackRow[] = [];
    for (const row of rows) {
      const track = trackFromJson(row.track_json);
      if (!track) continue;
      tracks.push({
        path: String(row.path),
        track,
        sizeBytes: Number(row.size_bytes ?? 0),
        modifiedMs: Number(row.modified_ms ?? 0),
        unsupportedReason: row.unsupported_reason === null || row.unsupported_reason === undefined ? null : String(row.unsupported_reason),
      });
    }
    return tracks;
  }

  putLocalTrack(row: LocalTrackRow): void {
    this.prepare("INSERT OR REPLACE INTO music_local_tracks (path, track_id, track_json, size_bytes, modified_ms, unsupported_reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.path, row.track.id, trackJson(row.track), row.sizeBytes, row.modifiedMs, row.unsupportedReason);
  }

  forgetLocalTrack(path: string): void {
    this.prepare("DELETE FROM music_local_tracks WHERE path = ?").run(path);
  }

  localTracks(limit = MUSIC_MAX_ROWS): LocalTrackRow[] {
    const rows = this.prepare("SELECT path, track_json, size_bytes, modified_ms, unsupported_reason FROM music_local_tracks ORDER BY path LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    const tracks: LocalTrackRow[] = [];
    for (const row of rows) {
      const track = trackFromJson(row.track_json);
      if (!track) continue;
      tracks.push({
        path: String(row.path),
        track,
        sizeBytes: Number(row.size_bytes ?? 0),
        modifiedMs: Number(row.modified_ms ?? 0),
        unsupportedReason: row.unsupported_reason === null || row.unsupported_reason === undefined ? null : String(row.unsupported_reason),
      });
    }
    return tracks;
  }

  localTrackByPath(path: string): LocalTrackRow | null {
    const row = this.prepare("SELECT path, track_json, size_bytes, modified_ms, unsupported_reason FROM music_local_tracks WHERE path = ?").get(path) as Record<string, unknown> | undefined;
    if (!row) return null;
    const track = trackFromJson(row.track_json);
    if (!track) return null;
    return {
      path: String(row.path),
      track,
      sizeBytes: Number(row.size_bytes ?? 0),
      modifiedMs: Number(row.modified_ms ?? 0),
      unsupportedReason: row.unsupported_reason === null || row.unsupported_reason === undefined ? null : String(row.unsupported_reason),
    };
  }

  localTrackCount(): number {
    const row = this.prepare("SELECT COUNT(*) AS n FROM music_local_tracks").get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  // ---- small settings (quality, eq, theme) ----

  setting(key: string): string | null {
    const row = this.prepare("SELECT value FROM music_settings WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  putSetting(key: string, value: string): void {
    this.prepare("INSERT OR REPLACE INTO music_settings (key, value) VALUES (?, ?)").run(key, value);
  }

  /** The default quality the player asks for when nothing else says. */
  quality(): MusicQuality {
    const stored = this.setting("quality");
    return stored === "128k" || stored === "320k" || stored === "flac" || stored === "hires" ? stored : "320k";
  }
}
