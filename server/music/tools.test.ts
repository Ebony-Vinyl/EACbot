import { describe, expect, it } from "vitest";

import type { MusicPlaylist, MusicTrack } from "../../shared/music.ts";
import { createPlayer } from "./player.ts";
import { MusicStore } from "./store.ts";
import { runMusicTool, type MusicToolCatalogue, type MusicToolContext } from "./tools.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function track(id: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: `kugou:${id}`,
    source: "kugou",
    title: `Song ${id}`,
    artists: ["Artist"],
    album: null,
    albumId: null,
    durationSeconds: 200,
    hash: id,
    audioId: null,
    coverUrl: null,
    vip: false,
    maxQuality: null,
    unsupportedReason: null,
    ...overrides,
  };
}

/** A catalogue that answers from a fixed library, so a tool test never reaches the network. */
function fakeCatalogue(library: MusicTrack[]): MusicToolCatalogue {
  return {
    async search(input) {
      const hit = library.filter((entry) => entry.title.toLowerCase().includes(input.keyword.toLowerCase()));
      return input.kind === "track" ? { tracks: hit, page: 1, pageSize: 20, total: hit.length, hasMore: false } : { playlists: [], albums: [] };
    },
    async playUrl() {
      return { handle: "h", mime: "audio/mpeg", expiresAt: new Date().toISOString() };
    },
    async lyrics(entry) {
      return { trackId: entry.id, format: "none", lines: [], credits: [], unavailableReason: "no lyrics" };
    },
    async recommend() {
      return { tracks: library };
    },
    async favorite() {},
    async playlists(): Promise<MusicPlaylist[]> {
      return [];
    },
    async playlistTracks() {
      return { name: "Remote", tracks: library };
    },
    async createPlaylist(name) {
      return { playlistId: "kugou:x", name, kind: "created", sourceId: "x", coverUrl: null, trackCount: 0, local: false, createdAt: null };
    },
    async addToPlaylist() {},
    async removeFromPlaylist() {},
    async tracksByIds(ids) {
      return ids.map((id) => library.find((entry) => entry.id === id)).filter((entry): entry is MusicTrack => Boolean(entry));
    },
    async identify() {
      return [library[0]!];
    },
    async radio() {
      return library;
    },
  };
}

