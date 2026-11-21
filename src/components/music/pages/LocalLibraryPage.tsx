// Upstream's local-library home: a 24px glass card with the five actions and a
// grid of the folder playlists it owns; opening one shows the collection surface.
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { MusicPlaylist } from "../../../../shared/music.ts";
import { t } from "@/lib/music/ports";
import { MediaCard } from "../controls/SongList";

export function LocalLibraryPage({ onOpenPlaylist, onCreate, onImportLink }: {
  onOpenPlaylist: (playlistId: string) => void;
  onCreate: () => void;
  onImportLink: () => void;
}) {
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const answer = await fetch("/api/music/playlists").then((response) => response.json() as Promise<{ playlists?: MusicPlaylist[] }>);
      setPlaylists((answer.playlists ?? []).filter((playlist) => playlist.kind === "local" || playlist.kind === "jellyfin"));
    } catch {
      setPlaylists([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rescan = useCallback(async () => {
    setLoading(true);
    try {
      const config = await fetch("/api/config").then((response) => response.json() as Promise<{ music?: { localFolders?: string[] } }>);
      for (const folder of config.music?.localFolders ?? []) {
        await fetch("/api/music/library/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder }) });
      }
      await load();
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="m-card p-6">
      <div className="mb-4 flex items-center gap-2.5">
        <h2 className="m-section-title flex-1" style={{ fontSize: 26, color: "var(--m-text)" }}>{t("music.page.local")}</h2>
        <button type="button" className="m-bar-speed" onClick={() => void rescan()}>{t("music.library.rescan")}</button>
        <button type="button" className="m-bar-speed" onClick={onCreate}>
          <svg className="m-svg" width="14" height="14" viewBox="0 0 24 24"><path d="M4 10h16M4 14h10" /></svg>
          {t("music.playlists.create")}
        </button>
        <button type="button" className="m-bar-speed" onClick={onImportLink}>
          <svg className="m-svg" width="14" height="14" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" /></svg>
          {t("music.playlists.import")}
        </button>
      </div>
      {loading && !playlists.length
        ? <div className="m-empty"><Loader2 size={18} className="animate-spin" /></div>
        : <div className="flex flex-wrap">{playlists.map((playlist) => (
          <MediaCard
            key={playlist.playlistId}
            coverUrl={playlist.coverUrl}
            title={playlist.name}
            subtitle={`${playlist.trackCount} ${t("music.songs")}`}
            onClick={() => onOpenPlaylist(playlist.playlistId)}
          />
        ))}</div>}
      {!loading && !playlists.length && <div className="m-empty">{t("music.library.empty")}</div>}
    </div>
  );
}
