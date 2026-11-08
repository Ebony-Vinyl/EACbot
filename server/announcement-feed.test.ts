import { describe, expect, it } from "vitest";

import { createAnnouncementFeed } from "./announcement-feed.ts";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("createAnnouncementFeed", () => {
  it("polls the source once and normalizes entries", async () => {
    const fetched: URL[] = [];
    const feed = createAnnouncementFeed({
      url: "https://announcements.example/eacbot.json",
      fetch: async (input) => {
        fetched.push(new URL(input.toString()));
        return json({
          version: 1,
          announcements: [
            { id: "eac-1", title: "New release", body: "0.2 is out", level: "important", startsAt: 100 },
            { id: "eac-2", title: "Tip" },
            { id: "bad", title: "" },
          ],
        });
      },
      now: () => 5_000,
      refreshMs: 0,
      startDelayMs: 1,
      warn: () => undefined,
    });
    try {
      await new Promise((done) => setTimeout(done, 20));
      expect(fetched).toHaveLength(1);
      expect(feed.list()).toMatchObject([
        { id: "eac-1", title: "New release", level: "important", startsAt: 100, createdAt: 100, updatedAt: 5_000, source: "remote" },
        { id: "eac-2", title: "Tip", body: "", level: "info", source: "remote" },
      ]);
    } finally {
      feed.stop();
    }
  });

  it("keeps the last good list when a later poll fails, and accepts nothing without a usable URL", async () => {
    let healthy = true;
    const warns: string[] = [];
    const feed = createAnnouncementFeed({
      url: "https://announcements.example/eacbot.json",
      fetch: async () => (healthy ? json({ version: 1, announcements: [{ id: "keep", title: "Kept" }] }) : new Response("no", { status: 500 })),
      refreshMs: 30,
      startDelayMs: 1,
      warn: (message) => warns.push(message),
    });
    try {
      await new Promise((done) => setTimeout(done, 20));
      expect(feed.list()).toMatchObject([{ id: "keep" }]);
      healthy = false;
      await new Promise((done) => setTimeout(done, 100));
      expect(feed.list()).toMatchObject([{ id: "keep" }]);
      expect(warns).toContain("the announcement source answered HTTP 500");

      const silent = createAnnouncementFeed({ url: "", fetch: async () => json({ version: 1, announcements: [] }), refreshMs: 0, startDelayMs: 1 });
      silent.stop();
      await new Promise((done) => setTimeout(done, 20));
      expect(silent.list()).toEqual([]);
    } finally {
      feed.stop();
    }
  });
});
