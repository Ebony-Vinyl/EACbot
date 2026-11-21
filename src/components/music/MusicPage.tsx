// The music surface: upstream's whole window — its own title bar, side menu,
// content and floating playback bar — as a self-contained light world that covers
// the app shell while it is open. State stays the server's; only the skin is new.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import type { MusicPlaylist } from "../../../shared/music.ts";
import { musicStore, useMusic } from "@/lib/music/store";
import { Notice } from "@/lib/music/ports";
import { MusicSideMenu, type MusicPage as MusicPageId } from "./SideMenu";
import { MiniPlayer } from "./mini/MiniPlayer";
import { SurfaceTitleBar } from "./surface/SurfaceTitleBar";
import { BottomPlaybackBar } from "./controls/BottomPlaybackBar";
import { NowPlayingView } from "./nowplaying/NowPlayingView";
import { DailyRecommendPage } from "./pages/DailyRecommendPage";
import { HistoryPage } from "./pages/HistoryPage";
import { LocalLibraryPage } from "./pages/LocalLibraryPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { UserCloudPage } from "./pages/UserCloudPage";
import { SearchPage } from "./pages/SearchPage";
import { PlaylistPage } from "./pages/PlaylistPage";
import { RankPage } from "./pages/RankPage";
import { SingerPage } from "./pages/SingerPage";
import { AlbumPage } from "./pages/AlbumPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginDialog } from "./dialogs/LoginDialog";
import { CreatePlaylistDialog, ImportPlaylistDialog } from "./dialogs/PlaylistDialogs";
import "./surface/music-surface.css";

/** A detail view the music area can push: a playlist, a rank, an artist, an album. */
type Detail =
  | { kind: "playlist"; playlistId: string }
  | { kind: "rank"; rankId: string }
  | { kind: "artist"; artistId: string }
  | { kind: "album"; albumId: string }
  | null;

export function MusicPage({ onBack }: { onBack: () => void }) {
  const music = useMusic();
  const [page, setPage] = useState<MusicPageId>("daily");
  const [detail, setDetail] = useState<Detail>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [localPlaylists, setLocalPlaylists] = useState<MusicPlaylist[]>([]);

  useEffect(() => {
    musicStore.connect();
    void musicStore.load();
    void refreshPlaylists();
    // The menu is the only place a local playlist appears, so it refreshes when the server says one changed.
    return () => { void musicStore.disconnect(); };
  }, []);

  const refreshPlaylists = useCallback(async () => {
    try {
      const answer = await fetch("/api/music/playlists").then((response) => response.json() as Promise<{ playlists?: MusicPlaylist[] }>);
      setLocalPlaylists(answer.playlists ?? []);
    } catch {
      // A failed list is not worth an error banner: the menu simply shows none.
    }
  }, []);

  const playlists = useMemo(() => localPlaylists, [localPlaylists]);

  const openPlaylist = useCallback((playlistId: string) => {
    setDetail({ kind: "playlist", playlistId });
    setPage("daily");
  }, []);

  const runSearch = useCallback((value: string) => {
    setQuery(value);
    setDetail(null);
    setSettingsOpen(false);
    setSearchOpen(true);
  }, []);

  const closeTransient = useCallback(() => {
    setSearchOpen(false);
    setSettingsOpen(false);
    setDetail(null);
  }, []);

  const content = (() => {
    if (settingsOpen) return <SettingsPage onClose={() => setSettingsOpen(false)} />;
    if (searchOpen) return <SearchPage initialQuery={query} onClose={() => setSearchOpen(false)}  onOpenAlbum={(albumId) => { setSearchOpen(false); setDetail({ kind: "album", albumId }); }} onOpenPlaylist={openPlaylist} />;
    if (detail?.kind === "playlist") return <PlaylistPage playlistId={detail.playlistId} onBack={closeTransient} />;
    if (detail?.kind === "rank") return <RankPage rankId={detail.rankId} onBack={closeTransient} />;
    if (detail?.kind === "artist") return <SingerPage artistId={detail.artistId} onBack={closeTransient} onOpenAlbum={(albumId) => setDetail({ kind: "album", albumId })} />;
    if (detail?.kind === "album") return <AlbumPage albumId={detail.albumId} onBack={closeTransient} />;
    switch (page) {
      case "history": return <HistoryPage />;
      case "local": return <LocalLibraryPage onOpenPlaylist={openPlaylist} onCreate={() => setCreateOpen(true)} onImportLink={() => setImportOpen(true)} />;
      case "discover": return <DiscoverPage onOpenRank={(rankId) => setDetail({ kind: "rank", rankId })} onOpenPlaylist={openPlaylist} />;
      case "cloud": return <UserCloudPage />;
      default: return <DailyRecommendPage />;
    }
  })();

  const body = music.loading && !music.playback
    ? <div className="m-empty"><Loader2 size={18} className="animate-spin" /></div>
    : music.error
    ? <div className="p-5"><Notice tone="bad" onDismiss={() => musicStore.clearError()}>{music.error.message}</Notice></div>
    : content;

  return (
    <div className="music-surface" data-music-page="">
      <div className="m-bg" aria-hidden />
      <div className="m-drag" aria-hidden />

      <MusicSideMenu
        page={detail ? null : page}
        playlistId={detail?.kind === "playlist" ? detail.playlistId : null}
        playlists={playlists}
        account={music.account}
        onPage={(next) => { closeTransient(); setPage(next); }}
        onOpenPlaylist={openPlaylist}
        onCreatePlaylist={() => setCreateOpen(true)}
        onImport={() => setImportOpen(true)}
        onOpenLogin={() => setLoginOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="m-main">
        <SurfaceTitleBar
          query={query}
          onQueryChange={setQuery}
          onSearch={runSearch}
          onBack={onBack}
          onOpenSettings={() => { setDetail(null); setSearchOpen(false); setSettingsOpen((open) => !open); }}
        />
        <div className="m-content">{body}</div>
      </div>

      <BottomPlaybackBar onOpenNowPlaying={() => setNowPlayingOpen(true)} onOpenQueue={() => setNowPlayingOpen(true)} />

      {nowPlayingOpen && <NowPlayingView onClose={() => setNowPlayingOpen(false)} />}

      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
      <CreatePlaylistDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { void refreshPlaylists(); }} />
      <ImportPlaylistDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={() => { void refreshPlaylists(); }} />
    </div>
  );
}

export { MiniPlayer };
