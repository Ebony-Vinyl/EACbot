// Upstream's side menu: a glass card holding the account, the five main pages,
// the three collapsible playlist groups and the new-playlist button. Geometry
// comes from MainWindow.axaml (card inset 8/16/8/10, header 16/10/16/14, lists
// capped at 320) and the icons are the same assets the reference ships.
import { useEffect, useState } from "react";

import type { MusicPlaylist } from "../../../shared/music.ts";
import { t } from "@/lib/music/ports";
import { MaskIcon, WindowGlyph } from "./surface/SurfaceIcons";

export type MusicPage = "daily" | "history" | "local" | "discover" | "cloud";

export const MUSIC_PAGES: ReadonlyArray<{ page: MusicPage; labelKey: string; icon: string }> = [
  { page: "daily", labelKey: "music.page.daily", icon: "/music/Radio.svg" },
  { page: "history", labelKey: "music.page.history", icon: "/music/history-svgrepo-com.svg" },
  { page: "local", labelKey: "music.page.local", icon: "/music/music-folder-8-svgrepo-com.svg" },
  { page: "discover", labelKey: "music.page.discover", icon: "/music/tag-svgrepo-com.svg" },
  { page: "cloud", labelKey: "music.page.cloud", icon: "/music/cloud-download-svgrepo-com.svg" },
];

function PlaylistGroup({ title, playlists, activeId, onOpen, expanded, onToggle }: {
  title: string;
  playlists: readonly MusicPlaylist[];
  activeId: string | null;
  onOpen: (playlistId: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="m-section">
      <button type="button" className="m-section-head" aria-expanded={expanded} onClick={onToggle}>
        <MaskIcon src="/music/NavigateNext.svg" size={14} />
        <span>{title}</span>
      </button>
      {expanded && playlists.length > 0 && (
        <div className="m-plist">
          {playlists.map((playlist) => (
            <button
              key={playlist.playlistId}
              type="button"
              className="m-plist-item"
              aria-current={activeId === playlist.playlistId ? "page" : undefined}
              onClick={() => onOpen(playlist.playlistId)}
            >
              <span className="m-plist-cover">
                {playlist.coverUrl
                  ? <img src={playlist.coverUrl} alt="" className="size-full object-cover" loading="lazy" />
                  : null}
              </span>
              <span className="m-plist-name">{playlist.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MusicSideMenu({ page, playlistId, playlists, account, onPage, onOpenPlaylist, onCreatePlaylist, onImport, onOpenLogin, onOpenSettings }: {
  page: MusicPage | null;
  playlistId: string | null;
  playlists: readonly MusicPlaylist[];
  account: { loggedIn: boolean; nickname: string | null; avatarUrl: string | null; vip: boolean; vipLabel: string | null } | null;
  onPage: (page: MusicPage) => void;
  onOpenPlaylist: (playlistId: string) => void;
  onCreatePlaylist: () => void;
  onImport: () => void;
  onOpenLogin: () => void;
  onOpenSettings: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [createdOpen, setCreatedOpen] = useState(true);
  const [collectedOpen, setCollectedOpen] = useState(false);
  const [albumOpen, setAlbumOpen] = useState(false);
  const [flyout, setFlyout] = useState(false);

  useEffect(() => {
    if (!flyout) return;
    const close = () => setFlyout(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [flyout]);

  const created = playlists.filter((playlist) => playlist.kind === "created" || playlist.kind === "local");
  const collected = playlists.filter((playlist) => playlist.kind === "collected");
  const albums = playlists.filter((playlist) => playlist.kind === "album" || playlist.kind === "jellyfin");

  return (
    <aside className={collapsed ? "m-side m-side--collapsed" : "m-side"} aria-label={t("music.menu")}>
      <div className="m-side-card">
        <button type="button" className="m-collapse" onClick={() => setCollapsed((value) => !value)} aria-label={t("music.menu")}>
          <WindowGlyph name="chevronLeft" size={12} />
        </button>

        <div className="m-side-scroll">
          <div className="m-avatar-card">
            {account?.loggedIn ? (
              <button type="button" className="w-full" onClick={onOpenSettings}>
                {account.avatarUrl
                  ? <img src={account.avatarUrl} alt="" className="m-avatar" />
                  : <span className="m-avatar" />}
                <span className="m-avatar-name">{account.nickname ?? t("music.account.signedIn")}</span>
              </button>
            ) : (
              <button type="button" className="m-avatar-login" onClick={onOpenLogin}>
                {t("music.account.signIn")}
              </button>
            )}
          </div>

          <nav className="m-nav" aria-label={t("music.pages")}>
            {MUSIC_PAGES.map(({ page: entry, labelKey, icon }) => (
              <button
                key={entry}
                type="button"
                className="m-nav-item"
                aria-current={page === entry ? "page" : undefined}
                onClick={() => onPage(entry)}
              >
                <MaskIcon src={icon} size={20} />
                <span className="m-nav-label">{t(labelKey as never)}</span>
              </button>
            ))}
          </nav>

          <div className="m-side-footer">
            <span className="m-separator" />
            <PlaylistGroup
              title={t("music.playlists.created")}
              playlists={created}
              activeId={playlistId}
              onOpen={onOpenPlaylist}
              expanded={createdOpen}
              onToggle={() => setCreatedOpen((value) => !value)}
            />
            <PlaylistGroup
              title={t("music.playlists.collected")}
              playlists={collected}
              activeId={playlistId}
              onOpen={onOpenPlaylist}
              expanded={collectedOpen}
              onToggle={() => setCollectedOpen((value) => !value)}
            />
            <PlaylistGroup
              title={t("music.playlists.albums")}
              playlists={albums}
              activeId={playlistId}
              onOpen={onOpenPlaylist}
              expanded={albumOpen}
              onToggle={() => setAlbumOpen((value) => !value)}
            />

            <div className="relative">
              <button
                type="button"
                className="m-new-playlist"
                onClick={(event) => { event.stopPropagation(); setFlyout((open) => !open); }}
              >
                <span className="m-new-playlist-tile">
                  <MaskIcon src="/music/music-folder-8-svgrepo-com.svg" size={14} />
                </span>
                <span className="m-new-playlist-label">{t("music.playlists.new")}</span>
              </button>
              {flyout && (
                <div className="m-flyout">
                  <button type="button" onClick={() => { setFlyout(false); onImport(); }}>{t("music.playlists.import")}</button>
                  <button type="button" onClick={() => { setFlyout(false); onCreatePlaylist(); }}>{t("music.playlists.create")}</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
