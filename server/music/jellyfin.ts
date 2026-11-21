// Jellyfin as a music source: a plain REST adapter over the user's own server.
// It returns the same MusicTrack shape every other source does, so the player,
// the views and the tools never branch on which server a track lives on.
import type { MusicAlbum, MusicTrack } from "../../shared/music.ts";
import { KugouError } from "./kugou/transport.ts";

/** Jellyfin wants its own token header; this is the name it uses. */
const TOKEN_HEADER = "X-Emby-Token";

export interface JellyfinOptions {
  baseUrl: string;
  apiKey: string;
  userId?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface JellyfinLibrary {
  libraryId: string;
  name: string;
  /** A music library is what this app imports; other kinds are listed but skipped. */
  collectionType: string | null;
}

export interface JellyfinClient {
  /** Confirms the server answers and the key works. */
  ping(): Promise<{ name: string; version: string }>;
  /** The server's libraries, so an import can pick the music one by name. */
  libraries(): Promise<JellyfinLibrary[]>;
  /** The user the key belongs to; resolved once and cached. */
  userId(): Promise<string>;
  tracks(input?: { search?: string; limit?: number; startIndex?: number; albumId?: string }): Promise<{ tracks: MusicTrack[]; total: number }>;
  albums(input?: { limit?: number; startIndex?: number }): Promise<MusicAlbum[]>;
  albumTracks(albumId: string): Promise<MusicTrack[]>;
  /** A URL the server proxies for a track, so the API key never reaches the page. */
  streamUrl(itemId: string): string;
  imageUrl(itemId: string, size?: number): string | null;
}

interface JellyfinItem {
  Id?: string;
  Name?: string;
  Album?: string;
  AlbumId?: string;
  Artists?: string[];
  AlbumArtist?: string;
  RunTimeTicks?: number;
  ImageTags?: { Primary?: string };
  AlbumPrimaryImageTag?: string;
  Type?: string;
}

/** Jellyfin reports duration in 100-ns ticks. */
function secondsOf(ticks: unknown): number {
  const value = Number(ticks);
  return Number.isFinite(value) && value > 0 ? Math.round(value / 10_000_000) : 0;
}

function normaliseBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new KugouError("invalid_input", "a Jellyfin URL must be http or https", false);
  return url.origin + url.pathname.replace(/\/$/, "");
}