function fixture(library: MusicTrack[] = [track("a"), track("b")]): { context: MusicToolContext; close(): void; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "eac-music-tools-"));
  const store = new MusicStore({ dataDir });
  const player = createPlayer({ load: () => null, save: () => {} });
  return {
    dataDir,
    context: { player, store, catalogue: fakeCatalogue(library), botId: "bot-1" },
    close: () => {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The parsed JSON a tool answered with, plus whether it was an error. */
function answer(result: Awaited<ReturnType<typeof runMusicTool>>): { body: Record<string, unknown>; isError: boolean } {
  return { body: JSON.parse(result.content[0]!.text), isError: result.isError === true };
}

describe("MUSIC_SEARCH", () => {
  it("returns tracks and refuses an empty keyword with an example", async () => {
    const test = fixture();
    try {
      const found = answer(await runMusicTool(test.context, "MUSIC_SEARCH", { keyword: "Song" }));
      expect(found.isError).toBe(false);
      expect((found.body.tracks as unknown[]).length).toBe(2);

      const refused = answer(await runMusicTool(test.context, "MUSIC_SEARCH", {}));
      expect(refused.isError).toBe(true);
      expect((refused.body.error as { message: string }).message).toContain("keyword");
    } finally {
      test.close();
    }
  });
});

describe("MUSIC_PLAY", () => {
  it("queues tracks and says playback is unconfirmed", async () => {
    const test = fixture();
    try {
      const played = answer(await runMusicTool(test.context, "MUSIC_PLAY", { trackIds: ["kugou:a"] }));
      expect(played.isError).toBe(false);
      expect(played.body.playbackConfirmed).toBe(false);
      expect(played.body.state).toBe("buffering");
      // The note is what stops a model from claiming a song is playing.
      expect(String(played.body.note)).toContain("Do not say a song is playing");
      expect((played.body.current as { id: string }).id).toBe("kugou:a");
    } finally {
      test.close();
    }
  });

  it("confirms only after a client's receipt", async () => {
    const test = fixture();
    try {
      answer(await runMusicTool(test.context, "MUSIC_PLAY", { trackIds: ["kugou:a"] }));
      test.context.player.receipt({ state: "playing", revision: test.context.player.revision() });
      const nowPlaying = answer(await runMusicTool(test.context, "MUSIC_NOW_PLAYING", {}));
      expect(nowPlaying.body.playbackConfirmed).toBe(true);
      expect(nowPlaying.body.note).toBeUndefined();
    } finally {
      test.close();
    }
  });

  it("refuses an unknown track id", async () => {
    const test = fixture();
    try {
      const refused = answer(await runMusicTool(test.context, "MUSIC_PLAY", { trackIds: ["kugou:nope"] }));
      expect(refused.isError).toBe(true);
      expect((refused.body.error as { code: string }).code).toBe("unknown_track");
    } finally {
      test.close();
    }
  });
});

describe("MUSIC_CONTROL", () => {
  it("refuses a stale revision and names the fresh one", async () => {
    const test = fixture();
    try {
      answer(await runMusicTool(test.context, "MUSIC_PLAY", { trackIds: ["kugou:a"] }));
      const stale = test.context.player.revision();
      answer(await runMusicTool(test.context, "MUSIC_CONTROL", { action: "volume", volume: 30 }));
      const refused = answer(await runMusicTool(test.context, "MUSIC_CONTROL", { action: "pause", expectedRevision: stale }));
      expect(refused.isError).toBe(true);
      const error = refused.body.error as { code: string; message: string };
      expect(error.code).toBe("stale_revision");
      expect(error.message).toContain("now revision");
    } finally {
      test.close();
    }
  });

  it("refuses an action outside the list with the list", async () => {
    const test = fixture();
    try {
      const refused = answer(await runMusicTool(test.context, "MUSIC_CONTROL", { action: "explode" }));
      expect(refused.isError).toBe(true);
      expect((refused.body.error as { message: string }).message).toContain("pause");
    } finally {
      test.close();
    }
  });
});

describe("MUSIC_QUEUE", () => {
  it("reads the queue with the ids a control needs", async () => {
    const test = fixture();
    try {
      answer(await runMusicTool(test.context, "MUSIC_PLAY", { trackIds: ["kugou:a", "kugou:b"] }));
      const read = answer(await runMusicTool(test.context, "MUSIC_QUEUE", {}));
      expect(read.isError).toBe(false);
      expect(read.body.count).toBe(2);
      const rows = read.body.queue as Array<{ queueItemId: string; id: string; index: number }>;
      expect(rows.map((row) => row.id)).toEqual(["kugou:a", "kugou:b"]);
      expect(rows[0]!.queueItemId).toMatch(/^q_/);
    } finally {
      test.close();
    }
  });

  it("removes by queue item id", async () => {
    const test = fixture();
    try {
      answer(await runMusicTool(test.context, "MUSIC_PLAY", { trackIds: ["kugou:a", "kugou:b"] }));
      const read = answer(await runMusicTool(test.context, "MUSIC_QUEUE", {}));
      const first = (read.body.queue as Array<{ queueItemId: string }>)[0]!;
      const removed = answer(await runMusicTool(test.context, "MUSIC_QUEUE", { action: "remove", queueItemId: first.queueItemId }));
      expect(removed.isError).toBe(false);
      expect(removed.body.queueLength).toBe(1);
    } finally {
      test.close();
    }
  });
});

describe("MUSIC_PLAN", () => {
  it("builds a queue sized to the session and says the stop is the caller's to schedule", async () => {
    const test = fixture(Array.from({ length: 40 }, (_, index) => track(`t${index}`)));
    try {
      const planned = answer(await runMusicTool(test.context, "MUSIC_PLAN", { minutes: 120, mood: "专注" }));
      expect(planned.isError).toBe(false);
      const plan = planned.body.plan as { minutes: number; tracks: number; stopAtEnd: boolean; note: string };
      expect(plan.minutes).toBe(120);
      // Two hours at roughly four minutes a track.
      expect(plan.tracks).toBe(30);
      expect(plan.stopAtEnd).toBe(true);
      expect(plan.note).toContain("Schedule the stop yourself");
      expect(planned.body.queueLength).toBe(30);
    } finally {
      test.close();
    }
  });

  it("refuses a plan with no duration", async () => {
    const test = fixture();
    try {
      const refused = answer(await runMusicTool(test.context, "MUSIC_PLAN", { mood: "专注" }));
      expect(refused.isError).toBe(true);
      expect((refused.body.error as { message: string }).message).toContain("minutes");
    } finally {
      test.close();
    }
  });
});

describe("MUSIC_PLAYLIST", () => {
  it("creates, adds and lists a playlist this server owns", async () => {
    const test = fixture();
    try {
      const created = answer(await runMusicTool(test.context, "MUSIC_PLAYLIST", { action: "create", name: "Late night" }));
      expect(created.isError).toBe(false);
      const playlistId = (created.body.playlist as MusicPlaylist).playlistId;

      const added = answer(await runMusicTool(test.context, "MUSIC_PLAYLIST", { action: "add", playlistId, trackIds: ["kugou:a"] }));
      expect(added.body.added).toBe(1);

      const listed = answer(await runMusicTool(test.context, "MUSIC_PLAYLIST", {}));
      const playlists = listed.body.playlists as MusicPlaylist[];
      expect(playlists.map((entry) => entry.name)).toContain("Late night");

      const read = answer(await runMusicTool(test.context, "MUSIC_PLAYLIST", { action: "read", playlistId }));
      expect((read.body.tracks as unknown[]).length).toBe(1);
    } finally {
      test.close();
    }
  });

  it("refuses to delete without the person's own yes", async () => {
    const test = fixture();
    try {
      const created = answer(await runMusicTool(test.context, "MUSIC_PLAYLIST", { action: "create", name: "Keep" }));
      const playlistId = (created.body.playlist as MusicPlaylist).playlistId;
      const context: MusicToolContext = { ...test.context, confirm: async () => false };
      const refused = answer(await runMusicTool(context, "MUSIC_PLAYLIST", { action: "delete", playlistId }));
      expect(refused.isError).toBe(true);
      expect((refused.body.error as { code: string }).code).toBe("refused");
      // The playlist is still there: a refused confirmation changes nothing.
      expect(test.context.store.playlist(playlistId)).not.toBeNull();
    } finally {
      test.close();
    }
  });
});

describe("MUSIC_PREFERENCES", () => {
  it("stores a stated preference and reads it back", async () => {
    const test = fixture();
    try {
      const set = answer(await runMusicTool(test.context, "MUSIC_PREFERENCES", { action: "set", key: "不喜欢太吵", value: "晚上放轻音乐" }));
      expect(set.isError).toBe(false);
      const read = answer(await runMusicTool(test.context, "MUSIC_PREFERENCES", {}));
      const preferences = read.body.preferences as Array<{ key: string; value: string; kind: string }>;
      expect(preferences).toEqual([{ key: "不喜欢太吵", value: "晚上放轻音乐", kind: "stated", updatedAt: expect.any(String) }]);
      // An observed habit is labelled, so a later reader cannot mistake it for a rule.
      answer(await runMusicTool(test.context, "MUSIC_PREFERENCES", { action: "set", key: "favourite_genre", value: "jazz", kind: "observed" }));
      const again = answer(await runMusicTool(test.context, "MUSIC_PREFERENCES", {}));
      const kinds = (again.body.preferences as Array<{ kind: string }>).map((entry) => entry.kind);
      expect(kinds).toContain("observed");
    } finally {
      test.close();
    }
  });
});

describe("MUSIC_FAVORITE", () => {
  it("saves a favourite locally even when Kugou refuses the remote change", async () => {
    const test = fixture();
    try {
      const context: MusicToolContext = {
        ...test.context,
        catalogue: { ...test.context.catalogue, favorite: async () => { throw new Error("Kugou refused"); } },
      };
      const added = answer(await runMusicTool(context, "MUSIC_FAVORITE", { action: "add", trackId: "kugou:a" }));
      expect(added.isError).toBe(false);
      expect(added.body.favorite).toBe(true);
      expect(String(added.body.note)).toContain("did not confirm");
      expect(test.context.store.isFavorite("kugou:a")).toBe(true);
    } finally {
      test.close();
    }
  });
});

describe("MUSIC_LYRICS", () => {
  it("reads the current track's lyrics when no id is given", async () => {
    const test = fixture();
    try {
      answer(await runMusicTool(test.context, "MUSIC_PLAY", { trackIds: ["kugou:a"] }));
      const lyrics = answer(await runMusicTool(test.context, "MUSIC_LYRICS", {}));
      expect(lyrics.isError).toBe(false);
      expect(lyrics.body.trackId).toBe("kugou:a");
    } finally {
      test.close();
    }
  });

  it("refuses when nothing is playing and no id is given", async () => {
    const test = fixture();
    try {
      const refused = answer(await runMusicTool(test.context, "MUSIC_LYRICS", {}));
      expect(refused.isError).toBe(true);
      expect((refused.body.error as { message: string }).message).toContain("nothing is playing");
    } finally {
      test.close();
    }
  });
});

describe("MUSIC_IDENTIFY", () => {
  it("returns candidates and asks the person before queueing", async () => {
    const test = fixture();
    try {
      const identified = answer(await runMusicTool(test.context, "MUSIC_IDENTIFY", { durationSeconds: 6 }));
      expect(identified.isError).toBe(false);
      expect((identified.body.matches as unknown[]).length).toBe(1);
      expect(String(identified.body.note)).toContain("Ask the person");
    } finally {
      test.close();
    }
  });
});

describe("an unknown tool", () => {
  it("is refused with its name", async () => {
    const test = fixture();
    try {
      const refused = answer(await runMusicTool(test.context, "MUSIC_DANCE", {}));
      expect(refused.isError).toBe(true);
      expect((refused.body.error as { code: string }).code).toBe("unknown_tool");
    } finally {
      test.close();
    }
  });
});
