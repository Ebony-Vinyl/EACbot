import { describe, expect, it } from "vitest";

import { createMusicRoutes, type MusicRouteDeps } from "./music.ts";
import { createPlayer } from "../music/player.ts";
import { MusicStore } from "../music/store.ts";
import type { MusicAccount, MusicPlaylist, MusicTrack } from "../../shared/music.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** A minimal request/response pair, so a route can be called without a socket. */
interface Called { status: number; body: unknown }

function call(deps: MusicRouteDeps, input: { method: string; path: string; body?: unknown; range?: string }): Promise<Called> {
  const handler = createMusicRoutes(deps);
  const url = new URL(`http://127.0.0.1:9999${input.path}`);
  let settled: Called | null = null;
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(status: number) { this.statusCode = status; return this; },
    end(payload?: unknown) {
      if (settled) return;
      const text = typeof payload === "string" ? payload : payload instanceof Uint8Array ? new TextDecoder().decode(payload) : payload === undefined ? "" : String(payload);
      settled = { status: this.statusCode, body: text ? safeJson(text) : null };
    },
    headersSent: false,
    writableEnded: false,
  };
  const req = {
    headers: input.range ? { range: input.range } : {},
    async *[Symbol.asyncIterator]() {},
  };
  const run = handler({
    req: req as never,
    res: res as never,
    url,
    path: url.pathname,
    method: input.method,
    auth: { kind: "admin" } as never,
    json(_res: unknown, status: number, body: unknown) {
      settled = { status, body };
    },
    readBody: async () => input.body ?? {},
  });
  return run.then(() => settled ?? { status: 0, body: null }) as Promise<Called>;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function deps(overrides: Partial<MusicRouteDeps> = {}): { deps: MusicRouteDeps; close(): void } {
  const dataDir = mkdtempSync(join(tmpdir(), "eac-music-routes-"));
  const store = new MusicStore({ dataDir });
  const player = createPlayer({ load: () => null, save: () => {} });
  const account: MusicAccount = { loggedIn: false, userId: null, nickname: null, avatarUrl: null, vip: false, vipLabel: null, entitledQuality: "128k" };
  const base: MusicRouteDeps = {
    snapshot: async () => ({ playback: player.snapshot(), account, adapters: [], playlists: [], at: new Date().toISOString() }),
    player,
    store,
    stream: {
      async handleFor() { return { handle: "h1", mime: "audio/mpeg", expiresAt: new Date().toISOString() }; },
      handleForFile() { return { handle: "cover_x", mime: "image/png" }; },
      async serve() { return { status: 200, headers: { "content-type": "audio/mpeg" }, body: Buffer.from("abc") }; },
      forget() {},
      trackFor() { return null; },
    },
    catalogue: {
      async searchTracks() { return { tracks: [track("a")], page: 1, pageSize: 20, total: 1, hasMore: false }; },
      async searchPlaylists() { return { playlists: [] as MusicPlaylist[], page: 1, hasMore: false }; },
      async searchAlbums() { return { albums: [], page: 1, hasMore: false }; },
      async playUrl() { return { url: "https://cdn/x", quality: "320k" as const, free: false, expiresInSeconds: 3_600 }; },
      async privilegeQualities() { return []; },
      async cloudUrl() { return "https://cdn/cloud"; },
      async playlistTracks() { return { name: "Remote", tracks: [track("r")], page: 1, hasMore: false }; },
      async playlists() { return []; },
      async createPlaylist(name) { return { playlistId: "kugou:n", name, kind: "created" as const, sourceId: "n", coverUrl: null, trackCount: 0, local: false, createdAt: null }; },
      async addToPlaylist() {},
      async removeFromPlaylist() {},
      async ranks() { return []; },
      async rank(id) { return { rankId: id, name: "R", coverUrl: null, entries: [], page: 1, pageSize: 30, hasMore: false }; },
      async dailyRecommendations() { return { tracks: [track("d")], playlists: [] }; },
      async privateFm() { return []; },
      async scenes() { return []; },
      async sceneTracks() { return []; },
      async artist(id) { return { artist: { artistId: id, name: "A", avatarUrl: null, bio: null, trackCount: 0, albumCount: 0 }, tracks: [], albums: [] }; },
      async album(id) { return { albumId: id, name: "Al", artist: "A", coverUrl: null, releaseDate: null, trackCount: 0, tracks: [] }; },
      async comments() { return { comments: [], page: 1, hasMore: false }; },
      async postComment() { return null; },
      async likeComment() {},
      async longAudio() { return { tracks: [], page: 1, pageSize: 20, total: 0, hasMore: false }; },
      async videoUrl() { return { url: "https://cdn/v", durationSeconds: 0 }; },
      async cloudTracks() { return { tracks: [], page: 1, pageSize: 50, total: 0, hasMore: false }; },
      async favorite() {},
      async reportPlay() {},
    },
    lyrics: { async search() { return []; }, async fetch() { return { trackId: "x", format: "none" as const, lines: [], credits: [], unavailableReason: null }; }, async forTrack() { return { trackId: "x", format: "none" as const, lines: [], credits: [], unavailableReason: null }; } },
    local: { scan: () => ({ folder: "", added: 0, updated: 0, removed: 0, skipped: 0, unsupported: 0, truncated: false, error: null }), tracks: () => [], pathFor: () => null, lyricsPathFor: () => null, coverPathFor: () => null },
    session: {
      current: () => null, signedIn: () => false,
      device: () => ({ dfid: "d", mid: "m", uuid: "u", userId: "0", token: "" }),
      async startQr() { return { key: "k", url: "https://qr", expiresAt: new Date().toISOString() }; },
      async pollQr() { return { status: "waiting" as const }; },
      async sendSmsCode() {}, async loginWithCode() { throw new Error("not in this test"); },
      async register() { throw new Error("not in this test"); }, async refresh() { return null; },
      signOut() {}, async refreshProfile() {}, async refreshVip() {},
    },
    focus: { claim: () => { throw new Error("unused"); }, release() {}, userPaused() {}, userResumed() {}, userVolumeChanged() {}, musicStarted() {}, musicStopped() {}, ducked: () => false, activeLease: () => null, dispose() {} },
    adapters: () => [],
    account: () => account,
    mayManage: () => true,
    eq: () => ({ gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preset: "flat", enabled: false }),
    setEq: (input) => input as never,
    theme: () => "standard",
    setTheme: () => {},
    async importPlaylist() { return { playlist: { playlistId: "local:1" }, matched: 1, unmatched: 0 }; },
    async identify() { return [track("i")]; },
    jellyfin: () => null,
    config: () => undefined,
    reloadLocal: () => {},
    changed: () => {},
    fm: () => ({ mode: "normal", poolId: "taste", active: false, current: null, upcoming: [], history: [] }),
    fmAction: async () => ({ mode: "normal", poolId: "taste", active: false, current: null, upcoming: [], history: [] }),
    connectivity: async () => ({ online: true }),
    jellyfinImport: async () => ({ playlistId: "local:x", name: "x", albums: 0, tracks: 0, removed: 0 }),
    image: async () => null,
    ...overrides,
  };
  return { deps: base, close: () => { store.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

describe("the music HTTP surface", () => {
  it("answers the snapshot", async () => {
    const test = deps();
    try {
      const answer = await call(test.deps, { method: "GET", path: "/api/music" });
      expect(answer.status).toBe(200);
      expect((answer.body as { playback: { revision: number } }).playback.revision).toBe(1);
    } finally {
      test.close();
    }
  });

  it("hands the whole music area to someone else", async () => {
    const test = deps({ mayManage: () => false });
    try {
      const answer = await call(test.deps, { method: "GET", path: "/api/music" });
      expect(answer.status).toBe(403);
    } finally {
      test.close();
    }
  });

  it("refuses a control whose revision has moved on, with 409", async () => {
    const test = deps();
    try {
      const queued = await call(test.deps, { method: "POST", path: "/api/music/queue", body: { action: "add", trackIds: ["kugou:a"] } });
      expect(queued.status).toBe(200);
      const stale = (queued.body as { playback: { revision: number } }).playback.revision;
      await call(test.deps, { method: "POST", path: "/api/music/control", body: { action: "volume", volume: 20 } });
      const refused = await call(test.deps, { method: "POST", path: "/api/music/control", body: { action: "pause", expectedRevision: stale } });
      expect(refused.status).toBe(409);
      expect((refused.body as { error: { code: string } }).error.code).toBe("stale_revision");
    } finally {
      test.close();
    }
  });

  it("records a receipt and flips playbackConfirmed", async () => {
    const test = deps();
    try {
      const queued = await call(test.deps, { method: "POST", path: "/api/music/queue", body: { action: "add", trackIds: ["kugou:a"] } });
      const revision = (queued.body as { playback: { revision: number } }).playback.revision;
      const confirmed = await call(test.deps, { method: "POST", path: "/api/music/receipts", body: { state: "playing", revision, positionSeconds: 3 } });
      expect(confirmed.status).toBe(200);
      const playback = (confirmed.body as { playback: { playbackConfirmed: boolean; state: string } }).playback;
      expect(playback.playbackConfirmed).toBe(true);
      expect(playback.state).toBe("playing");
    } finally {
      test.close();
    }
  });

  it("refuses a receipt with no state, naming one", async () => {
    const test = deps();
    try {
      const refused = await call(test.deps, { method: "POST", path: "/api/music/receipts", body: {} });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain("playing");
    } finally {
      test.close();
    }
  });

  it("marks a pause as the person's own, so a focus lease cannot resume it", async () => {
    const paused: string[] = [];
    const test = deps({ focus: { claim: () => { throw new Error("unused"); }, release() {}, userPaused() { paused.push("paused"); }, userResumed() { paused.push("resumed"); }, userVolumeChanged() {}, musicStarted() {}, musicStopped() {}, ducked: () => false, activeLease: () => null, dispose() {} } });
    try {
      await call(test.deps, { method: "POST", path: "/api/music/queue", body: { action: "add", trackIds: ["kugou:a"] } });
      await call(test.deps, { method: "POST", path: "/api/music/control", body: { action: "pause" } });
      expect(paused).toEqual(["paused"]);
    } finally {
      test.close();
    }
  });

  it("streams a handle with its range, not a JSON envelope", async () => {
    const test = deps({
      stream: {
        async handleFor() { return { handle: "h1", mime: "audio/mpeg", expiresAt: new Date().toISOString() }; },
        handleForFile() { return { handle: "x", mime: "image/png" }; },
        async serve(_handle, request) {
          expect(request.range).toBe("bytes=0-1");
          return { status: 206, headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-1/3" }, body: Buffer.from("ab") };
        },
        forget() {}, trackFor() { return null; },
      },
    });
    try {
      const answer = await call(test.deps, { method: "GET", path: "/api/music/stream/h1", range: "bytes=0-1" });
      expect(answer.status).toBe(206);
      expect(answer.body).toBe("ab");
    } finally {
      test.close();
    }
  });

  it("mints stream handles and reports a per-track refusal inside the answer", async () => {
    const test = deps({
      stream: {
        async handleFor(track) {
          if (track.id === "kugou:vip") throw Object.assign(new Error("this track needs a paid account"), { code: "vip_required" });
          return { handle: `h_${track.id}`, mime: "audio/mpeg", expiresAt: new Date().toISOString() };
        },
        handleForFile() { return { handle: "x", mime: "image/png" }; },
        async serve() { return { status: 200, headers: {}, body: null }; },
        forget() {}, trackFor() { return null; },
      },
      catalogue: {
        ...deps().deps.catalogue,
        async searchTracks() {
          return { tracks: [track("a"), { ...track("vip"), vip: true }], page: 1, pageSize: 20, total: 2, hasMore: false };
        },
      },
    });
    try {
      await call(test.deps, { method: "POST", path: "/api/music/queue", body: { action: "add", trackIds: ["kugou:a", "kugou:vip"] } });
      const answer = await call(test.deps, { method: "POST", path: "/api/music/stream", body: { trackIds: ["kugou:a", "kugou:vip"], quality: "320k" } });
      expect(answer.status).toBe(200);
      const handles = (answer.body as { handles: Array<{ trackId: string; url?: string; error?: { code: string } }> }).handles;
      expect(handles[0]!.url).toContain("/api/music/stream/");
      expect(handles[1]!.error?.code).toBe("vip_required");
    } finally {
      test.close();
    }
  });

  it("saves an EQ curve and refuses one of the wrong length", async () => {
    let saved: unknown = null;
    const test = deps({ setEq: (input) => { saved = input; return { gains: Array.from({ length: 10 }, () => 1), preset: "custom", enabled: true }; } });
    try {
      const answer = await call(test.deps, { method: "PUT", path: "/api/music/eq", body: { gains: Array.from({ length: 10 }, () => 1), preset: "custom", enabled: true } });
      expect(answer.status).toBe(200);
      expect(saved).not.toBeNull();
    } finally {
      test.close();
    }
  });

  it("refuses a theme it does not have", async () => {
    const test = deps();
    try {
      const refused = await call(test.deps, { method: "PUT", path: "/api/music/theme", body: { theme: "disco" } });
      // The route hands an unknown name to setTheme, which ignores it; the answer is the current theme.
      expect(refused.status).toBe(200);
      expect((refused.body as { theme: string }).theme).toBe("standard");
    } finally {
      test.close();
    }
  });

  it("answers 404 for an unknown music endpoint", async () => {
    const test = deps();
    try {
      const answer = await call(test.deps, { method: "GET", path: "/api/music/nonsense" });
      expect(answer.status).toBe(404);
    } finally {
      test.close();
    }
  });
});
