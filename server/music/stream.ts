// The one door audio comes through. A browser must not talk to Kugou's CDN
// directly (its CORS is not ours to control, its signed URLs expire, and the
// page should never hold a URL carrying an account token), so every source is
// proxied here under one handle namespace and served with byte ranges, which is
// what a seeking audio element needs. Source order and failure reasons follow
// upstream's PlaybackSourceResolver: a local file wins wherever one exists, an
// unauthenticated Kugou request is refused before it is made, and a dead CDN
// link is re-resolved once before the caller hears about it.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";

import type { MusicQuality, MusicTrack } from "../../shared/music.ts";
import { decodeDsdFile, DsdError } from "./dsd.ts";
import { mimeForPath } from "./local.ts";
import { KugouError } from "./kugou/transport.ts";

/** How long a resolved handle stays valid. A signed Kugou URL outlives it, and the client re-resolves. */
export const HANDLE_TTL_MS = 30 * 60_000;
/** How many resolved handles are remembered; older ones are dropped first. */
const MAX_HANDLES = 256;
const REMOTE_ATTEMPTS = 3;
const REMOTE_RETRY_BASE_MS = 300;
const REMOTE_READ_TIMEOUT_MS = 45_000;

export type HandleKind = "kugou" | "cloud" | "local" | "jellyfin" | "dsd" | "cover" | "lyrics";

/** What a handle points at. A remote URL is streamed through; a local path is read from disk. */
interface HandleEntry {
  kind: HandleKind;
  createdAt: number;
  /** For a remote stream. */
  url?: string;
  /** For a local file. */
  path?: string;
  /** The mime to send, decided when the handle was made. */
  mime: string;
  /** The track this handle plays, for the receipt the client sends back. */
  trackId?: string;
  /** Kept so a dead CDN link can be resolved again without the client asking. */
  track?: MusicTrack;
  quality?: MusicQuality;
}

export interface StreamRequest {
  method: string;
  range?: string;
}

export interface StreamResponse {
  status: number;
  headers: Record<string, string>;
  /** A body to write, or a stream for a large file. */
  body: Buffer | NodeJS.ReadableStream | null;
}

