// The bounded disk cache behind `/api/music/image`: the page asks this server for
// a cover, the server keeps a copy on disk so a restart does not re-download a
// wall of artwork. Bounds mirror upstream's image loader — 256 MiB on disk with
// a 7-day age, a small LRU in memory, and one concurrent fetch per URL.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DISK_MAX_BYTES = 256 * 1024 * 1024;
const DISK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DISK_LOW_WATER = Math.round(DISK_MAX_BYTES * 0.9);
const MEMORY_MAX_BYTES = 32 * 1024 * 1024;
const MEMORY_MAX_ENTRIES = 200;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

export interface ImageCacheOptions {
  dataDir: string;
  /** A request is refused unless its host is on this list (Kugou's art hosts + the Jellyfin server). */
  allowedHosts(): readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
}

export interface CachedImage {
  body: Buffer;
  mime: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function extensionFor(mime: string): string {
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  return ".jpg";
}

export function createImageCache(options: ImageCacheOptions) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const dir = join(options.dataDir, "image-cache");
  const memory = new Map<string, { body: Buffer; mime: string; at: number; bytes: number }>();
  let memoryBytes = 0;
  const pending = new Map<string, Promise<CachedImage | null>>();

  const remember = (key: string, image: CachedImage): void => {
    memory.set(key, { ...image, at: now(), bytes: image.body.byteLength });
    memoryBytes += image.body.byteLength;
    while (memory.size > MEMORY_MAX_ENTRIES || memoryBytes > MEMORY_MAX_BYTES) {
      const oldest = [...memory.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      memory.delete(oldest[0]);
      memoryBytes -= oldest[1].bytes;
    }
  };

  const sweepDisk = (): void => {
    if (!existsSync(dir)) return;
    let entries: Array<{ file: string; size: number; mtime: number }> = [];
    try {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        const stats = statSync(file);
        if (now() - stats.mtimeMs > DISK_MAX_AGE_MS) {
          unlinkSync(file);
          continue;
        }
        entries.push({ file, size: stats.size, mtime: stats.mtimeMs });
      }
    } catch {
      return;
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= DISK_MAX_BYTES) return;
    entries = entries.sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      if (total <= DISK_LOW_WATER) break;
      try {
        unlinkSync(entry.file);
        total -= entry.size;
      } catch {
        // A busy file is retried by the next sweep.
      }
    }
  };

  const fetchAndStore = async (url: string, key: string): Promise<CachedImage | null> => {
    try {
      const response = await fetcher(url, {
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
      if (!mime.startsWith("image/")) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_FETCH_BYTES) return null;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = join(dir, key + extensionFor(mime));
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, bytes, { mode: 0o600 });
        renameSync(tmp, file);
        sweepDisk();
      } catch {
        // A read-only data directory loses its cache, not its covers.
      }
      const image = { body: bytes, mime };
      remember(key, image);
      return image;
    } catch {
      return null;
    }
  };

  return {
    /** The cached image, from memory, disk, or the network in that order. */
    async get(url: string): Promise<CachedImage | null> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      const allowed = options.allowedHosts();
      if (!allowed.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) return null;

      const key = createHash("sha256").update(url).digest("hex");
      const inMemory = memory.get(key);
      if (inMemory) {
        inMemory.at = now();
        return { body: inMemory.body, mime: inMemory.mime };
      }
      for (const extension of Object.keys(MIME_BY_EXTENSION)) {
        const file = join(dir, key + extension);
        if (existsSync(file)) {
          try {
            const image = { body: readFileSync(file), mime: MIME_BY_EXTENSION[extension]! };
            remember(key, image);
            return image;
          } catch {
            break;
          }
        }
      }
      const inFlight = pending.get(key) ?? fetchAndStore(url, key);
      pending.set(key, inFlight);
      try {
        return await inFlight;
      } finally {
        pending.delete(key);
      }
    },
  };
}
