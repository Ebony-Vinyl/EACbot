import { verifyCatalog, type CatalogKey, type CatalogVerification } from "./catalog.ts";

export type CatalogFetchCode = "not-https" | "http" | "content-type" | "too-large" | "invalid-json";
export type CatalogFetchResult = CatalogVerification | { ok: false; code: CatalogFetchCode; error: string };

export interface FetchCatalogOptions {
  keys: Readonly<Record<string, CatalogKey>>;
  now: Date;
  minimumSequence?: number;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  maxBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchCatalog(urlText: string, options: FetchCatalogOptions): Promise<CatalogFetchResult> {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return { ok: false, code: "not-https", error: "the channel URL is invalid" };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    return { ok: false, code: "not-https", error: "channels must use a plain https URL without credentials or a fragment" };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    return { ok: false, code: "http", error: "the channel could not be reached" };
  }
  if (!response.ok) return { ok: false, code: "http", error: `the channel answered HTTP ${response.status}` };
  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json") && !contentType.startsWith("text/plain")) {
    return { ok: false, code: "content-type", error: "the channel did not return JSON" };
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, code: "too-large", error: "the channel response is too large" };
  if (!response.body) return { ok: false, code: "invalid-json", error: "the channel returned an empty response" };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, code: "too-large", error: "the channel response is too large" };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return { ok: false, code: "http", error: "the channel response could not be read" };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { ok: false, code: "invalid-json", error: "the channel did not return valid JSON" };
  }
  return verifyCatalog(envelope, { keys: options.keys, now: options.now, ...(options.minimumSequence !== undefined ? { minimumSequence: options.minimumSequence } : {}) });
}
