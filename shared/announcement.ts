/** What a person sees on every client: one announcement. Timestamps are epoch milliseconds. */
export type AnnouncementLevel = "info" | "important";

export interface Announcement {
  id: string;
  title: string;
  body: string;
  level: AnnouncementLevel;
  createdAt: number;
  updatedAt: number;
  startsAt?: number;
  endsAt?: number;
  /** "remote": the operator-run announcement source; "local": this workspace's admins. */
  source: "remote" | "local";
}

/** Announcements whose window covers `now`, important ones first, then the newest change. */
export function activeAnnouncements(items: readonly Announcement[], now: number): Announcement[] {
  return items
    .filter((item) => (item.startsAt === undefined || item.startsAt <= now) && (item.endsAt === undefined || item.endsAt > now))
    .sort((a, b) => (a.level === b.level ? b.updatedAt - a.updatedAt : a.level === "important" ? -1 : 1));
}
