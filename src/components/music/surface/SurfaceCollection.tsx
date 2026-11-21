// Upstream's SongCollectionDetailView: the 188px hero with the optional 164px
// cover, the play-all / hero-action / batch row, and the same song table the
// daily page uses. Every detail page (history, cloud, local, playlist, rank,
// singer, album) renders through this one surface.
import { useCallback, useRef } from "react";
import { Loader2 } from "lucide-react";

import type { MusicTrack } from "../../../../shared/music.ts";
import { t } from "@/lib/music/ports";
import { musicStore, useMusic } from "@/lib/music/store";
import { MaskIcon, WindowGlyph } from "./SurfaceIcons";
import { SongRow } from "../controls/SongList";

export function SurfaceCollection({ cover, title, subtitle, songs, loading, loadingMore, onLoadMore, onBack, heroAction, batch = true, locate = true }: {
  cover?: string | null;
  title: string;
  subtitle?: string | null;
  songs: readonly MusicTrack[];
  loading?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onBack?: () => void;
  /** One extra action beside 播放全部, shown as its icon (upstream's clear-history trash, for instance). */
  heroAction?: { icon: string; label: string; onClick: () => void };
  /** The batch button every collection carries. */
  batch?: boolean;
  locate?: boolean;
}) {
  const music = useMusic();
  const current = music.playback?.current?.track ?? null;
  const listRef = useRef<HTMLDivElement | null>(null);

  const playAll = useCallback(() => {
    if (songs.length) void musicStore.playTracks(songs.map((track) => track.id));
  }, [songs]);

  const onScroll = useCallback(() => {
    if (!onLoadMore || loadingMore || loading) return;
    const box = listRef.current;
    if (!box) return;
    if (box.scrollTop + box.clientHeight < box.scrollHeight - 400) return;
    onLoadMore();
  }, [onLoadMore, loadingMore, loading]);

  const locateCurrent = useCallback(() => {
    const at = songs.findIndex((track) => track.id === current?.id);
    if (at < 0 || !listRef.current) return;
    const rows = listRef.current.querySelectorAll("[data-song-row]");
    rows[at]?.scrollIntoView({ block: "center" });
  }, [songs, current]);

  return (
    <div className="m-collection">
      <div className="m-collection-hero" style={cover ? undefined : { backgroundImage: "url(/music/daily-recommend-hero.webp)" }}>
        <div className="m-collection-fade" />
        <div className="m-collection-inner">
          {cover && <img className="m-collection-cover" src={cover} alt="" />}
          <div className="m-collection-copy" style={cover ? undefined : { gridColumn: "1 / -1" }}>
            <h1 className="m-collection-title">{title}</h1>
            {subtitle && <span className="m-collection-sub">{subtitle}</span>}
            <div className="m-collection-actions">
              <button type="button" className="m-collection-play" onClick={playAll} disabled={!songs.length}>
                <MaskIcon src="/music/play-1003-svgrepo-com.svg" size={16} />
                {t("music.playAll")}
              </button>
              {heroAction && (
                <button type="button" className="m-collection-hero-icon" onClick={heroAction.onClick} aria-label={heroAction.label}>
                  <MaskIcon src={heroAction.icon} size={16} />
                </button>
              )}
              {batch && (
                <button type="button" className="m-collection-hero-icon" onClick={playAll} disabled={!songs.length} aria-label={t("music.queue.add")}>
                  <MaskIcon src="/music/FormatList.svg" size={16} />
                </button>
              )}
            </div>
          </div>
          {onBack && (
            <button type="button" className="m-collection-back" onClick={onBack} aria-label={t("music.back")}>
              <WindowGlyph name="chevronLeft" size={22} />
            </button>
          )}
        </div>
      </div>

      <div className="m-card m-collection-card">
        <div className="m-collection-head">
          <span>{t("music.col.song")}</span>
          <span>{t("music.col.album")}</span>
          <span>{t("music.col.duration")}</span>
          <span>
            <span>{t("music.col.actions")}</span>
            {locate && (
              <button type="button" className="m-collection-locate" onClick={locateCurrent} aria-label={t("music.locate")}>
                <MaskIcon src="/music/TargetIcon.svg" size={22} />
              </button>
            )}
          </span>
        </div>

        <div className="m-collection-list" ref={listRef} onScroll={onScroll}>
          {songs.map((track, index) => (
            <SongRow
              key={track.id}
              track={track}
              index={index}
              playing={current?.id === track.id}
              onPlay={() => void musicStore.playTracks([track.id])}
              onAdd={() => void musicStore.editQueue({ action: "add", trackIds: [track.id] })}
            />
          ))}
          {!songs.length && !loading && <div className="m-empty">{t("music.empty")}</div>}
          {loading && <div className="m-empty"><Loader2 size={18} className="animate-spin" /></div>}
          {loadingMore && <div className="m-loading-more"><Loader2 size={14} className="animate-spin" />{t("music.loadingMore")}</div>}
        </div>
      </div>
    </div>
  );
}
