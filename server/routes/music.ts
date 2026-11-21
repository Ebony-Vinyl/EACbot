// The music HTTP surface: the snapshot the view paints from, the player controls,
// the stream proxy, lyrics, playlists, recommendations, imports and the account.
// The view's own commands are the person's, so they carry full access; the stream
// route is the one place a byte range reaches a client.
import { PASS, type RouteHandler } from "./table.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { MusicAccount, MusicAdapterSummary, MusicEq, MusicQuality, MusicSnapshot, MusicTrack, NowPlayingTheme } from "../../shared/music.ts";
import { MUSIC_CONTROL_ACTIONS, MUSIC_QUEUE_ACTIONS, type Player } from "../music/player.ts";
import type { MusicStore } from "../music/store.ts";
import type { MusicStream } from "../music/stream.ts";
import type { KugouCatalogue } from "../music/kugou/catalog.ts";
import type { KugouLyricsClient } from "../music/kugou/lyrics.ts";
import type { KugouSessionManager } from "../music/kugou/session.ts";
import type { LocalLibrary } from "../music/local.ts";
import type { MusicFocus } from "../music/focus.ts";
import type { JellyfinClient } from "../music/jellyfin.ts";
import type { ImportPlatform } from "../music/import.ts";

/** How much PCM an identification may carry: 12 seconds of 44.1 kHz mono 16-bit. */
const MAX_IDENTIFY_BYTES = 44_100 * 2 * 12;

