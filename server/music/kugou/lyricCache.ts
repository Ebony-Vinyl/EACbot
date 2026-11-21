// The parsed-lyric cache: parsing a KRC body (and expanding its words) is pure
// work, so the result is kept on disk under a key that names exactly what was
// parsed. A hit skips the decode and the expansion; a miss or a corrupt entry is
// invisible to the caller. Bounds mirror upstream: 64 MiB and 8 192 files,
// evicted oldest-first, with a sweep that never runs more often than 30 s.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LyricWord } from "../../../shared/music.ts";

export const LYRIC_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const LYRIC_CACHE_MAX_FILES = 8_192;
const LYRIC_CACHE_SWEEP_EVERY_WRITES = 64;
const LYRIC_CACHE_SWEEP_MIN_GAP_MS = 30_000;
const LYRIC_CACHE_SWEEP_MAX_GAP_MS = 600_000;

export interface LyricCacheLine {
  text: string;
  translation: string | null;
  romanization: string | null;
  atMs: number;
  durationMs: number;
  words: LyricWord[];
}

/** The online identity: one candidate id plus its access key and format. */
export function onlineLyricIdentity(id: string, accesskey: string, extension: string): string {
  return `1|online|${id}|${accesskey}|.${extension.replace(/^\./, "")}`;
}

/** The local-file identity: path, size and mtime, so an edit invalidates the entry. */
export function fileLyricIdentity(path: string, sizeBytes: number, mtimeMs: number, extension: string): string {
  return `1|local-file|${path}|${sizeBytes}|${Math.round(mtimeMs)}|.${extension.replace(/^\./, "")}|`;
}

/** The embedded-lyrics identity: the file plus a digest of the tag text itself. */
export function embeddedLyricIdentity(path: string, sizeBytes: number, mtimeMs: number, extension: string, content: string): string {
  const digest = createHash("sha256").update(content).digest("hex");
  return `1|embedded|${path}|${sizeBytes}|${Math.round(mtimeMs)}|.${extension.replace(/^\./, "")}|${digest}`;
}

interface StoredEntry {
  schemaVersion: number;
  identity: string;
  lines: readonly LyricCacheLine[];
}

const SCHEMA_VERSION = 1;

export function createLyricParseCache(dataDir: string) {
  const dir = join(dataDir, "lyric-parse-cache");
  let writesSinceSweep = 0;
  let bytesSinceSweep = 0;
  let lastSweepAt = 0;

  const fileFor = (identity: string): string => join(dir, `${createHash("sha256").update(identity).digest("hex")}.json`);

  const sweep = (force = false): void => {
    const now = Date.now();
    if (!force) {
      if (now - lastSweepAt < LYRIC_CACHE_SWEEP_MIN_GAP_MS) return;
      const dueAge = now - lastSweepAt > LYRIC_CACHE_SWEEP_MAX_GAP_MS;
      if (!dueAge && writesSinceSweep < LYRIC_CACHE_SWEEP_EVERY_WRITES && bytesSinceSweep < 16 * 1024 * 1024) return;
    }
    lastSweepAt = now;
    writesSinceSweep = 0;
    bytesSinceSweep = 0;
    if (!existsSync(dir)) return;
    let entries: Array<{ file: string; size: number; mtime: number }> = [];
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const file = join(dir, name);
        const stats = statSync(file);
        entries.push({ file, size: stats.size, mtime: stats.mtimeMs });
      }
    } catch {
      return;
    }
    if (entries.length <= LYRIC_CACHE_MAX_FILES && entries.reduce((sum, entry) => sum + entry.size, 0) <= LYRIC_CACHE_MAX_BYTES) return;
    entries = entries.sort((a, b) => a.mtime - b.mtime);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= LYRIC_CACHE_MAX_BYTES && entries.length <= LYRIC_CACHE_MAX_FILES) break;
      try {
        unlinkSync(entry.file);
        total -= entry.size;
        entries = entries.filter((candidate) => candidate.file !== entry.file);
      } catch {
        // An entry that will not unlink is retried by the next sweep.
      }
    }
  };

  return {
    /** The parsed lines for this identity, or null when the cache has nothing usable. */
    read(identity: string): LyricCacheLine[] | null {
      try {
        const file = fileFor(identity);
        if (!existsSync(file)) return null;
        const entry = JSON.parse(readFileSync(file, "utf8")) as StoredEntry;
        if (entry.schemaVersion !== SCHEMA_VERSION || entry.identity !== identity || !entry.lines?.length) return null;
        try {
          const stats = statSync(file);
          // A touch marks the entry recently used, so the sweep keeps hot rows.
          utimesSync(file, new Date(), stats.mtime);
        } catch { /* an untouchable entry just ages out normally */ }
        return [...entry.lines];
      } catch {
        return null;
      }
    },

    /** Stores parsed lines; an empty result is never cached, and every failure is silent. */
    write(identity: string, lines: readonly LyricCacheLine[]): void {
      if (!lines.length) return;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = fileFor(identity);
        const payload = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, identity, lines } satisfies StoredEntry)}\n`;
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, payload, { mode: 0o600 });
        renameSync(tmp, file);
        writesSinceSweep += 1;
        bytesSinceSweep += Buffer.byteLength(payload);
        sweep();
      } catch {
        // The cache is rebuildable; a failed write costs only the next parse.
      }
    },

    /** Runs the eviction pass now; exposed for tests. */
    sweep(): void {
      sweep(true);
    },
  };
}
