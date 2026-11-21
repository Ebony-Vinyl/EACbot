// The music domain wired once by server/index.ts: the Kugou client, the local and
// Jellyfin sources, the player, the audio focus coordinator and the internal MCP
// route. Everything a vendor knows lives behind this file, so the view and the bot
// tools see one contract and one state.

import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { PromptPart } from "../system-prompt.ts";
import { createMusicRoutes } from "../routes/music.ts";
import type { RouteHandler } from "../routes/table.ts";
import {
  bestQuality,
  MUSIC_QUALITY_RANK,
  NOW_PLAYING_THEMES,
  type MusicAccount,
  type MusicAdapterSummary,
  type MusicEq,
  type MusicLyricFormat,
  type MusicLyrics,
  type MusicPlaylist,
  type MusicQuality,
  type MusicSnapshot,
  type MusicTrack,
  type NowPlayingTheme,
} from "../../shared/music.ts";
import { defaultEq, EQ_SETTING_KEY, normaliseEq } from "./eq.ts";
import { createMusicFocus, type MusicFocus } from "./focus.ts";
import { createPlaylistImporter, parsePlaylistId, type ImportPlatform } from "./import.ts";
import { createJellyfinClient, jellyfinLabel, type JellyfinClient } from "./jellyfin.ts";
import { createPersonalFm, type FmSessionState } from "./kugou/fm.ts";
import { createKugouCatalogue, type KugouCatalogue } from "./kugou/catalog.ts";
import { createLyricParseCache, onlineLyricIdentity, fileLyricIdentity } from "./kugou/lyricCache.ts";
import { createKugouLyricsClient, type KugouLyricsClient } from "./kugou/lyrics.ts";
import { parseLyricsByExtension, toLyricLines } from "./kugou/lyrics.ts";
import { createVipEntitlement } from "./kugou/vip.ts";
import { createKugouMatchClient } from "./kugou/match.ts";
import { createKugouSessionManager, type KugouSessionManager } from "./kugou/session.ts";
import { createKugouTransport, KugouError, type KugouTransport } from "./kugou/transport.ts";
import { createImageCache } from "./imageCache.ts";
import { createLocalLibrary, type LocalLibrary } from "./local.ts";
import { createPlayer, type Player } from "./player.ts";
import { createFilePlayerPort } from "./player-state.ts";
import { MUSIC_INTERNAL_MCP_PATH, musicRpc, musicToolNeedsControl, type MusicToolsList } from "./rpc.ts";
import { MusicStore } from "./store.ts";
import { createMusicStream, type MusicStream } from "./stream.ts";
import { MUSIC_INSTRUCTIONS, type MusicToolResult } from "./tools.ts";

export const MUSIC_MCP_SERVER = "music";

type Turn = { botId: string; threadId: string; generation: string };

/** What a bot may do with the player. */
export type MusicAccessLevel = "off" | "read" | "control";

/** `music` in config.json. Credentials live in music-session.json, never here. */
export interface MusicConfig {
  botAccess?: MusicAccessLevel;
  defaultQuality?: MusicQuality;
  duckVolume?: number;
  crossfadeMs?: number;
  desktopLyrics?: boolean;
  closeToTray?: boolean;
  nowPlayingTheme?: NowPlayingTheme;
  localFolders?: string[];
  jellyfin?: { baseUrl: string; apiKey: string; userId?: string };
}

export interface MusicHostDeps {
  dataDir: string;
  config(): MusicConfig | undefined;
  /** One bot's access; absent means the config default. */
  botAccess(botId: string): MusicAccessLevel;
  active(turn: Turn): boolean;
  ownerOrAdmin(auth: { kind?: string }): boolean;
  mint(turn: Turn): string;
  harnessUrl: string;
  /** Asks the person to confirm a destructive action on this turn. */
  confirm?(turn: Turn, question: string): Promise<boolean>;
  /** Broadcasts one frame to every connected client. */
  broadcast(frame: unknown): void;
  now?: () => string;
  /** Injected in tests so a fake server stands in for Kugou. */
  transport?: KugouTransport;
  fetch?: typeof fetch;
}

