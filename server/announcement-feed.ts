// The operator-run announcement source: one JSON URL this server polls, so the project's own host can speak to
// every installation. It is read-only and unauthenticated content the operator chose; the fetch is bounded and a
// failed poll keeps the last good list.
import { z } from "zod";

import type { Announcement } from "../shared/announcement.ts";

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 8_000;
const DEFAULT_REFRESH_MS = 10 * 60_000;
const DEFAULT_START_DELAY_MS = 1_000;
const MAX_ANNOUNCEMENTS = 100;

const entrySchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().max(4_000).default(""),
  level: z.enum(["info", "important"]).default("info"),
  startsAt: z.number().int().nonnegative().optional(),
  endsAt: z.number().int().nonnegative().optional(),
});
const feedSchema = z.object({
  version: z.literal(1),
  announcements: z.array(z.unknown()).max(MAX_ANNOUNCEMENTS),
});

export interface AnnouncementFeedOptions {
  url: string;
  fetch?: typeof fetch;
  now?: () => number;
  refreshMs?: number;
  startDelayMs?: number;
  /** Test seam: defaults to console.warn. */
  warn?(message: string): void;
}

export interface AnnouncementFeed {
  list(): Announcement[];
  stop(): void;
}

export function createAnnouncementFeed(options: AnnouncementFeedOptions): AnnouncementFeed {
  const urlText = options.url.trim();
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const warn = options.warn ?? ((message: string) => console.warn(`announcement feed: ${message}`));
  let announcements: Announcement[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function poll(): Promise<void> {
    if (!urlText) return;
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      warn("the announcement source URL is invalid");
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      warn("the announcement source must be an http or https URL");
      return;
    }
    let response: Response;
    try {
      response = await doFetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    } catch {
      warn("the announcement source could not be reached");
      return;
    }
    if (!response.ok) {
      warn(`the announcement source answered HTTP ${response.status}`);
      return;
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      warn("the announcement source response could not be read");
      return;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
      warn("the announcement source response is too large");
      return;
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      warn("the announcement source did not return valid JSON");
      return;
    }
    const parsed = feedSchema.safeParse(envelope);
    if (!parsed.success) {
      warn("the announcement source sent an unexpected shape; keeping the last good list");
      return;
    }
    const at = now();
    const kept: Announcement[] = [];
    for (const raw of parsed.data.announcements) {
      const item = entrySchema.safeParse(raw);
      if (!item.success) continue;
      kept.push({
        id: item.data.id, title: item.data.title, body: item.data.body, level: item.data.level,
        createdAt: item.data.startsAt ?? at, updatedAt: at,
        ...(item.data.startsAt !== undefined ? { startsAt: item.data.startsAt } : {}),
        ...(item.data.endsAt !== undefined ? { endsAt: item.data.endsAt } : {}),
        source: "remote",
      });
      if (kept.length >= MAX_ANNOUNCEMENTS) break;
    }
    announcements = kept;
  }

  const schedule = (delay: number, repeat: boolean) => {
    if (!urlText) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
      if (repeat) schedule(refreshMs, true);
    }, delay);
    timer.unref();
  };
  schedule(options.startDelayMs ?? DEFAULT_START_DELAY_MS, refreshMs > 0);

  return {
    list: () => announcements,
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
