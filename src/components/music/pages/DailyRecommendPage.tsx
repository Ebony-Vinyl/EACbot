// Upstream's DailyRecommendView: a 188px hero with the shipped background photo,
// the 392px heart-radio panel on the right, and the song table in a glass card.
import { useCallback, useEffect, useState } from "react";

import type { MusicTrack } from "../../../../shared/music.ts";
import { t } from "@/lib/music/ports";
import { musicStore, useMusic } from "@/lib/music/store";
import { MaskIcon } from "../surface/SurfaceIcons";
import { SongRow } from "../controls/SongList";

export function DailyRecommendPage() {
  const music = useMusic();
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [fm, setFm] = useState<MusicTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [daily, radio] = await Promise.all([
        fetch("/api/music/discover?kind=daily").then((response) => response.json() as Promise<{ tracks?: MusicTrack[]; error?: { message: string } }>),
        fetch("/api/music/discover?kind=fm").then((response) => response.json() as Promise<{ tracks?: MusicTrack[] }>),
      ]);
      if (daily.error) throw new Error(daily.error.message);
      setTracks(daily.tracks ?? []);
      setFm(radio.tracks ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const current = music.playback?.current?.track ?? null;
  const fmTrack = fm[0] ?? null;
  const fmPlaying = fm.some((track) => track.id === current?.id) && (music.playback?.state === "playing" || music.playback?.state === "buffering");

  return (
    <div>
      <div className="m-hero" style={{ backgroundImage: "url(/music/daily-recommend-hero.webp)" }}>
        <div className="m-hero-fade" />
        <div className="m-hero-inner">
          <div className="m-hero-copy">
            <span className="m-badge">DAILY RECOMMENDATION</span>
            <h1 className="m-hero-title">{t("music.daily.heroTitle")}</h1>
            <span className="m-hero-sub">{t("music.daily.heroSub")}</span>
          </div>

          <div className="m-fm">
            <div className="m-fm-top">
              <div className="m-fm-copy">
                <div className="m-fm-head">
                  <span className="m-fm-title">{t("music.fm.title")}</span>
                  <button type="button" className="m-fm-glass" onClick={() => void load()} aria-label={t("music.fm.pool")}>
                    <MaskIcon src="/music/switch-up.svg" size={15} />
                  </button>
                </div>
                <button type="button" className="m-fm-pool" onClick={() => void load()}>{t("music.fm.pool")}</button>
                <span className="m-fm-sub">
                  {fmTrack ? `${fmTrack.title} — ${fmTrack.artists.join(", ")}` : t("music.discover.emptyFmBody")}
                </span>
              </div>
              <div className="m-fm-art">
                <span className="m-fm-halo" />
                <img className="m-fm-cover" src={fmTrack?.coverUrl ?? "/music/Default.webp"} alt="" />
                <button
                  type="button"
                  className="m-fm-play"
                  onClick={() => { if (fmTrack) void musicStore.playTracks(fm.map((track) => track.id)); }}
                  disabled={!fmTrack}
                  aria-label={t("music.play")}
                >
                  <MaskIcon src={fmPlaying ? "/music/pause-1006-svgrepo-com.svg" : "/music/play-1003-svgrepo-com.svg"} size={18} />
                </button>
              </div>
            </div>
            <div className="m-fm-actions">
              <button
                type="button"
                className="m-fm-action"
                onClick={() => { if (fm.length > 1) void musicStore.editQueue({ action: "replace", trackIds: [fm[1]!.id] }); }}
                disabled={fm.length < 2}
                aria-label={t("music.next")}
              >
                <MaskIcon src="/music/unlike-svgrepo-com.svg" size={17} />
              </button>
              <button type="button" className="m-fm-action" onClick={() => void load()} aria-label={t("music.fm.pool")}>
                <MaskIcon src="/music/switch-up.svg" size={15} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="m-card m-daily-card">
        <div className="m-table-head">
          <span>{t("music.col.song")}</span>
          <span>{t("music.col.album")}</span>
          <span>{t("music.col.duration")}</span>
          <span>{t("music.col.actions")}</span>
        </div>

        <div className="m-songlist">
          {tracks.map((track, index) => (
            <SongRow
              key={track.id}
              track={track}
              index={index}
              playing={current?.id === track.id}
              onPlay={() => void musicStore.playTracks([track.id])}
              onAdd={() => void musicStore.editQueue({ action: "add", trackIds: [track.id] })}
            />
          ))}
        </div>

        {error && <div className="m-empty">{error}</div>}
        {!error && loading && <div className="m-empty">{t("music.daily.loading")}</div>}
        {!error && !loading && !tracks.length && <div className="m-empty">{t("music.daily.empty")}</div>}
      </div>
    </div>
  );
}