export interface MusicRouteDeps {
  snapshot(): Promise<MusicSnapshot>;
  player: Player;
  store: MusicStore;
  stream: MusicStream;
  catalogue: KugouCatalogue;
  lyrics: KugouLyricsClient;
  local: LocalLibrary;
  session: KugouSessionManager;
  focus: MusicFocus;
  adapters(): MusicAdapterSummary[];
  account(): MusicAccount;
  mayManage(auth: RequestAuth): boolean;
  eq(): MusicEq;
  setEq(input: unknown): MusicEq;
  theme(): NowPlayingTheme;
  setTheme(theme: NowPlayingTheme): void;
  importPlaylist(input: { platform: ImportPlatform; link: string }): Promise<{ playlist: unknown; matched: number; unmatched: number }>;
  identify(pcm: Uint8Array): Promise<unknown[]>;
  jellyfin(): JellyfinClient | null;
  config(): { localFolders?: string[]; jellyfin?: { baseUrl: string; apiKey: string } } | undefined;
  reloadLocal(): void;
  changed(playback: unknown): void;
  fm(): unknown;
  /** One cover image through the bounded disk cache, or null when it cannot be fetched. */
  image(url: string): Promise<{ body: Buffer; mime: string } | null>;
  fmAction(input: { action: string; playedSeconds?: number }): Promise<unknown>;
  connectivity(): Promise<{ online: boolean }>;
  jellyfinImport(libraryId: string): Promise<{ playlistId: string; name: string; albums: number; tracks: number; removed: number }>;
}
export function createMusicRoutes(deps: MusicRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== "/api/music" && !path.startsWith("/api/music/")) return PASS;
    if (!deps.mayManage(auth)) {
      return json(res, 403, { error: { code: "forbidden_zone", message: "Only an owner or administrator can use the music player." } });
    }

    // The stream route is the only one a browser fetches with a range header and
    // no JSON; it answers with bytes and never with a JSON error envelope.
    if (method === "GET" && path.startsWith("/api/music/stream/")) {
      const handle = decodeURIComponent(path.slice("/api/music/stream/".length));
      const range = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
      try {
        const answer = await deps.stream.serve(handle, { method, ...(range ? { range } : {}) });
        res.writeHead(answer.status, answer.headers);
        if (!answer.body) { res.end(); return; }
        if (Buffer.isBuffer(answer.body)) { res.end(answer.body); return; }
        answer.body.pipe(res);
        return;
      } catch (error) {
        const code = (error as { code?: string }).code ?? "source_unavailable";
        return json(res, code === "unsupported_format" ? 415 : 502, { error: { code, message: error instanceof Error ? error.message : String(error) } });
      }
    }

    res.setHeader("Cache-Control", "no-store");
    const body = method === "POST" || method === "PATCH" || method === "PUT" ? await readBody(req, 1_000_000) : null;

    try {
      if (method === "GET" && path === "/api/music") return json(res, 200, await deps.snapshot());

      if (method === "GET" && path === "/api/music/playback") return json(res, 200, { playback: deps.player.snapshot() });

      // A client reports what its audio element actually did. This is the only writer of playback truth.
      if (method === "POST" && path === "/api/music/receipts") {
        if (!body || typeof body.state !== "string") {
          return json(res, 400, { error: { code: "invalid_input", message: `a receipt needs a state: {"state": "playing", "revision": 3}` } });
        }
        const playback = deps.player.receipt({
          state: body.state,
          revision: Number(body.revision ?? deps.player.revision()),
          ...(typeof body.positionSeconds === "number" ? { positionSeconds: body.positionSeconds } : {}),
          ...(typeof body.durationSeconds === "number" ? { durationSeconds: body.durationSeconds } : {}),
          ...(typeof body.code === "string" ? { code: body.code } : {}),
          ...(typeof body.message === "string" ? { message: body.message } : {}),
        });
        // A real play is what history and Kugou's own recommendations are built from.
        if (body.state === "playing" && playback.current) {
          deps.focus.musicStarted();
        }
        if (body.state === "paused" || body.state === "failed" || body.state === "ended") deps.focus.musicStopped();
        return json(res, 200, { playback });
      }

      if (method === "POST" && path === "/api/music/control") {
        if (!body || !MUSIC_CONTROL_ACTIONS.includes(body.action)) {
          return json(res, 400, { error: { code: "unsupported_action", message: `action must be one of ${MUSIC_CONTROL_ACTIONS.join(", ")}` } });
        }
        const playback = deps.player.control({
          action: body.action,
          ...(typeof body.expectedRevision === "number" ? { expectedRevision: body.expectedRevision } : {}),
          ...(typeof body.positionSeconds === "number" ? { positionSeconds: body.positionSeconds } : {}),
          ...(typeof body.volume === "number" ? { volume: body.volume } : {}),
          ...(typeof body.quality === "string" ? { quality: body.quality as MusicQuality } : {}),
          ...(typeof body.repeat === "string" ? { repeat: body.repeat } : {}),
          ...(typeof body.shuffle === "boolean" ? { shuffle: body.shuffle } : {}),
        });
        // A person's own pause outranks any lease, so speech never resumes music behind them.
        if (body.action === "pause") deps.focus.userPaused();
        if (body.action === "resume" || body.action === "play") deps.focus.userResumed();
        if (body.action === "volume") deps.focus.userVolumeChanged();
        return json(res, 200, { playback });
      }

      if (method === "POST" && path === "/api/music/queue") {
        if (!body || !MUSIC_QUEUE_ACTIONS.includes(body.action)) {
          return json(res, 400, { error: { code: "unsupported_action", message: `action must be one of ${MUSIC_QUEUE_ACTIONS.join(", ")}` } });
        }
        if (body.action === "add" || body.action === "replace") {
          if (!Array.isArray(body.trackIds) || !body.trackIds.length) {
            return json(res, 400, { error: { code: "invalid_input", message: `action ${body.action} needs trackIds` } });
          }
          const tracks = await resolveTracks(deps, body.trackIds);
          if (!tracks.length) return json(res, 404, { error: { code: "unknown_track", message: "none of those track ids is known" } });
          const playback = body.action === "replace"
            ? deps.player.editQueue({ action: "replace", tracks })
            : deps.player.enqueue({ tracks, by: "person", ...(typeof body.position === "string" ? { position: body.position } : {}) });
          return json(res, 200, { playback });
        }
        const playback = deps.player.editQueue({
          action: body.action,
          ...(typeof body.queueItemId === "string" ? { queueItemId: body.queueItemId } : {}),
          ...(typeof body.index === "number" ? { index: body.index } : {}),
          ...(typeof body.to === "number" ? { to: body.to } : {}),
          ...(typeof body.expectedRevision === "number" ? { expectedRevision: body.expectedRevision } : {}),
        });
        return json(res, 200, { playback });
      }

      if (method === "POST" && path === "/api/music/stream") {
        if (!body || !Array.isArray(body.trackIds) || !body.trackIds.length) {
          return json(res, 400, { error: { code: "invalid_input", message: `mint a stream handle: {"trackIds": ["kugou:abc"], "quality": "320k"}` } });
        }
        const tracks = await resolveTracks(deps, body.trackIds);
        const quality = (body.quality ?? deps.player.snapshot().quality) as MusicQuality;
        const handles = [];
        for (const track of tracks) {
          try {
            const handle = await deps.stream.handleFor(track, quality);
            handles.push({ trackId: track.id, ...handle, url: `/api/music/stream/${encodeURIComponent(handle.handle)}` });
          } catch (error) {
            handles.push({
              trackId: track.id,
              error: {
                code: (error as { code?: string }).code ?? "source_unavailable",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
        return json(res, 200, { handles });
      }

      if (method === "GET" && path === "/api/music/lyrics") {
        const trackId = url.searchParams.get("trackId") ?? deps.player.snapshot().current?.track.id ?? "";
        if (!trackId) return json(res, 400, { error: { code: "invalid_input", message: "trackId is required when nothing is playing" } });
        const tracks = await resolveTracks(deps, [trackId]);
        const track = tracks[0];
        if (!track) return json(res, 404, { error: { code: "unknown_track", message: `no track "${trackId.slice(0, 80)}"` } });
        const localPath = track.source === "local" ? deps.local.lyricsPathFor(track.id) : null;
        if (localPath) {
          const { readFileSync } = await import("node:fs");
          const { parseLrcLines, toLyricLines } = await import("../music/kugou/lyrics.ts");
          return json(res, 200, { trackId, format: "lrc", lines: toLyricLines(parseLrcLines(readFileSync(localPath, "utf8"))), credits: [], unavailableReason: null });
        }
        if (track.source === "kugou") {
          return json(res, 200, await deps.lyrics.forTrack({
            trackId,
            ...(track.hash ? { hash: track.hash } : {}),
            keyword: [track.title, ...track.artists.slice(0, 1)].join(" "),
            durationSeconds: track.durationSeconds,
            ...(track.audioId ? { albumAudioId: track.audioId } : {}),
          }));
        }
        return json(res, 200, { trackId, format: "none", lines: [], credits: [], unavailableReason: "this track has no lyrics" });
      }

      if (method === "GET" && path === "/api/music/cover") {
        // A local cover is read through a handle, so the page never learns a path.
        const trackId = url.searchParams.get("trackId") ?? "";
        const coverPath = trackId ? deps.local.coverPathFor(trackId) : null;
        if (!coverPath) return json(res, 404, { error: { code: "not_found", message: "this track has no local cover" } });
        const { handle } = deps.stream.handleForFile(coverPath, "cover");
        return json(res, 200, { url: `/api/music/stream/${encodeURIComponent(handle)}` });
      }

      if (method === "GET" && path === "/api/music/search") {
        const keyword = (url.searchParams.get("q") ?? "").trim();
        if (!keyword) return json(res, 400, { error: { code: "invalid_input", message: "q is required, e.g. /api/music/search?q=晴天" } });
        const kind = url.searchParams.get("kind") ?? "track";
        const page = Number(url.searchParams.get("page") ?? 1);
        const pageSize = Number(url.searchParams.get("pageSize") ?? 20);
        if (kind === "playlist") return json(res, 200, await deps.catalogue.searchPlaylists({ keyword, page, pageSize }));
        if (kind === "album") return json(res, 200, await deps.catalogue.searchAlbums({ keyword, page, pageSize }));
        return json(res, 200, await deps.catalogue.searchTracks({ keyword, page, pageSize }));
      }

      if (method === "GET" && path === "/api/music/discover") {
        const kind = url.searchParams.get("kind") ?? "daily";
        const id = url.searchParams.get("id") ?? undefined;
        const page = Number(url.searchParams.get("page") ?? 1);
        switch (kind) {
          case "fm": return json(res, 200, { tracks: await deps.catalogue.privateFm() });
          case "rank":
            if (id) return json(res, 200, await deps.catalogue.rank(id, { page }));
            return json(res, 200, { ranks: await deps.catalogue.ranks() });
          case "scene":
            if (id) return json(res, 200, { tracks: await deps.catalogue.sceneTracks(id) });
            return json(res, 200, { scenes: await deps.catalogue.scenes() });
          case "artist": {
            if (!id) return json(res, 400, { error: { code: "invalid_input", message: "kind artist needs id" } });
            return json(res, 200, await deps.catalogue.artist(id));
          }
          case "album": {
            if (!id) return json(res, 400, { error: { code: "invalid_input", message: "kind album needs id" } });
            return json(res, 200, await deps.catalogue.album(id));
          }
          case "longaudio": return json(res, 200, await deps.catalogue.longAudio({ page }));
          case "cloud": return json(res, 200, await deps.catalogue.cloudTracks({ page }));
          default: {
            const daily = await deps.catalogue.dailyRecommendations();
            return json(res, 200, { tracks: daily.tracks, playlists: daily.playlists });
          }
        }
      }

      if (method === "GET" && path === "/api/music/comments") {
        const trackId = url.searchParams.get("trackId") ?? "";
        if (!trackId) return json(res, 400, { error: { code: "invalid_input", message: "trackId is required" } });
        return json(res, 200, await deps.catalogue.comments({ trackId, page: Number(url.searchParams.get("page") ?? 1) }));
      }

      if (method === "POST" && path === "/api/music/comments") {
        if (!body || typeof body.trackId !== "string" || typeof body.text !== "string") {
          return json(res, 400, { error: { code: "invalid_input", message: `a comment needs trackId and text: {"trackId": "kugou:abc", "text": "好歌"}` } });
        }
        return json(res, 200, { comment: await deps.catalogue.postComment(body.trackId, body.text) });
      }

      if (method === "GET" && path === "/api/music/history") {
        return json(res, 200, { entries: deps.store.history(Number(url.searchParams.get("limit") ?? 100)) });
      }

      if (method === "DELETE" && path === "/api/music/history") {
        deps.store.clearHistory();
        return json(res, 200, { cleared: true });
      }

      if (method === "GET" && path === "/api/music/favorites") {
        return json(res, 200, { tracks: deps.store.favorites() });
      }

      if (method === "POST" && path === "/api/music/favorites") {
        if (!body || typeof body.trackId !== "string") {
          return json(res, 400, { error: { code: "invalid_input", message: `{"trackId": "kugou:abc", "favorite": true}` } });
        }
        const track = (await resolveTracks(deps, [body.trackId]))[0];
        if (!track) return json(res, 404, { error: { code: "unknown_track", message: `no track "${String(body.trackId).slice(0, 80)}"` } });
        const favorite = body.favorite !== false;
        deps.store.setFavorite(track, favorite);
        if (track.source === "kugou") await deps.catalogue.favorite(track.id, favorite).catch(() => {});
        return json(res, 200, { trackId: track.id, favorite });
      }

      if (path === "/api/music/playlists") {
        if (method === "GET") return json(res, 200, { playlists: deps.store.playlists() });
        if (method === "POST") {
          if (!body || typeof body.name !== "string" || !body.name.trim()) {
            return json(res, 400, { error: { code: "invalid_input", message: `{"name": "深夜"}` } });
          }
          return json(res, 200, { playlist: deps.store.createPlaylist(body.name.trim()) });
        }
      }

      if (path.startsWith("/api/music/playlists/")) {
        const rest = path.slice("/api/music/playlists/".length);
        const slash = rest.indexOf("/");
        const playlistId = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
        const action = slash < 0 ? "" : rest.slice(slash + 1);
        if (method === "GET" && !action) {
          const playlist = deps.store.playlist(playlistId);
          if (playlist) return json(res, 200, { playlist, tracks: deps.store.playlistTracks(playlistId) });
          const remote = await deps.catalogue.playlistTracks(playlistId);
          return json(res, 200, { playlist: { playlistId, name: remote.name, local: false }, tracks: remote.tracks });
        }
        if (method === "PATCH" && !action) {
          if (!body || typeof body.name !== "string") return json(res, 400, { error: { code: "invalid_input", message: `{"name": "新名字"}` } });
          deps.store.renamePlaylist(playlistId, body.name);
          return json(res, 200, { playlist: deps.store.playlist(playlistId) });
        }
        if (method === "DELETE" && !action) {
          deps.store.deletePlaylist(playlistId);
          return json(res, 200, { deleted: playlistId });
        }
        if (method === "POST" && action === "tracks") {
          const trackIds = Array.isArray(body?.trackIds) ? body.trackIds.filter((id: unknown): id is string => typeof id === "string") : [];
          if (!trackIds.length) return json(res, 400, { error: { code: "invalid_input", message: `{"trackIds": ["kugou:abc"]}` } });
          const tracks = await resolveTracks(deps, trackIds);
          const added = deps.store.addToPlaylist(playlistId, tracks);
          return json(res, 200, { added, playlist: deps.store.playlist(playlistId) });
        }
        if (method === "DELETE" && action === "tracks") {
          const trackIds = Array.isArray(body?.trackIds) ? body.trackIds.filter((id: unknown): id is string => typeof id === "string") : [];
          if (!trackIds.length) return json(res, 400, { error: { code: "invalid_input", message: `{"trackIds": ["kugou:abc"]}` } });
          const removed = deps.store.removeFromPlaylist(playlistId, trackIds);
          return json(res, 200, { removed, playlist: deps.store.playlist(playlistId) });
        }
      }

      if (method === "GET" && path === "/api/music/library") {
        return json(res, 200, { folders: deps.store.localFolders(), tracks: deps.local.tracks(500) });
      }

      if (method === "POST" && path === "/api/music/library/scan") {
        deps.reloadLocal();
        return json(res, 200, { folders: deps.store.localFolders() });
      }

      if (method === "POST" && path === "/api/music/import") {
        if (!body || (body.platform !== "netease" && body.platform !== "qq") || typeof body.link !== "string") {
          return json(res, 400, { error: { code: "invalid_input", message: `{"platform": "netease", "link": "https://music.163.com/playlist?id=123"}` } });
        }
        return json(res, 200, await deps.importPlaylist({ platform: body.platform, link: body.link }));
      }

      if (method === "POST" && path === "/api/music/identify") {
        const contentType = String(req.headers["content-type"] ?? "");
        if (!contentType.startsWith("application/octet-stream") && !contentType.startsWith("audio/")) {
          return json(res, 415, { error: { code: "invalid_input", message: "send raw PCM as application/octet-stream" } });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).byteLength;
          if (size > MAX_IDENTIFY_BYTES) return json(res, 413, { error: { code: "invalid_input", message: "record at most 12 seconds" } });
          chunks.push(Buffer.from(chunk as Buffer));
        }
        const matches = await deps.identify(new Uint8Array(Buffer.concat(chunks)));
        return json(res, 200, { matches });
      }

      if (path === "/api/music/fm") {
        if (method === "GET") return json(res, 200, deps.fm());
        if (method === "POST") {
          const action = body && typeof body.action === "string" ? body.action : "start";
          const allowed = ["start", "next", "dislike", "previous", "mode", "pool", "reset"];
          if (!allowed.includes(action)) {
            return json(res, 400, { error: { code: "invalid_input", message: `action is one of ${allowed.join(", ")}` } });
          }
          try {
            const state = await deps.fmAction({ action, ...(Number.isFinite(body?.playedSeconds) ? { playedSeconds: Number(body.playedSeconds) } : {}) });
            return json(res, 200, state);
          } catch (error) {
            const message = error instanceof Error ? error.message : "the personal FM refused the change";
            return json(res, 502, { error: { code: "source_unavailable", message } });
          }
        }
      }

      if (method === "POST" && path === "/api/music/jellyfin/import") {
        const libraryId = body && typeof body.libraryId === "string" ? body.libraryId : "";
        if (!libraryId) return json(res, 400, { error: { code: "invalid_input", message: `{"libraryId": "<id from /api/music/jellyfin/libraries>"}` } });
        try {
          return json(res, 200, await deps.jellyfinImport(libraryId));
        } catch (error) {
          const message = error instanceof Error ? error.message : "the Jellyfin import failed";
          return json(res, 502, { error: { code: "source_unavailable", message } });
        }
      }

      if (method === "GET" && path === "/api/music/jellyfin/libraries") {
        const client = deps.jellyfin();
        if (!client) return json(res, 400, { error: { code: "invalid_input", message: "Jellyfin is not configured; set music.jellyfin in config first" } });
        try {
          return json(res, 200, { libraries: await client.libraries() });
        } catch (error) {
          const message = error instanceof Error ? error.message : "the Jellyfin server did not answer";
          return json(res, 502, { error: { code: "source_unavailable", message } });
        }
      }

      if (method === "GET" && path === "/api/music/connectivity") {
        return json(res, 200, await deps.connectivity());
      }

      if (method === "GET" && path === "/api/music/image") {
        const target = url.searchParams.get("url") ?? "";
        const image = target ? await deps.image(target) : null;
        if (!image) return json(res, 404, { error: { code: "not_found", message: "this cover could not be fetched; the URL's host is not allowed or the source did not answer" } });
        res.writeHead(200, { "content-type": image.mime, "cache-control": "private, max-age=86400" });
        res.end(image.body);
        return;
      }

      if (path === "/api/music/account") {
        if (method === "GET") return json(res, 200, { account: deps.account(), adapters: deps.adapters() });
        if (method === "DELETE") {
          deps.session.signOut();
          return json(res, 200, { account: deps.account() });
        }
      }

      if (method === "POST" && path === "/api/music/login/qr") {
        const qr = await deps.session.startQr();
        return json(res, 200, { qr });
      }

      if (method === "GET" && path === "/api/music/login/qr") {
        const key = url.searchParams.get("key") ?? "";
        if (!key) return json(res, 400, { error: { code: "invalid_input", message: "key is required, from POST /api/music/login/qr" } });
        return json(res, 200, await deps.session.pollQr(key));
      }

      if (method === "POST" && path === "/api/music/login/sms") {
        if (!body || typeof body.mobile !== "string") {
          return json(res, 400, { error: { code: "invalid_input", message: `{"mobile": "13800000000"}` } });
        }
        await deps.session.sendSmsCode(body.mobile);
        return json(res, 200, { sent: true });
      }

      if (method === "POST" && path === "/api/music/login/code") {
        if (!body || typeof body.mobile !== "string" || typeof body.code !== "string") {
          return json(res, 400, { error: { code: "invalid_input", message: `{"mobile": "13800000000", "code": "123456"}` } });
        }
        const session = await deps.session.loginWithCode(body.mobile, body.code, typeof body.userId === "string" ? body.userId : undefined);
        return json(res, 200, { account: deps.account(), nickname: session.nickname });
      }

      if (path === "/api/music/eq") {
        if (method === "GET") return json(res, 200, { eq: deps.eq() });
        if (method === "PUT" || method === "POST") return json(res, 200, { eq: deps.setEq(body) });
      }

      if (path === "/api/music/theme") {
        if (method === "GET") return json(res, 200, { theme: deps.theme() });
        if (method === "PUT" || method === "POST") {
          if (!body || typeof body.theme !== "string") return json(res, 400, { error: { code: "invalid_input", message: `{"theme": "fume"}` } });
          deps.setTheme(body.theme);
          return json(res, 200, { theme: deps.theme() });
        }
      }

      if (method === "GET" && path === "/api/music/focus") {
        return json(res, 200, { lease: deps.focus.activeLease(), ducked: deps.focus.ducked() });
      }

      // Speech claims the speaker so music ducks; the release says whether music may come back.
      if (method === "POST" && path === "/api/music/focus") {
        const action = body?.action;
        if (action === "claim") {
          const lease = deps.focus.claim("speech", typeof body.holder === "string" ? body.holder : "speech", typeof body.ttlMs === "number" ? body.ttlMs : undefined);
          return json(res, 200, { lease });
        }
        if (action === "release") {
          if (typeof body.leaseId !== "string") return json(res, 400, { error: { code: "invalid_input", message: `release needs the leaseId the claim returned` } });
          deps.focus.release(body.leaseId);
          return json(res, 200, { released: true, ducked: deps.focus.ducked() });
        }
        return json(res, 400, { error: { code: "invalid_input", message: `action must be "claim" or "release"` } });
      }

      return json(res, 404, { error: { code: "not_found", message: "no such music endpoint" } });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "source_unavailable";
      const status = code === "stale_revision" ? 409
        : code === "not_logged_in" || code === "expired_session" ? 401
        : code === "vip_required" ? 402
        : code === "risk_control" ? 403
        : code === "not_found" || code === "unknown_track" || code === "unknown_playlist" ? 404
        : code === "unsupported_format" ? 415
        : code === "unreachable" ? 502
        : 400;
      return json(res, status, { error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  };
}

/** Resolves ids from the queue, the library or a fresh search, in that order. */
async function resolveTracks(deps: MusicRouteDeps, ids: readonly string[]) {
  const tracks = [];
  const queue = deps.player.snapshot().queue;
  const favorites = deps.store.favorites();
  const library = deps.local.tracks(2_000);
  for (const id of ids) {
    const fromQueue = queue.find((item: { track: MusicTrack }) => item.track.id === id);
    if (fromQueue) { tracks.push(fromQueue.track); continue; }
    const fromFavorite = favorites.find((track: MusicTrack) => track.id === id);
    if (fromFavorite) { tracks.push(fromFavorite); continue; }
    const fromLibrary = library.find((track: MusicTrack) => track.id === id);
    if (fromLibrary) { tracks.push(fromLibrary); continue; }
    // A fresh id from a search result is not stored anywhere yet; recover it.
    const hash = id.replace(/^kugou:/, "");
    if (hash && hash !== id) {
      try {
        const result = await deps.catalogue.searchTracks({ keyword: hash, pageSize: 5 });
        const hit = result.tracks.find((track: MusicTrack) => track.hash === hash || track.id === id);
        if (hit) tracks.push(hit);
      } catch { /* the caller reports the id as missing */ }
    }
  }
  return tracks;
}