export function createJellyfinClient(options: JellyfinOptions): JellyfinClient {
  const base = normaliseBase(options.baseUrl);
  const fetcher = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 15_000;
  let resolvedUserId: string | null = options.userId ?? null;

  const call = async <T>(path: string, params: Record<string, string> = {}): Promise<T> => {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetcher(url, {
      headers: { [TOKEN_HEADER]: options.apiKey, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    }).catch((error: unknown) => {
      const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      throw new KugouError("unreachable", `Jellyfin is unreachable (${String(code ?? "network").slice(0, 40)})`, true);
    });
    if (response.status === 401 || response.status === 403) {
      throw new KugouError("expired_session", "Jellyfin refused the API key; check it in the music settings", false);
    }
    if (!response.ok) throw new KugouError("source_unavailable", `Jellyfin returned ${response.status}`, response.status >= 500);
    return await response.json() as T;
  };

  const imageUrl = (itemId: string, size = 400): string | null => {
    if (!itemId) return null;
    return `${base}/Items/${encodeURIComponent(itemId)}/Images/Primary?maxHeight=${size}&maxWidth=${size}&quality=90&api_key=${encodeURIComponent(options.apiKey)}`;
  };

  const trackFromItem = (item: JellyfinItem): MusicTrack | null => {
    if (!item.Id || !item.Name) return null;
    const artists = item.Artists?.length ? item.Artists : item.AlbumArtist ? [item.AlbumArtist] : [];
    return {
      id: `jellyfin:${item.Id}`,
      source: "jellyfin",
      title: item.Name.slice(0, 300),
      artists: artists.map((name) => name.slice(0, 200)).slice(0, 16),
      album: item.Album ?? null,
      albumId: item.AlbumId ?? null,
      durationSeconds: secondsOf(item.RunTimeTicks),
      hash: null,
      audioId: item.Id,
      coverUrl: item.AlbumId && item.AlbumPrimaryImageTag ? imageUrl(item.AlbumId, 400) : null,
      vip: false,
      maxQuality: "flac",
      unsupportedReason: null,
    };
  };

  return {
    async ping() {
      const info = await call<{ ServerName?: string; Version?: string }>("/System/Info/Public");
      return { name: info.ServerName ?? "Jellyfin", version: info.Version ?? "unknown" };
    },

    async libraries() {
      const userId = await this.userId();
      const payload = await call<{ Items?: JellyfinItem[] }>(`/Users/${userId}/Views`);
      return (payload.Items ?? []).map((item) => ({
        libraryId: item.Id ?? "",
        name: (item.Name ?? "Library").slice(0, 300),
        collectionType: typeof (item as Record<string, unknown>).CollectionType === "string" ? String((item as Record<string, unknown>).CollectionType) : null,
      })).filter((library) => library.libraryId);
    },

    async userId() {
      if (resolvedUserId) return resolvedUserId;
      const me = await call<{ Id?: string }>("/Users/Me");
      if (!me.Id) throw new KugouError("source_unavailable", "Jellyfin did not say which user the key belongs to", false);
      resolvedUserId = me.Id;
      return me.Id;
    },

    async tracks(input) {
      const userId = await this.userId();
      const payload = await call<{ Items?: JellyfinItem[]; TotalRecordCount?: number }>(`/Users/${userId}/Items`, {
        IncludeItemTypes: "Audio",
        Recursive: "true",
        Fields: "Album,AlbumId,Artists,AlbumArtist,RunTimeTicks,ImageTags,AlbumPrimaryImageTag",
        Limit: String(input?.limit ?? 200),
        StartIndex: String(input?.startIndex ?? 0),
        ...(input?.search ? { SearchTerm: input.search } : {}),
        ...(input?.albumId ? { AlbumIds: input.albumId } : {}),
        SortBy: "SortName",
      });
      const tracks = (payload.Items ?? []).map((item) => trackFromItem(item)).filter((track): track is MusicTrack => track !== null);
      return { tracks, total: Number(payload.TotalRecordCount ?? tracks.length) };
    },

    async albums(input) {
      const userId = await this.userId();
      const payload = await call<{ Items?: JellyfinItem[] }>(`/Users/${userId}/Items`, {
        IncludeItemTypes: "MusicAlbum",
        Recursive: "true",
        Fields: "AlbumArtist,ImageTags",
        Limit: String(input?.limit ?? 100),
        StartIndex: String(input?.startIndex ?? 0),
        SortBy: "SortName",
      });
      return (payload.Items ?? []).map((item) => ({
        albumId: item.Id ?? "",
        name: (item.Name ?? "Album").slice(0, 300),
        artist: item.AlbumArtist ?? (item.Artists?.[0] ?? ""),
        coverUrl: item.Id && item.ImageTags?.Primary ? imageUrl(item.Id, 400) : null,
        releaseDate: null,
        trackCount: 0,
        tracks: [],
      })).filter((album) => album.albumId);
    },

    async albumTracks(albumId) {
      const result = await this.tracks({ albumId, limit: 500 });
      return result.tracks;
    },

    streamUrl(itemId) {
      // The server proxies this; the page never sees the key.
      return `${base}/Audio/${encodeURIComponent(itemId)}/stream?static=true&api_key=${encodeURIComponent(options.apiKey)}`;
    },

    imageUrl,
  };
}

/** A short identity line for the adapters card. */
export function jellyfinLabel(baseUrl: string): string {
  try {
    return `Jellyfin · ${new URL(baseUrl).host}`;
  } catch {
    return "Jellyfin";
  }
}
