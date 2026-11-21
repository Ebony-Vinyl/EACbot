// The list and card controls the music pages share, drawn to upstream's
// SongListItemControl and MediaCard: a 45px cover, the four-column grid, the
// triangle/kebab row actions, and the 168x220 media card.
import type { ReactNode } from "react";

import { formatDuration, type MusicTrack } from "../../../../shared/music.ts";
import { t } from "@/lib/music/ports";

function PlayGlyph({ playing }: { playing?: boolean }) {
  return playing ? (
    <svg className="m-svg" width="15" height="15" viewBox="0 0 15 15" preserveAspectRatio="none" aria-hidden>
      <path d="M2,1 L5,1 L5,14 L2,14 Z M10,1 L13,1 L13,14 L10,14 Z" />
    </svg>
  ) : (
    <svg className="m-svg" width="15" height="15" viewBox="0 0 15 15" preserveAspectRatio="none" aria-hidden>
      <path d="M0,0 L6,3 L0,6 Z" transform="translate(0 4.5)" />
    </svg>
  );
}

function KebabGlyph() {
  return (
    <svg className="m-svg" width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 20q-.825 0-1.412-.587T10 18t.588-1.412T12 16t1.413.588T14 18t-.587 1.413T12 20m0-6q-.825 0-1.412-.587T10 12t.588-1.412T12 10t1.413.588T14 12t-.587 1.413T12 14m0-6q-.825 0-1.412-.587T10 6t.588-1.412T12 4t1.413.588T14 6t-.587 1.413T12 8" />
    </svg>
  );
}

export function SongRow({ track, index, active, playing, onPlay, onAdd, onMenu }: {
  track: MusicTrack;
  index?: number;
  active?: boolean;
  playing?: boolean;
  onPlay: () => void;
  onAdd?: () => void;
  onMenu?: () => void;
}) {
  const more = onMenu ?? onAdd;
  return (
    <div
      data-song-row={track.id}
      className="m-song-row"
      aria-current={active ? "true" : undefined}
      onDoubleClick={onPlay}
    >
      <span className="m-song-cover">
        {track.coverUrl ? <img src={track.coverUrl} alt="" loading="lazy" /> : <span className="m-song-index">{typeof index === "number" ? index + 1 : ""}</span>}
      </span>
      <span className="m-song-main">
        <span className={playing ? "m-song-title m-song-title--playing" : "m-song-title"}>
          {track.title}
          {track.vip && <span className="m-vip">{t("music.vip")}</span>}
        </span>
        <span className="m-song-artist">{track.artists.join(", ") || t("music.unknownArtist")}</span>
      </span>
      <span className="m-song-album">{track.album}</span>
      <span className="m-song-duration">{formatDuration(track.durationSeconds)}</span>
      <span className="m-song-actions">
        <button type="button" className="m-song-action" onClick={onPlay} aria-label={t("music.play")}>
          <PlayGlyph playing={playing} />
        </button>
        {more && (
          <button type="button" className="m-song-action" onClick={more} aria-label={t("music.more")}>
            <KebabGlyph />
          </button>
        )}
      </span>
    </div>
  );
}

export function MediaCard({ coverUrl, title, subtitle, onClick, badge }: {
  coverUrl: string | null;
  title: string;
  subtitle?: string;
  onClick: () => void;
  badge?: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className="m-media-card">
      <span className="m-media-cover">
        {coverUrl ? <img src={coverUrl} alt="" loading="lazy" /> : null}
        {badge && <span className="m-media-overlay">{badge}</span>}
      </span>
      <span className="m-media-info">
        <span className="m-media-title">{title}</span>
        {subtitle && <span className="m-media-sub">{subtitle}</span>}
      </span>
    </button>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <h2 className="m-section-title">{title}</h2>
      {action}
    </div>
  );
}
