// Search: songs, playlists and albums, the three kinds upstream searches. A hit
// opens its own detail rather than replacing the results.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import type { MusicAlbum, MusicPlaylist, MusicTrack } from "../../../../shared/music.ts";
import { t } from "@/lib/music/ports";
import { musicStore } from "@/lib/music/store";
import { cn, EmptyState } from "@/lib/music/ports";
import { WindowGlyph } from "../surface/SurfaceIcons";
import { MediaCard, SongRow } from "../controls/SongList";

type Kind = "track" | "playlist" | "album";

interface SearchAnswer {
  tracks?: MusicTrack[];
  playlists?: MusicPlaylist[];
  albums?: MusicAlbum[];
  hasMore?: boolean;
  error?: { message: string };
}

export function SearchPage({ initialQuery, onClose, onOpenAlbum, onOpenPlaylist }: {
  initialQuery?: string;
  onClose: () => void;
  onOpenAlbum: (albumId: string) => void;
  onOpenPlaylist: (playlistId: string) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [kind, setKind] = useState<Kind>("track");
  const [page, setPage] = useState(1);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>([]);
  const [albums, setAlbums] = useState<MusicAlbum[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seeded = initialQuery?.trim();
    if (!seeded) return;
    setKeyword(seeded);
  }, [initialQuery]);

  const search = useCallback(async (query: string, which: Kind, nextPage: number, append: boolean) => {
    const trimmed = query.trim();
    if (!trimmed) { setTracks([]); setPlaylists([]); setAlbums([]); return; }
    const sequence = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const answer = await fetch(`/api/music/search?q=${encodeURIComponent(trimmed)}&kind=${which}&page=${nextPage}&pageSize=30`)
        .then((response) => response.json() as Promise<SearchAnswer>);
      if (sequence !== requestSeq.current) return;
      if (answer.error) throw new Error(answer.error.message);
      if (which === "track") setTracks((current) => append ? [...current, ...(answer.tracks ?? [])] : answer.tracks ?? []);
      if (which === "playlist") setPlaylists((current) => append ? [...current, ...(answer.playlists ?? [])] : answer.playlists ?? []);
      if (which === "album") setAlbums((current) => append ? [...current, ...(answer.albums ?? [])] : answer.albums ?? []);
      setHasMore(answer.hasMore === true);
    } catch (caught) {
      if (sequence !== requestSeq.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (sequence === requestSeq.current) setLoading(false);
    }
  }, []);

  // Typing waits for a pause, so one search does not become eight.
  useEffect(() => {
    if (!keyword.trim()) return;
    const timer = window.setTimeout(() => { setPage(1); void search(keyword, kind, 1, false); }, 320);
    return () => window.clearTimeout(timer);
  }, [keyword, kind, search]);

  const more = () => {
    const next = page + 1;
    setPage(next);
    void search(keyword, kind, next, true);
  };

  return (
    <div className="m-card m-daily-card m-collection" style={{ minHeight: "unset" }}>
      <div className="flex items-center gap-3" style={{ padding: "0 0 20px" }}>
        <form className="m-search" style={{ flex: 1, maxWidth: 640, height: 40, borderRadius: 8 }} onSubmit={(event) => { event.preventDefault(); setKind(kind); }}>
          <WindowGlyph name="search" size={14} />
          <input
            autoFocus
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={t("music.searchPlaceholder")}
          />
        </form>
        <button type="button" className="m-bar-speed" onClick={onClose}>{t("music.back")}</button>
      </div>

      <div className="m-card flex w-fit gap-1 p-1.5" style={{ marginBottom: 15 }}>
        {([["track", "music.search.songs"], ["playlist", "music.search.playlists"], ["album", "music.search.albums"]] as const).map(([entry, label]) => (
          <button
            key={entry}
            type="button"
            onClick={() => setKind(entry)}
            className={cn("rounded-full px-4 py-1.5 text-[13px]", kind === entry ? "bg-[rgba(10,89,247,0.1)] font-semibold text-[#0a59f7]" : "text-[var(--m-low)] hover:bg-[rgba(0,0,0,0.04)]")}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {error && <div className="m-empty">{error}</div>}
      {loading && !tracks.length && !playlists.length && !albums.length && (
        <div className="m-empty"><Loader2 size={18} className="animate-spin" /></div>
      )}

      {kind === "track" && (tracks.length ? (
        <>
          <div className="flex flex-col">
            {tracks.map((track, index) => (
              <SongRow key={track.id} track={track} index={index} onPlay={() => void musicStore.playTracks([track.id])} onAdd={() => void musicStore.editQueue({ action: "add", trackIds: [track.id] })} />
            ))}
          </div>
          {hasMore && <button type="button" className="m-bar-speed" disabled={loading} onClick={more}>{t("music.loadMore")}</button>}
        </>
      ) : !loading && keyword.trim() ? <EmptyState title={t("music.search.noSongs")} body={t("music.search.noSongsBody")} /> : null)}

      {kind === "playlist" && (playlists.length ? (
        <div className="flex flex-wrap">{playlists.map((playlist) => (
          <MediaCard key={playlist.playlistId} coverUrl={playlist.coverUrl} title={playlist.name} subtitle={`${playlist.trackCount} ${t("music.songs")}`} onClick={() => onOpenPlaylist(playlist.playlistId)} />
        ))}</div>
      ) : !loading && keyword.trim() ? <EmptyState title={t("music.search.noPlaylists")} body={t("music.search.noPlaylistsBody")} /> : null)}

      {kind === "album" && (albums.length ? (
        <div className="flex flex-wrap">{albums.map((album) => (
          <MediaCard key={album.albumId} coverUrl={album.coverUrl} title={album.name} subtitle={album.artist} onClick={() => onOpenAlbum(album.albumId)} />
        ))}</div>
      ) : !loading && keyword.trim() ? <EmptyState title={t("music.search.noAlbums")} body={t("music.search.noAlbumsBody")} /> : null)}

      {!keyword.trim() && (
        <div className="m-empty" style={{ padding: "48px 0" }}>
          <WindowGlyph name="search" size={22} />
          <p className="text-[12px]">{t("music.search.hint")}</p>
        </div>
      )}
    </div>
  );
}