export interface MusicHost {
  player: Player;
  store: MusicStore;
  session: KugouSessionManager;
  catalogue: KugouCatalogue;
  lyrics: KugouLyricsClient;
  local: LocalLibrary;
  stream: MusicStream;
  focus: MusicFocus;
  routes: RouteHandler;
  /** Rebuilds the sources from config; called when config.json changes. */
  reload(): void;
  integration(turn: Turn): { command: string; args: string[]; env: Record<string, string> } | null;
  /** Adds the MCP mount to a turn's integration table when this bot may use it. */
  mount(integrations: { music?: { command: string; args: string[]; env: Record<string, string> } }, turn: Turn): void;
  /** The configStatus slice this domain contributes; keys stay write-only. */
  status(): Record<string, unknown>;
  parts(turn: Turn, botId: string): PromptPart[];
  withheld(turn: Turn, botId: string): string;
  /** One line on what is playing, for a scheduled check that has to judge it. Empty when off. */
  nowFor(turn: Turn): Promise<string>;
  handle(body: unknown, capability: Turn, assertActive: () => void): Promise<MusicToolsList | MusicToolResult>;
  toolListing(): Array<{ name: string; description: string }>;
  snapshot(): Promise<MusicSnapshot>;
  eq(): MusicEq;
  setEq(input: unknown): MusicEq;
  theme(): NowPlayingTheme;
  setTheme(theme: NowPlayingTheme): void;
  jellyfin(): JellyfinClient | null;
  /** Imports a playlist from NetEase or QQ into a playlist this server owns. */
  importPlaylist(input: { platform: ImportPlatform; link: string }): Promise<{ playlist: MusicPlaylist; matched: number; unmatched: number }>;
  /** The personal FM session, as the view and the tools read it. */
  fm(): FmSessionState;
  jellyfinLibraries(): Promise<Array<{ libraryId: string; name: string; collectionType: string | null }>>;
  /** Imports one Jellyfin music library as one playlist per album, like upstream's JellyfinLibrary kind. */
  jellyfinImport(libraryId: string): Promise<{ playlistId: string; name: string; albums: number; tracks: number; removed: number }>;
  fmAction(input: { action: "start" | "next" | "dislike" | "previous" | "mode" | "pool" | "reset"; playedSeconds?: number }): Promise<FmSessionState>;
  connectivity(): Promise<{ online: boolean }>;
  dispose(): Promise<void>;
}

function qualityForAccount(account: MusicAccount): MusicQuality {
  if (!account.loggedIn) return "128k";
  return account.entitledQuality;
}

