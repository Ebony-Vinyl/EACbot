import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as tar from "tar";

export type ArtifactErrorCode = "not-https" | "http" | "too-large" | "digest" | "archive" | "extract";

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;
  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DownloadArtifactOptions {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  maxBytes?: number;
  maxEntries?: number;
  maxExpandedBytes?: number;
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_EXPANDED = 500 * 1024 * 1024;

/** Tar paths are POSIX; reject absolute, parent and Windows-separator forms before extraction. */
export function validateArchivePath(path: string): boolean {
  if (!path || path.length > 240 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function topLevel(path: string): string | null {
  const first = path.split("/")[0];
  return first && path.includes("/") ? first : null;
}

/**
 * Downloads one artifact, verifies its digest, validates the archive, and extracts one top-level directory into
 * `packageDir`. It never runs package scripts and removes partial output on failure.
 */
export async function downloadPluginArtifact(
  urlText: string,
  expectedSha256: string,
  packageDir: string,
  options: DownloadArtifactOptions = {},
): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new ArtifactError("not-https", "the artifact URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ArtifactError("not-https", "artifacts must use a plain https URL");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new ArtifactError("http", "the artifact could not be reached");
  }
  if (!response.ok) throw new ArtifactError("http", `the artifact answered HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ArtifactError("too-large", "the artifact is too large");
  if (!response.body) throw new ArtifactError("http", "the artifact returned an empty response");

  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ArtifactError("too-large", "the artifact is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError("http", "the artifact response could not be read");
  }
  const digest = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
  if (digest !== expectedSha256) throw new ArtifactError("digest", "the artifact digest does not match the catalog");

  const downloadDir = join(packageDir, "..", `download-${randomUUID()}`);
  mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
  const archive = join(downloadDir, "artifact.tgz");
  writeFileSync(archive, Buffer.concat(chunks), { mode: 0o600 });
  try {
    mkdirSync(packageDir, { recursive: true, mode: 0o700 });
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxExpanded = options.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED;
    let entries = 0;
    let expanded = 0;
    let root: string | null = null;
    await tar.t({
      file: archive,
      strict: true,
      onentry: (entry) => {
        entries += 1;
        if (entries > maxEntries) throw new ArtifactError("archive", "the artifact has too many entries");
        if (!validateArchivePath(entry.path)) throw new ArtifactError("archive", `unsafe archive path: ${entry.path}`);
        if (entry.type !== "File" && entry.type !== "Directory") throw new ArtifactError("archive", `unsupported archive entry: ${entry.type}`);
        const top = topLevel(entry.path);
        if (!top) throw new ArtifactError("archive", "the artifact must have one top-level directory");
        if (root === null) root = top;
        else if (root !== top) throw new ArtifactError("archive", "the artifact has more than one top-level directory");
        if (entry.type === "File") {
          expanded += entry.size;
          if (expanded > maxExpanded) throw new ArtifactError("archive", "the artifact expands beyond the size limit");
        }
      },
    });
    if (entries === 0) throw new ArtifactError("archive", "the artifact is empty");
    await tar.x({
      file: archive,
      cwd: packageDir,
      strip: 1,
      strict: true,
      preservePaths: false,
      filter: (path) => validateArchivePath(path),
    });
  } catch (error) {
    rmSync(packageDir, { recursive: true, force: true });
    throw error instanceof ArtifactError ? error : new ArtifactError("extract", "the artifact could not be extracted");
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}