/** `bytes=0-1023`, `bytes=1024-`, `bytes=-1024`. Returns null when the header is not a single range. */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  if (!rawStart) {
    // A suffix range: the last N bytes.
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return "unsatisfiable";
    return { start: Math.max(size - length, 0), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return "unsatisfiable";
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  return { start, end };
}

export interface StreamDeps {
  /** Resolves a Kugou track to a fresh signed URL. */
  kugouUrl(track: MusicTrack, quality: MusicQuality): Promise<string>;
  /** Resolves one of the person's cloud-drive files. */
  cloudUrl?(track: MusicTrack): Promise<string>;
  /** The local file behind a track id, whichever source it came from. */
  localPath(trackId: string): string | null;
  /** A URL to proxy for a Jellyfin track. */
  jellyfinUrl(trackId: string): string | null;
  /** True when a Kugou or cloud track cannot even be asked for. */
  loginRequired?(): boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface MusicStream {
  /** Mints a handle for a track at a quality. The client names the handle, never a source URL. */
  handleFor(track: MusicTrack, quality: MusicQuality): Promise<{ handle: string; mime: string; expiresAt: string }>;
  /** Mints a handle for a local cover or lyric file, so the page never reads a path. */
  handleForFile(path: string, kind: "cover" | "lyrics"): { handle: string; mime: string };
  /** Serves one request against a handle, with ranges. */
  serve(handle: string, request: StreamRequest): Promise<StreamResponse>;
  /** Drops every handle for a track, so a quality change cannot keep serving the old stream. */
  forget(trackId: string): void;
  /** The track a handle plays, for a receipt that only names the handle. */
  trackFor(handle: string): string | null;
}

const REMOTE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createMusicStream(deps: StreamDeps): MusicStream {
  const fetcher = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const handles = new Map<string, HandleEntry>();
  /** A decoded DSD file is expensive; its WAV is kept until the handle expires. */
  const dsdCache = new Map<string, { wav: Buffer; at: number }>();

  const evict = (): void => {
    if (handles.size <= MAX_HANDLES) return;
    const oldest = [...handles.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [key] of oldest.slice(0, handles.size - MAX_HANDLES)) handles.delete(key);
  };

  const live = (handle: string): HandleEntry | null => {
    const entry = handles.get(handle);
    if (!entry) return null;
    if (now() - entry.createdAt > HANDLE_TTL_MS) {
      handles.delete(handle);
      return null;
    }
    return entry;
  };

  const mintRemote = (kind: HandleKind, url: string, mime: string, track: MusicTrack, quality: MusicQuality): { handle: string; mime: string; expiresAt: string } => {
    const handle = `${kind === "cloud" ? "cloud" : kind === "jellyfin" ? "jelly" : "kg"}_${randomUUID()}`;
    handles.set(handle, { kind, createdAt: now(), url, mime, trackId: track.id, track, quality });
    evict();
    return { handle, mime, expiresAt: new Date(now() + HANDLE_TTL_MS).toISOString() };
  };

  return {
    async handleFor(track, quality) {
      // A local file wins wherever one exists, whatever the track's source claims.
      const localPath = deps.localPath(track.id);
      if (localPath && existsSync(localPath)) {
        if (/\.(dsf|dff)$/i.test(extname(localPath))) {
          if (track.unsupportedReason) throw new KugouError("unsupported_format", track.unsupportedReason, false);
          const handle = `dsd_${randomUUID()}`;
          handles.set(handle, { kind: "dsd", createdAt: now(), path: localPath, mime: "audio/wav", trackId: track.id });
          evict();
          return { handle, mime: "audio/wav", expiresAt: new Date(now() + HANDLE_TTL_MS).toISOString() };
        }
        const mime = mimeForPath(localPath);
        if (!mime.startsWith("audio/")) throw new KugouError("unsupported_format", `the browser cannot play ${extname(localPath)}`, false);
        const handle = `local_${randomUUID()}`;
        handles.set(handle, { kind: "local", createdAt: now(), path: localPath, mime, trackId: track.id });
        evict();
        return { handle, mime, expiresAt: new Date(now() + HANDLE_TTL_MS).toISOString() };
      }
      if (track.source === "local") {
        throw new KugouError("not_found", "this local track is no longer on disk; rescan the library", false);
      }

      if (track.source === "jellyfin") {
        const url = deps.jellyfinUrl(track.id);
        if (!url) throw new KugouError("source_unavailable", "the Jellyfin source is not configured", false);
        return mintRemote("jellyfin", url, "audio/mpeg", track, quality);
      }

      // A Kugou or cloud request without a session is refused before it is made.
      if ((track.source === "kugou" || track.source === "cloud") && deps.loginRequired?.()) {
        throw new KugouError("not_logged_in", "sign in to Kugou to play this track", false);
      }

      if (track.source === "cloud") {
        if (!deps.cloudUrl) throw new KugouError("source_unavailable", "the cloud-drive source is unavailable", false);
        const url = await deps.cloudUrl(track);
        return mintRemote("cloud", url, "audio/mpeg", track, quality);
      }

      if (track.source !== "kugou") throw new KugouError("source_unavailable", `no stream source for "${track.source}"`, false);
      if (!track.hash) throw new KugouError("not_found", "this track has no Kugou file hash", false);
      const url = await deps.kugouUrl(track, quality);
      const mime = quality === "flac" || quality === "hires" ? "audio/flac" : "audio/mpeg";
      return mintRemote("kugou", url, mime, track, quality);
    },

    handleForFile(path, kind) {
      const mime = mimeForPath(path);
      const handle = `${kind}_${createHash("sha1").update(path).digest("hex").slice(0, 20)}`;
      handles.set(handle, { kind, createdAt: now(), path, mime });
      evict();
      return { handle, mime };
    },

    trackFor(handle) {
      return live(handle)?.trackId ?? null;
    },

    forget(trackId) {
      for (const [handle, entry] of handles) if (entry.trackId === trackId) handles.delete(handle);
    },

    async serve(handle, request) {
      const entry = live(handle);
      if (!entry) {
        // 410 tells a client this handle existed and died; re-resolve the track.
        return {
          status: 410,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ error: { code: "stream_expired", message: "this stream handle expired; ask for the track again" } })),
        };
      }

      if (entry.kind === "dsd") {
        const cached = dsdCache.get(handle);
        let wav: Buffer;
        if (cached) wav = cached.wav;
        else {
          if (!entry.path) return { status: 404, headers: {}, body: null };
          try {
            wav = decodeDsdFile(entry.path).wav;
          } catch (error) {
            const message = error instanceof DsdError ? error.message : "this DSD file could not be decoded";
            return { status: 415, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: { code: "unsupported_format", message } })) };
          }
          dsdCache.set(handle, { wav, at: now() });
        }
        return serveBuffer(wav, entry.mime, request);
      }

      if (entry.kind === "local" || entry.kind === "cover" || entry.kind === "lyrics") {
        if (!entry.path || !existsSync(entry.path)) return { status: 404, headers: {}, body: null };
        const size = statSync(entry.path).size;
        const range = parseByteRange(request.range, size);
        const headers: Record<string, string> = {
          "content-type": entry.mime,
          "accept-ranges": "bytes",
          "cache-control": entry.kind === "local" ? "private, no-store" : "private, max-age=300",
          "x-content-type-options": "nosniff",
        };
        if (range === "unsatisfiable") return { status: 416, headers: { ...headers, "content-range": `bytes */${size}` }, body: null };
        if (range) {
          return {
            status: 206,
            headers: { ...headers, "content-length": String(range.end - range.start + 1), "content-range": `bytes ${range.start}-${range.end}/${size}` },
            body: createReadStream(entry.path, { start: range.start, end: range.end }),
          };
        }
        return { status: 200, headers: { ...headers, "content-length": String(size) }, body: createReadStream(entry.path) };
      }

      // A remote stream: pass the range through and hand the bytes back unread,
      // so a seek is a range request upstream rather than a full download here.
      if (!entry.url) return { status: 404, headers: {}, body: null };
      let refreshed = false;
      let lastStatus = 0;
      for (let attempt = 0; attempt < REMOTE_ATTEMPTS; attempt++) {
        if (attempt > 0) await delay(REMOTE_RETRY_BASE_MS * attempt);
        let response: Response;
        try {
          response = await fetcher(entry.url, {
            headers: {
              ...(request.range ? { range: request.range } : {}),
              "user-agent": REMOTE_UA,
              referer: "https://www.kugou.com/",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(REMOTE_READ_TIMEOUT_MS),
          });
        } catch (error: unknown) {
          const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
          if (attempt < REMOTE_ATTEMPTS - 1) continue;
          throw new KugouError("unreachable", `the audio source is unreachable (${String(code ?? "network").slice(0, 40)})`, true);
        }
        if (response.ok || response.status === 206) {
          const headers: Record<string, string> = {
            "content-type": response.headers.get("content-type") ?? entry.mime,
            "accept-ranges": "bytes",
            "cache-control": "private, no-store",
          };
          for (const name of ["content-length", "content-range"]) {
            const value = response.headers.get(name);
            if (value) headers[name] = value;
          }
          if (!response.body) return { status: response.status, headers, body: null };
          // A body with no length is a live stream; it passes through untouched.
          return { status: response.status === 206 ? 206 : 200, headers, body: streamFromWeb(response.body) };
        }
        lastStatus = response.status;
        // A dead signed link is resolved once more before the caller is told.
        if ((response.status === 403 || response.status === 410) && entry.track && deps.kugouUrl && !refreshed) {
          if (entry.kind === "kugou" && entry.quality) {
            entry.url = await deps.kugouUrl(entry.track, entry.quality);
            refreshed = true;
            continue;
          }
        }
        if ((response.status >= 500 || response.status === 429) && attempt < REMOTE_ATTEMPTS - 1) continue;
        break;
      }
      const status = lastStatus === 403 ? 502 : lastStatus;
      return { status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: { code: "source_unavailable", message: `the audio source refused the stream (${lastStatus})` } })) };
    },
  };
}

function serveBuffer(buffer: Buffer, mime: string, request: StreamRequest): StreamResponse {
  const size = buffer.byteLength;
  const range = parseByteRange(request.range, size);
  const headers: Record<string, string> = { "content-type": mime, "accept-ranges": "bytes", "cache-control": "private, max-age=300" };
  if (range === "unsatisfiable") return { status: 416, headers: { ...headers, "content-range": `bytes */${size}` }, body: null };
  if (range) {
    return {
      status: 206,
      headers: { ...headers, "content-length": String(range.end - range.start + 1), "content-range": `bytes ${range.start}-${range.end}/${size}` },
      body: buffer.subarray(range.start, range.end + 1),
    };
  }
  return { status: 200, headers: { ...headers, "content-length": String(size) }, body: buffer };
}

/** Adapts a web ReadableStream to a Node readable, so a route can pipe it. */
function streamFromWeb(body: ReadableStream<Uint8Array>): NodeJS.ReadableStream {
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}