export function createMusicHost(deps: MusicHostDeps): MusicHost {
  const now = deps.now ?? (() => new Date().toISOString());
  const transport = deps.transport ?? createKugouTransport(deps.fetch ? { fetch: deps.fetch } : {});
  const store = new MusicStore({ dataDir: deps.dataDir, now });
  const session = createKugouSessionManager({
    dataDir: deps.dataDir,
    transport,
    changed: () => {
      // A sign-in or sign-out changes what every client may play.
      deps.broadcast({ kind: "music.account", account: accountFor() });
    },
  });
  const catalogue = createKugouCatalogue({
    transport,
    device: () => {
      const device = session.device();
      return { ...device, entitledQuality: qualityForAccount(accountFor()) };
    },
  });
  const lyrics = createKugouLyricsClient({ transport });
  const lyricCache = createLyricParseCache(deps.dataDir);
  const vip = createVipEntitlement({ transport, session });
  const fm = createPersonalFm({
    transport,
    device: () => ({ ...session.device(), vipType: session.current()?.vipType ?? null }),
  });
  const match = createKugouMatchClient({ transport, device: () => session.device() });
  const local = createLocalLibrary({ store, now });
  const imageCache = createImageCache({
    dataDir: deps.dataDir,
    allowedHosts: () => {
      const hosts = ["kugou.com", "kgimg.cn", "kgimg.com"];
      try {
        hosts.push(new URL(deps.config()?.jellyfin?.baseUrl ?? "https://jellyfin.invalid").hostname);
      } catch {
        // A malformed Jellyfin URL simply leaves its host off the list.
      }
      return hosts;
    },
  });

  // One recovery attempt per minute, one at a time: a refresh plus the daily VIP
  // claim, then the caller retries the resolution once. Local sources never recover.
  const RECOVERY_COOLDOWN_MS = 60_000;
  let lastRecoveryAt = 0;
  let recoveryInFlight: Promise<boolean> | null = null;
  const attemptRecovery = (): Promise<boolean> => {
    const at = Date.parse(now());
    if (at - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return Promise.resolve(false);
    recoveryInFlight ??= (async () => {
      lastRecoveryAt = at;
      try {
        await session.refresh();
        await session.refreshVip().catch(() => {});
        await vip.ensureDailyVip().catch(() => false);
        return true;
      } catch {
        return false;
      } finally {
        recoveryInFlight = null;
      }
    })();
    return recoveryInFlight;
  };

  /** Upstream's quality ladder: the track's own privilege tree picks the best tier at or under the ask. */
  const resolveKugou = async (track: MusicTrack, quality: MusicQuality): Promise<string> => {
    if (!track.hash) throw new KugouError("not_found", "this track has no Kugou file hash", false);
    let effective = quality;
    try {
      const supported = await catalogue.privilegeQualities(track.hash, track.albumId);
      if (supported.length) effective = bestQuality(quality, supported) ?? quality;
    } catch {
      // A privilege failure is not a playback failure: ask with what was requested.
    }
    try {
      const result = await catalogue.playUrl({ hash: track.hash, albumId: track.albumId, audioId: track.audioId, quality: effective });
      return result.url;
    } catch (error) {
      const recoverable = (track.source === "kugou" || track.source === "cloud") && Boolean(session.current()?.token);
      if (!recoverable) throw error;
      const recovered = await attemptRecovery();
      if (!recovered) throw error;
      const retry = await catalogue.playUrl({ hash: track.hash, albumId: track.albumId, audioId: track.audioId, quality: effective });
      return retry.url;
    }
  };
  let jellyfinClient: JellyfinClient | null = null;

  const rebuildJellyfin = (): void => {
    const config = deps.config()?.jellyfin;
    jellyfinClient = config?.baseUrl && config.apiKey
      ? createJellyfinClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, ...(config.userId ? { userId: config.userId } : {}) })
      : null;
  };
  rebuildJellyfin();

  const stream = createMusicStream({
    kugouUrl: resolveKugou,
    cloudUrl: async (track) => catalogue.cloudUrl({ hash: track.hash ?? "", albumAudioId: track.albumId, audioId: track.audioId, name: track.title }),
    localPath: (trackId) => local.pathFor(trackId),
    jellyfinUrl: (trackId) => {
      const itemId = trackId.replace(/^jellyfin:/, "");
      return jellyfinClient ? jellyfinClient.streamUrl(itemId) : null;
    },
    loginRequired: () => !session.current()?.token,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  const player = createPlayer(createFilePlayerPort(deps.dataDir), {
    now,
    entitledQuality: () => qualityForAccount(accountFor()),
    preferredQuality: () => deps.config()?.defaultQuality ?? store.quality(),
    changed: (playback) => deps.broadcast({ kind: "music.state", playback }),
    played: (track) => {
      store.recordPlay(track, 0, "person", session.current()?.userId ?? "");
    },
    endedPlayed: (track, playedSeconds) => {
      store.recordPlay(track, playedSeconds, "person", session.current()?.userId ?? "");
      void catalogue.reportPlay(track, playedSeconds).catch(() => {});
    },
  });

  const focus = createMusicFocus({
    setDucked: (ducked) => player.setDucked(ducked),
    musicPlaying: () => player.snapshot().state === "playing",
    now: () => Date.parse(now()),
  });

  /** The account, as the view reads it. The token stays in this process. */
  const accountFor = (): MusicAccount => {
    const current = session.current();
    if (!current?.token) {
      return { loggedIn: false, userId: null, nickname: null, avatarUrl: null, vip: false, vipLabel: null, entitledQuality: "128k" };
    }
    return {
      loggedIn: true,
      userId: current.userId,
      nickname: current.nickname,
      avatarUrl: current.avatarUrl,
      vip: current.vip,
      vipLabel: current.vipLabel,
      entitledQuality: current.entitledQuality,
    };
  };

  /** The catalogue surface the tools call, wired to the real sources. */
  const toolCatalogue = {
    async search(input: { keyword: string; kind: "track" | "playlist" | "album"; page?: number; pageSize?: number }) {
      if (input.kind === "playlist") return catalogue.searchPlaylists(input);
      if (input.kind === "album") return catalogue.searchAlbums(input);
      return catalogue.searchTracks(input);
    },
    playUrl: async (track: MusicTrack, quality: MusicQuality) => {
      const handle = await stream.handleFor(track, quality);
      return handle;
    },
    async lyrics(track: MusicTrack): Promise<MusicLyrics> {
      const localPath = local.lyricsPathFor(track.id);
      if (localPath) {
        try {
          const { readFileSync, statSync } = await import("node:fs");
          const ext = (localPath.split(".").pop() ?? "lrc").toLowerCase();
          const stats = statSync(localPath);
          const identity = fileLyricIdentity(localPath, stats.size, stats.mtimeMs, ext);
          const cached = lyricCache.read(identity);
          const format = (["lrc", "krc", "qrc", "yrc", "vtt"].includes(ext) ? ext : "lrc") as MusicLyricFormat;
          if (cached) return { trackId: track.id, format, lines: cached, credits: [], unavailableReason: null };
          const body = readFileSync(localPath, "utf8");
          const raw = parseLyricsByExtension(body, ext);
          if (raw.length) {
            const lines = toLyricLines(raw);
            lyricCache.write(identity, lines);
            return { trackId: track.id, format, lines, credits: [], unavailableReason: null };
          }
        } catch {
          // Fall through to the online lookup.
        }
      }
      if (track.source === "kugou" && (track.hash || track.title)) {
        const identity = onlineLyricIdentity(track.id, track.hash ?? track.title, String(track.durationSeconds));
        const cached = lyricCache.read(identity);
        if (cached) return { trackId: track.id, format: "krc", lines: cached, credits: [], unavailableReason: null };
        const answer = await lyrics.forTrack({
          trackId: track.id,
          ...(track.hash ? { hash: track.hash } : {}),
          keyword: [track.title, ...track.artists.slice(0, 1)].join(" "),
          durationSeconds: track.durationSeconds,
          ...(track.audioId ? { albumAudioId: track.audioId } : {}),
        });
        if (answer.lines.length) lyricCache.write(identity, answer.lines);
        return answer;
      }
      return { trackId: track.id, format: "none", lines: [], credits: [], unavailableReason: "this track has no lyrics" };
    },
    async recommend(input: { kind: string; id?: string; page?: number; playedSeconds?: number }) {
      switch (input.kind) {
        case "fm": {
          const state = fm.state();
          return state.active ? state : await fm.start();
        }
        case "fm_next": return fm.next(input.playedSeconds);
        case "fm_dislike": return fm.dislike();
        case "fm_previous": return fm.previous();
        case "fm_mode": return fm.cycleMode();
        case "fm_pool": return fm.togglePool();
        case "rank": {
          if (input.id) return catalogue.rank(input.id, input.page ? { page: input.page } : {});
          const ranks = await catalogue.ranks();
          return { ranks };
        }
        case "scene": {
          if (input.id) return { tracks: await catalogue.sceneTracks(input.id) };
          return { scenes: await catalogue.scenes() };
        }
        case "artist": {
          if (!input.id) throw new KugouError("invalid_input", `kind artist needs id, from MUSIC_SEARCH with kind track's artist page`, false);
          return catalogue.artist(input.id);
        }
        case "album": {
          if (!input.id) throw new KugouError("invalid_input", "kind album needs id", false);
          return catalogue.album(input.id);
        }
        case "longaudio": return catalogue.longAudio(input.page ? { page: input.page } : {});
        case "cloud": return catalogue.cloudTracks(input.page ? { page: input.page } : {});
        default: {
          const daily = await catalogue.dailyRecommendations();
          return { tracks: daily.tracks, playlists: daily.playlists };
        }
      }
    },
    favorite: (track: MusicTrack, favorite: boolean) => catalogue.favorite(track.id, favorite),
    playlists: (kind: "created" | "collected") => catalogue.playlists(kind),
    playlistTracks: (playlistId: string) => catalogue.playlistTracks(playlistId),
    createPlaylist: (name: string) => catalogue.createPlaylist(name),
    addToPlaylist: async (playlistId: string, tracks: readonly MusicTrack[]) => {
      await catalogue.addToPlaylist(playlistId, tracks.map((track) => track.hash ?? track.id));
    },
    removeFromPlaylist: async (playlistId: string, trackIds: readonly string[]) => {
      await catalogue.removeFromPlaylist(playlistId, trackIds);
    },
    async tracksByIds(ids: readonly string[]): Promise<MusicTrack[]> {
      const found: MusicTrack[] = [];
      const kugouIds: string[] = [];
      for (const id of ids) {
        if (id.startsWith("local:")) {
          const row = store.localTracks().find((entry) => entry.track.id === id);
          if (row) found.push(row.track);
        } else if (id.startsWith("jellyfin:")) {
          // A Jellyfin track's own fields came from the source; a queue entry needs them again.
          const itemId = id.slice("jellyfin:".length);
          if (jellyfinClient) {
            try {
              const result = await jellyfinClient.tracks({ limit: 1, search: "" });
              const hit = result.tracks.find((track) => track.audioId === itemId);
              if (hit) found.push(hit);
            } catch { /* the queue simply lacks it */ }
          }
        } else {
          kugouIds.push(id);
        }
      }
      if (kugouIds.length) {
        const fromQueue = player.snapshot().queue
          .filter((item: { track: MusicTrack }) => kugouIds.includes(item.track.id))
          .map((item: { track: MusicTrack }) => item.track);
        found.push(...fromQueue);
        const missing = kugouIds.filter((id) => !fromQueue.some((track: MusicTrack) => track.id === id));
        if (missing.length) {
          const cached = store.favorites().filter((track: MusicTrack) => missing.includes(track.id));
          found.push(...cached);
          const stillMissing = missing.filter((id) => !cached.some((track: MusicTrack) => track.id === id));
          // A track from a search result is not stored; a queue-add by id alone cannot recover its metadata.
          if (stillMissing.length) {
            const recovered = await recoverTracks(stillMissing);
            found.push(...recovered);
          }
        }
      }
      const seen = new Set<string>();
      return found.filter((track) => (seen.has(track.id) ? false : (seen.add(track.id), true)));
    },
    async identify(input: { durationSeconds: number }) {
      // The recording is handed in through the HTTP route, not the tool: a tool call cannot carry audio.
      void input;
      throw new KugouError("invalid_input", "identification needs a recording; open the music page and use Listen, or POST the audio to /api/music/identify", false);
    },
    async radio(input: { mood: string; minutes: number }): Promise<MusicTrack[]> {
      // A mood is a search phrase, refined by what the person said they like.
      const preferences = store.preferences({ scope: "global" })
        .filter((entry) => entry.kind === "stated")
        .map((entry) => entry.value);
      const keyword = input.mood || preferences[0] || "轻音乐";
      const result = await catalogue.searchTracks({ keyword, pageSize: 50 });
      if (result.tracks.length) return result.tracks;
      const daily = await catalogue.dailyRecommendations();
      return daily.tracks;
    },
  };

  /** A track id from a previous turn is not in memory; recover it from the queue, favourites or a search. */
  async function recoverTracks(ids: readonly string[]): Promise<MusicTrack[]> {
    const recovered: MusicTrack[] = [];
    for (const id of ids) {
      const hash = id.replace(/^kugou:/, "");
      if (!hash) continue;
      try {
        const result = await catalogue.searchTracks({ keyword: hash, pageSize: 5 });
        const hit = result.tracks.find((track) => track.hash === hash || track.id === id);
        if (hit) recovered.push(hit);
      } catch {
        // A failed recovery leaves the track out; the caller reports it missing.
      }
    }
    return recovered;
  }

  const importer = createPlaylistImporter({ transport });

  const adapters = (): MusicAdapterSummary[] => {
    const account = accountFor();
    const list: MusicAdapterSummary[] = [{
      adapterId: "kugou",
      label: account.loggedIn ? `Kugou · ${account.nickname ?? account.userId}` : "Kugou",
      kind: "kugou",
      status: account.loggedIn ? "ready" : "logged_out",
      ...(account.loggedIn ? {} : { statusReason: "sign in to play online tracks" }),
      trackCount: 0,
    }];
    const localCount = store.localTrackCount();
    list.push({
      adapterId: "local",
      label: "Local files",
      kind: "local",
      status: (deps.config()?.localFolders ?? []).length ? "ready" : "disabled",
      ...((deps.config()?.localFolders ?? []).length ? {} : { statusReason: "add a folder to import your own files" }),
      trackCount: localCount,
    });
    if (jellyfinClient && deps.config()?.jellyfin?.baseUrl) {
      list.push({ adapterId: "jellyfin", label: jellyfinLabel(deps.config()!.jellyfin!.baseUrl), kind: "jellyfin", status: "ready", trackCount: 0 });
    }
    return list;
  };

  const snapshot = async (): Promise<MusicSnapshot> => ({
    playback: player.snapshot(),
    account: accountFor(),
    adapters: adapters(),
    playlists: store.playlists(),
    at: now(),
  });

  const accessFor = (botId: string): MusicAccessLevel => deps.botAccess(botId);

  const runFmAction = async (input: { action: string; playedSeconds?: number }): Promise<FmSessionState> => {
    switch (input.action) {
      case "next": return fm.next(input.playedSeconds);
      case "dislike": return fm.dislike();
      case "previous": return fm.previous();
      case "mode": return fm.cycleMode();
      case "pool": return fm.togglePool();
      case "reset": return fm.reset();
      default: {
        const state = fm.state();
        return state.active ? state : await fm.start();
      }
    }
  };

  const runConnectivity = async (): Promise<{ online: boolean }> => {
    const probe = async (url: string): Promise<boolean> => {
      try {
        const response = await (deps.fetch ?? fetch)(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(5_000) });
        return response.status >= 200 && response.status < 400;
      } catch {
        return false;
      }
    };
    const online = await Promise.all([probe("https://www.kugou.com/"), probe("https://www.baidu.com/")]);
    return { online: online.some(Boolean) };
  };

  const runJellyfinImport = async (libraryId: string) => {
    const client = jellyfinClient;
    if (!client) throw new KugouError("invalid_input", "Jellyfin is not configured; set music.jellyfin in config first", false);
    const albums = await client.albums({ limit: 500 });
    const existing = store.playlists().find((playlist) => playlist.kind === "jellyfin" && playlist.sourceId === libraryId);
    const playlist = existing ?? store.createPlaylist("Jellyfin music", "jellyfin");
    store.setPlaylistSource(playlist.playlistId, libraryId);
    // One row per album, rebuilt wholesale on refresh like upstream's folder imports.
    store.clearPlaylistTracks(playlist.playlistId);
    let trackCount = 0;
    let albumCount = 0;
    for (const album of albums) {
      if (!album.albumId) continue;
      const tracks = await client.albumTracks(album.albumId);
      if (!tracks.length) continue;
      albumCount += 1;
      trackCount += tracks.length;
      store.addToPlaylist(playlist.playlistId, tracks);
    }
    return { playlistId: playlist.playlistId, name: "Jellyfin music", albums: albumCount, tracks: trackCount, removed: 0 };
  };

  return {
    player,
    store,
    session,
    catalogue,
    lyrics,
    local,
    stream,
    focus,

    routes: createMusicRoutes({
      snapshot,
      player,
      store,
      stream,
      catalogue,
      lyrics,
      local,
      session,
      focus,
      adapters,
      account: accountFor,
      mayManage: (auth) => deps.ownerOrAdmin(auth),
      eq: () => eqValue(),
      setEq: (input) => setEqValue(input),
      theme: () => themeValue(),
      setTheme: (theme) => setThemeValue(theme),
      importPlaylist: (input) => hostImport(input),
      identify: async (pcm) => match.identify(pcm),
      jellyfin: () => jellyfinClient,
      config: () => deps.config(),
      reloadLocal: () => {
        for (const folder of deps.config()?.localFolders ?? []) {
          local.scan(folder);
        }
      },
      changed: (playback) => deps.broadcast({ kind: "music.state", playback }),
      image: (url: string) => imageCache.get(url),
      fm: () => fm.state(),
      fmAction: (input) => runFmAction(input),
      connectivity: () => runConnectivity(),
      jellyfinImport: (libraryId) => runJellyfinImport(libraryId),
    }),

    reload() {
      rebuildJellyfin();
    },

    integration(turn) {
      if (!deps.active(turn) || accessFor(turn.botId) === "off") return null;
      return {
        command: process.execPath,
        args: [SPAWNED_PROXIES.harnessMcp, MUSIC_MCP_SERVER],
        env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("music")]: deps.mint(turn), EAC_HARNESS_URL: deps.harnessUrl },
      };
    },

    mount(integrations, turn) {
      const server = this.integration(turn);
      if (server) integrations.music = server;
    },

    fm() {
      return fm.state();
    },

    fmAction: (input) => runFmAction(input),

    async jellyfinLibraries() {
      const client = jellyfinClient;
      if (!client) throw new KugouError("invalid_input", "Jellyfin is not configured; set music.jellyfin in config first", false);
      return client.libraries();
    },

    jellyfinImport: (libraryId) => runJellyfinImport(libraryId),

    connectivity: () => runConnectivity(),

    status() {
      return {
        configured: Boolean(deps.config()),
        loggedIn: session.signedIn(),
        nickname: session.current()?.nickname ?? null,
        vip: session.current()?.vip === true,
        theme: themeValue(),
        defaultQuality: deps.config()?.defaultQuality ?? "320k",
      };
    },

    parts(turn, botId) {
      if (!deps.active(turn)) return [];
      const access = accessFor(botId);
      if (access === "off") return [];
      const account = accountFor();
      const lines = [MUSIC_INSTRUCTIONS, `Your music access is "${access}".`];
      if (access === "read") lines.push("You can read the player and the catalogue but not change what plays.");
      if (!account.loggedIn) lines.push("Nobody is signed in to Kugou, so only local files and the person's own folders can play.");
      return [{ id: "music", label: "Music", text: lines.join(" ") }];
    },

    withheld(turn, botId) {
      if (!deps.active(turn) || accessFor(botId) !== "off") return "";
      return "This bot's music access is off, so you cannot search, queue or control the player here.";
    },

    async nowFor(turn) {
      if (!deps.active(turn) || accessFor(turn.botId) === "off") return "";
      const playback = player.snapshot();
      if (!playback.current) return "";
      const track = playback.current.track;
      const label = track.artists.length ? `${track.title} — ${track.artists.join(", ")}` : track.title;
      const state = playback.playbackConfirmed ? playback.state : `${playback.state} (unconfirmed)`;
      return `Music: ${label}, ${state} at ${Math.round(playback.positionSeconds)}s, ${playback.queue.length} in the queue.`;
    },

    toolListing: () => MUSIC_TOOL_LIST,

    async handle(body, capability, assertActive) {
      const turn = { botId: capability.botId, threadId: capability.threadId, generation: capability.generation };
      const access = accessFor(capability.botId);
      return musicRpc(body as { method?: unknown; params?: unknown }, {
        player,
        store,
        catalogue: toolCatalogue,
        botId: capability.botId,
        assertActive,
        allowed: (name) => {
          if (!deps.active(turn) || access === "off") return false;
          if (access === "read" && musicToolNeedsControl(name)) return false;
          return true;
        },
        ...(deps.confirm ? { confirm: (question) => deps.confirm!(turn, question) } : {}),
      });
    },

    snapshot,

    eq: () => eqValue(),
    setEq: (input) => setEqValue(input),
    theme: () => themeValue(),
    setTheme: (theme) => setThemeValue(theme),
    jellyfin: () => jellyfinClient,

    async importPlaylist(input) {
      const id = parsePlaylistId(input.platform, input.link);
      if (!id) throw new KugouError("invalid_input", `paste the playlist's share link or its id, e.g. https://music.163.com/playlist?id=123456789`, false);
      const preview = await importer.preview(input.platform, id);
      const result = await importer.match(preview, async (query) => (await catalogue.searchTracks({ keyword: query, pageSize: 10 })).tracks);
      const playlist = store.createPlaylist(preview.name);
      store.addToPlaylist(playlist.playlistId, result.matched);
      return { playlist: store.playlist(playlist.playlistId) ?? playlist, matched: result.matched.length, unmatched: result.unmatched.length };
    },

    dispose: async () => {
      focus.dispose();
      store.close();
    },
  };

  function eqValue(): MusicEq {
    const stored = store.setting(EQ_SETTING_KEY);
    if (!stored) return defaultEq();
    try {
      return normaliseEq(JSON.parse(stored));
    } catch {
      return defaultEq();
    }
  }

  function setEqValue(input: unknown): MusicEq {
    const eq = normaliseEq(input);
    store.putSetting(EQ_SETTING_KEY, JSON.stringify(eq));
    deps.broadcast({ kind: "music.eq", eq });
    return eq;
  }

  function themeValue(): NowPlayingTheme {
    const stored = store.setting("theme");
    return NOW_PLAYING_THEMES.includes(stored as NowPlayingTheme) ? stored as NowPlayingTheme : "standard";
  }

  function setThemeValue(theme: NowPlayingTheme): void {
    if (!NOW_PLAYING_THEMES.includes(theme)) return;
    store.putSetting("theme", theme);
    deps.broadcast({ kind: "music.theme", theme });
  }

  async function hostImport(input: { platform: ImportPlatform; link: string }) {
    const id = parsePlaylistId(input.platform, input.link);
    if (!id) throw new KugouError("invalid_input", "paste the playlist's share link or its id", false);
    const preview = await importer.preview(input.platform, id);
    const result = await importer.match(preview, async (query) => (await catalogue.searchTracks({ keyword: query, pageSize: 10 })).tracks);
    const playlist = store.createPlaylist(preview.name);
    store.addToPlaylist(playlist.playlistId, result.matched);
    return { playlist: store.playlist(playlist.playlistId) ?? playlist, matched: result.matched.length, unmatched: result.unmatched.length };
  }
}

const MUSIC_TOOL_LIST = [
  { name: "MUSIC_SEARCH", description: "Search Kugou for songs, playlists or albums." },
  { name: "MUSIC_PLAY", description: "Queue tracks and request playback." },
  { name: "MUSIC_CONTROL", description: "Pause, resume, skip, seek, volume, quality, repeat, shuffle." },
  { name: "MUSIC_QUEUE", description: "Read or edit the queue." },
  { name: "MUSIC_NOW_PLAYING", description: "The player's state, with playbackConfirmed." },
  { name: "MUSIC_LYRICS", description: "Timed lyrics for a track." },
  { name: "MUSIC_PLAYLIST", description: "Read or edit playlists." },
  { name: "MUSIC_RECOMMEND", description: "Daily, FM, charts, scenes, artist, album, long audio, cloud." },
  { name: "MUSIC_FAVORITE", description: "Read or change favourites." },
  { name: "MUSIC_PLAN", description: "Build a queue for a stretch of time." },
  { name: "MUSIC_IDENTIFY", description: "Identify what is playing." },
  { name: "MUSIC_PREFERENCES", description: "Read or change music preferences." },
];

export { MUSIC_INTERNAL_MCP_PATH, bestQuality, MUSIC_QUALITY_RANK };
