// Announcements this workspace's admins write, kept in announcements.json; the remote announcement feed is separate.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import type { Announcement, AnnouncementLevel } from "../shared/announcement.ts";
import { writeFileAtomic } from "./atomic.ts";

export const ANNOUNCEMENTS_FILE = "announcements.json";
const MAX_ANNOUNCEMENTS = 100;

const announcementSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().max(4_000),
  level: z.enum(["info", "important"]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  startsAt: z.number().int().nonnegative().optional(),
  endsAt: z.number().int().nonnegative().optional(),
});
const fileSchema = z.object({ version: z.literal(1), announcements: z.array(announcementSchema).max(MAX_ANNOUNCEMENTS) });

export const announcementInputSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(4_000).default(""),
  level: z.enum(["info", "important"]).default("info"),
  startsAt: z.number().int().nonnegative().nullish(),
  endsAt: z.number().int().nonnegative().nullish(),
});

export type AnnouncementInput = z.infer<typeof announcementInputSchema>;

const newId = () => `ann-${randomBytes(9).toString("base64url")}`;

export function createAnnouncements(dataDir: string, now: () => number = Date.now) {
  const file = join(dataDir, ANNOUNCEMENTS_FILE);
  let announcements: Announcement[] = [];
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) announcements = parsed.data.announcements.map((item) => ({ ...item, source: "local" as const }));
    else console.warn(`announcements: ${file} is not an announcements file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`announcements: ${file} is unreadable; starting fresh`);
  }
  const save = () => {
    const stored = announcements.map(({ source: _source, ...item }) => item);
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, announcements: stored })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`announcements: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    list(): Announcement[] {
      return [...announcements].sort((a, b) => b.createdAt - a.createdAt);
    },
    get(id: string): Announcement | undefined {
      return announcements.find((item) => item.id === id);
    },
    add(input: AnnouncementInput): Announcement {
      if (announcements.length >= MAX_ANNOUNCEMENTS) throw new AnnouncementError("limit", `at most ${MAX_ANNOUNCEMENTS} announcements are kept`);
      const at = now();
      const item: Announcement = {
        id: newId(), title: input.title, body: input.body, level: input.level as AnnouncementLevel,
        createdAt: at, updatedAt: at,
        ...(input.startsAt != null ? { startsAt: input.startsAt } : {}),
        ...(input.endsAt != null ? { endsAt: input.endsAt } : {}),
        source: "local",
      };
      announcements = [item, ...announcements];
      save();
      return item;
    },
    update(id: string, input: AnnouncementInput): Announcement {
      const known = announcements.find((item) => item.id === id);
      if (!known) throw new AnnouncementError("not-found", `no announcement ${id}`);
      const next: Announcement = {
        ...known, title: input.title, body: input.body, level: input.level as AnnouncementLevel, updatedAt: now(),
        ...(input.startsAt != null ? { startsAt: input.startsAt } : {}),
        ...(input.endsAt != null ? { endsAt: input.endsAt } : {}),
      };
      announcements = announcements.map((item) => (item.id === id ? next : item));
      save();
      return next;
    },
    remove(id: string): boolean {
      const kept = announcements.filter((item) => item.id !== id);
      if (kept.length === announcements.length) return false;
      announcements = kept;
      save();
      return true;
    },
  };
}

export class AnnouncementError extends Error {
  readonly code: "not-found" | "limit";

  constructor(code: "not-found" | "limit", message: string) {
    super(message);
    this.code = code;
  }
}

export type Announcements = ReturnType<typeof createAnnouncements>;
