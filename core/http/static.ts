import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

/** The policy the built workbench runs under. Astryx injects styles as inline
 * `<style>` elements, pictures arrive as same-origin files or object URLs, and
 * the event stream reconnects over a WebSocket. Vite's dev server never reaches
 * this module, so HMR's websocket and eval transform are unaffected. */
export const STATIC_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/** Every extension the workbench build emits. Anything else is sent as
 * `application/octet-stream` so a stray file cannot be executed by a browser. */
const MIME: ReadonlyMap<string, string> = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

const OCTET_STREAM = "application/octet-stream";

/** Vite ends a content-hashed name with `-` and a base64url digest. */
const HASHED_NAME = /-[A-Za-z0-9_-]{7,}$/u;

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const DRIVE_LETTER = /^[A-Za-z]:/u;

export interface StaticHandlerOptions {
  /** The directory the build wrote: `index.html`, `assets/`, and the files
   * copied out of `public/`. */
  readonly root: string;
  /** The page an extensionless GET falls back to. Defaults to `index.html`;
   * a multi-page build that makes another entry its product sets its name. */
  readonly entryFile?: string;
  /** Answer an extensionless GET with the entry file, so a client route survives
   * a reload. Defaults to true. */
  readonly spaFallback?: boolean;
}

/** `true` when this handler wrote the response, including its 400, 403 and 404
 * refusals. `false` when the request belongs to someone else: a method other
 * than GET or HEAD, or a path under `/api`. A composer runs its router on
 * `false`. */
export type StaticHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

interface LocatedFile {
  readonly path: string;
  readonly type: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface Target {
  readonly pathname: string;
  readonly segments: readonly string[];
  readonly extensionless: boolean;
}

class EscapedRootError extends Error {}

/** Serves one directory of build output.
 *
 * A path is decoded, normalised to NFC, and refused if it carries a control
 * byte, a backslash, a `..` or `.` segment, a trailing dot or space, a Windows
 * device name, or a drive letter. What survives is resolved through `realpath`
 * and must still sit under the root, so a symlink cannot walk out of the build
 * directory either. */
export function createStaticHandler(options: StaticHandlerOptions): StaticHandler {
  const root = resolve(options.root);
  const entryFile = options.entryFile ?? "index.html";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/u.test(entryFile)) {
    throw new Error(`the static entry must be one html file name, got ${JSON.stringify(entryFile)}`);
  }
  const spaFallback = options.spaFallback ?? true;
  let canonicalRoot: string | undefined;

  /** Resolved once and kept, so a build directory that appears after the
   * server started is still found on the next request. */
  async function resolveRoot(): Promise<string | undefined> {
    if (canonicalRoot !== undefined) return canonicalRoot;
    try {
      canonicalRoot = await realpath(root);
      return canonicalRoot;
    } catch {
      return undefined;
    }
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return false;

    const rawPath = pathnameOf(req.url);
    if (isApiPath(rawPath)) return false;

    const target = parseTarget(rawPath);
    if (target === undefined) {
      sendText(res, 400, "bad request");
      return true;
    }
    if (isApiPath(target.pathname)) return false;

    const headOnly = method === "HEAD";
    const segments = target.segments.length === 0 ? [entryFile] : target.segments;
    try {
      const resolvedRoot = await resolveRoot();
      const file = await locate(resolvedRoot, segments);
      if (file !== undefined) {
        await sendFile(req, res, file, target.pathname, headOnly);
        return true;
      }
      if (spaFallback && !headOnly && target.extensionless) {
        const index = await locate(resolvedRoot, [entryFile]);
        if (index !== undefined) {
          await sendFile(req, res, index, `/${entryFile}`, false);
          return true;
        }
      }
      sendText(res, 404, "not found");
      return true;
    } catch (error) {
      if (error instanceof EscapedRootError) sendText(res, 403, "forbidden");
      else if (!res.headersSent) sendText(res, 500, "this file could not be served");
      else res.destroy();
      return true;
    }
  }

  return serveStatic;
}

function pathnameOf(url: string | undefined): string {
  const raw = url ?? "/";
  const hash = raw.indexOf("#");
  const withoutHash = hash === -1 ? raw : raw.slice(0, hash);
  const query = withoutHash.indexOf("?");
  return query === -1 ? withoutHash : withoutHash.slice(0, query);
}

function isApiPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return lower === "/api" || lower.startsWith("/api/");
}

function parseTarget(pathname: string): Target | undefined {
  if (!pathname.startsWith("/")) return undefined;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const normalized = decoded.normalize("NFC");
  if (hasControlByte(normalized) || normalized.includes("\\")) return undefined;

  const trimmed = normalized.replace(/\/+$/u, "");
  const segments = trimmed === "" ? [] : trimmed.slice(1).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return undefined;
    if (segment.endsWith(".") || segment.endsWith(" ")) return undefined;
    if (WINDOWS_DEVICE.test(segment)) return undefined;
  }
  const first = segments[0];
  if (first !== undefined && DRIVE_LETTER.test(first)) return undefined;

  const last = segments[segments.length - 1];
  return {
    pathname: normalized,
    segments,
    extensionless: last === undefined || posix.extname(last) === "",
  };
}

function hasControlByte(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

async function locate(canonicalRoot: string | undefined, segments: readonly string[]): Promise<LocatedFile | undefined> {
  if (canonicalRoot === undefined) return undefined;
  let real: string;
  try {
    real = await realpath(join(canonicalRoot, ...segments));
  } catch {
    return undefined;
  }
  if (!isWithin(canonicalRoot, real)) throw new EscapedRootError();

  try {
    const stats = await stat(real);
    if (!stats.isFile()) return undefined;
    return { path: real, type: contentType(real), size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return undefined;
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(fold(root), fold(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const fold: (value: string) => string = process.platform === "win32" ? (value) => value.toLowerCase() : (value) => value;

function contentType(path: string): string {
  return MIME.get(extname(path).toLowerCase()) ?? OCTET_STREAM;
}

function cacheControl(pathname: string, type: string): string {
  if (type.startsWith("text/html")) return "no-cache";
  return isHashedAsset(pathname) ? "public, max-age=31536000, immutable" : "no-cache";
}

function isHashedAsset(pathname: string): boolean {
  if (!pathname.startsWith("/assets/")) return false;
  const name = posix.basename(pathname);
  const dot = name.lastIndexOf(".");
  return HASHED_NAME.test(dot === -1 ? name : name.slice(0, dot));
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: LocatedFile,
  pathname: string,
  headOnly: boolean,
): Promise<void> {
  applyStaticHeaders(res);
  const etag = `W/"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`;
  const lastModified = new Date(file.mtimeMs).toUTCString();
  const cache = cacheControl(pathname, file.type);

  if (isNotModified(req, etag, file.mtimeMs)) {
    res.writeHead(304, { etag, "last-modified": lastModified, "cache-control": cache });
    res.end();
    return;
  }

  res.writeHead(200, {
    "content-type": file.type,
    "content-length": String(file.size),
    "cache-control": cache,
    etag,
    "last-modified": lastModified,
  });
  if (headOnly) {
    res.end();
    return;
  }

  try {
    await pipeline(createReadStream(file.path), res);
  } catch {
    res.destroy();
  }
}

function isNotModified(req: IncomingMessage, etag: string, mtimeMs: number): boolean {
  const ifNoneMatch = header(req, "if-none-match");
  if (ifNoneMatch !== undefined) return matchesEtag(ifNoneMatch, etag);

  const ifModifiedSince = header(req, "if-modified-since");
  if (ifModifiedSince === undefined) return false;
  const since = Date.parse(ifModifiedSince);
  if (Number.isNaN(since)) return false;
  return Math.floor(mtimeMs / 1000) <= Math.floor(since / 1000);
}

function matchesEtag(headerValue: string, etag: string): boolean {
  const bare = etag.replace(/^W\//u, "");
  for (const candidate of headerValue.split(",")) {
    const value = candidate.trim();
    if (value === "*" || value.replace(/^W\//u, "") === bare) return true;
  }
  return false;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function applyStaticHeaders(res: ServerResponse): void {
  res.setHeader("content-security-policy", STATIC_CONTENT_SECURITY_POLICY);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
}

function sendText(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  applyStaticHeaders(res);
  const body = `${message}\n`;
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  res.end(body);
}
