import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPlayer } from "./player.ts";
import { MUSIC_INTERNAL_MCP_PATH, musicRpc, musicToolNeedsControl } from "./rpc.ts";
import { MusicStore } from "./store.ts";
import type { MusicToolCatalogue } from "./tools.ts";
import type { MusicTrack } from "../../shared/music.ts";

function track(id: string): MusicTrack {
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
  };
}

const catalogue: MusicToolCatalogue = {
  async search() { return { tracks: [track("a")], page: 1, pageSize: 20, total: 1, hasMore: false }; },
  async playUrl() { return { handle: "h", mime: "audio/mpeg", expiresAt: new Date().toISOString() }; },
  async lyrics() { return { trackId: "x", format: "none", lines: [], credits: [], unavailableReason: null }; },
  async recommend() { return { tracks: [] }; },
  async favorite() {},
  async playlists() { return []; },
  async playlistTracks() { return { name: "P", tracks: [] }; },
  async createPlaylist(name) { return { playlistId: "kugou:n", name, kind: "created", sourceId: "n", coverUrl: null, trackCount: 0, local: false, createdAt: null }; },
  async addToPlaylist() {},
  async removeFromPlaylist() {},
  async tracksByIds(ids) { return ids.map(track); },
  async identify() { return []; },
  async radio() { return []; },
};

function fixture(access: "off" | "read" | "control") {
  const dataDir = mkdtempSync(join(tmpdir(), "eac-music-rpc-"));
  const store = new MusicStore({ dataDir });
  const player = createPlayer({ load: () => null, save: () => {} });
  return {
    close: () => { store.close(); rmSync(dataDir, { recursive: true, force: true }); },
    ask: (method: string, params?: unknown) => musicRpc({ method, params }, {
      player,
      store,
      catalogue,
      botId: "bot-1",
      assertActive: () => {},
      allowed: (name) => access === "control" || (access === "read" && !musicToolNeedsControl(name)),
    }),
  };
}

describe("the music MCP path", () => {
  it("is at the path the harness proxy reaches", () => {
    expect(MUSIC_INTERNAL_MCP_PATH).toBe("/api/internal/music/mcp");
  });

  it("lists only the tools a read-only turn may use", async () => {
    const test = fixture("read");
    try {
      const listed = await test.ask("tools/list") as { tools: Array<{ name: string }>; instructions: string };
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("MUSIC_SEARCH");
      expect(names).toContain("MUSIC_NOW_PLAYING");
      expect(names).toContain("MUSIC_QUEUE");
      // A control tool it would only be refused is not offered at all.
      expect(names).not.toContain("MUSIC_PLAY");
      expect(names).not.toContain("MUSIC_CONTROL");
      expect(listed.instructions).toContain("playbackConfirmed");
    } finally {
      test.close();
    }
  });

  it("refuses a control call from a read-only turn even when it asks anyway", async () => {
    const test = fixture("read");
    try {
      const refused = await test.ask("tools/call", { name: "MUSIC_PLAY", arguments: { trackIds: ["kugou:a"] } }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain("may not change the player");
    } finally {
      test.close();
    }
  });

  it("offers every tool to a control turn and runs one", async () => {
    const test = fixture("control");
    try {
      const listed = await test.ask("tools/list") as { tools: Array<{ name: string }> };
      expect(listed.tools.map((tool) => tool.name)).toContain("MUSIC_PLAY");
      const played = await test.ask("tools/call", { name: "MUSIC_PLAY", arguments: { trackIds: ["kugou:a"] } }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(played.isError).toBeFalsy();
      expect(JSON.parse(played.content[0]!.text).playbackConfirmed).toBe(false);
    } finally {
      test.close();
    }
  });

  it("refuses everything to an off turn", async () => {
    const test = fixture("off");
    try {
      const listed = await test.ask("tools/list") as { tools: unknown[] };
      expect(listed.tools).toHaveLength(0);
      const refused = await test.ask("tools/call", { name: "MUSIC_NOW_PLAYING", arguments: {} }) as { isError?: boolean };
      expect(refused.isError).toBe(true);
    } finally {
      test.close();
    }
  });

  it("refuses an unknown method and an unknown tool by name", async () => {
    const test = fixture("control");
    try {
      await expect(test.ask("resources/list")).rejects.toThrow(/unsupported music method/);
      const refused = await test.ask("tools/call", { name: "MUSIC_SING", arguments: {} }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain("no music tool named");
    } finally {
      test.close();
    }
  });
});
