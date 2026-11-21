// Upstream's BottomPlaybackControl: one floating glass card, 72px high, with the
// three-column grid from BottomPlaybackControl.axaml — cover and title left, the
// transport and the 380px progress in the middle, volume/speed/quality/queue right.
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { formatDuration, MUSIC_QUALITIES, type MusicQuality } from "../../../../shared/music.ts";
import { t } from "@/lib/music/ports";
import { musicStore, trackLabelOf, useMusic } from "@/lib/music/store";
import { MaskIcon } from "../surface/SurfaceIcons";
import { PlaybackQueue } from "./PlaybackQueue";

const QUALITY_LABELS: Record<MusicQuality, string> = { "128k": "128K", "320k": "320K", flac: "FLAC", hires: "Hi-Res" };
const SPEEDS = ["0.5x", "0.75x", "1x", "1.25x", "1.5x", "2x"] as const;
const RATE_STORAGE = "music.rate";

export function BottomPlaybackBar({ onOpenNowPlaying, onOpenQueue }: {
  onOpenNowPlaying: () => void;
  onOpenQueue: () => void;
}) {
  const music = useMusic();
  const playback = music.playback;
  const current = playback?.current ?? null;
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [rate, setRate] = useState(() => Number(globalThis.localStorage?.getItem(RATE_STORAGE) ?? "1"));
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(new Set());
  const [desktopLyrics, setDesktopLyrics] = useState(false);
  const volumeBeforeMute = useRef<number | null>(null);

  useEffect(() => {
    void fetch("/api/music/favorites")
      .then((response) => response.json() as Promise<{ tracks?: Array<{ id: string }> }>)
      .then((answer) => setFavorites(new Set((answer.tracks ?? []).map((track) => track.id))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void fetch("/api/config")
      .then((response) => response.json() as Promise<{ music?: { desktopLyrics?: boolean } }>)
      .then((config) => setDesktopLyrics(config.music?.desktopLyrics === true))
      .catch(() => {});
  }, []);

  useEffect(() => {
    musicStore.setRate(rate);
    globalThis.localStorage?.setItem(RATE_STORAGE, String(rate));
  }, [rate]);

  if (!playback) return null;
  const duration = current?.track.durationSeconds ?? 0;
  const position = scrubbing ?? playback.positionSeconds;
  const playing = playback.state === "playing" || playback.state === "buffering";
  const liked = current ? favorites.has(current.track.id) : false;
  const mode = playback.shuffle ? "shuffle" : playback.repeat === "one" ? "one" : "all";

  const toggleFavorite = async () => {
    if (!current) return;
    const favorite = !liked;
    setFavorites((before) => {
      const next = new Set(before);
      if (favorite) next.add(current.track.id);
      else next.delete(current.track.id);
      return next;
    });
    try {
      await fetch("/api/music/favorites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trackId: current.track.id, favorite }),
      });
    } catch {
      setFavorites((before) => {
        const next = new Set(before);
        if (favorite) next.delete(current.track.id);
        else next.add(current.track.id);
        return next;
      });
    }
  };

  const cycleMode = () => {
    if (mode === "all") void musicStore.control({ action: "repeat", repeat: "one" });
    else if (mode === "one") void musicStore.control({ action: "shuffle", shuffle: true });
    else {
      void musicStore.control({ action: "shuffle", shuffle: false });
      void musicStore.control({ action: "repeat", repeat: "all" });
    }
  };

  const toggleMute = () => {
    if (playback.volume > 0) {
      volumeBeforeMute.current = playback.volume;
      void musicStore.control({ action: "volume", volume: 0 });
    } else {
      void musicStore.control({ action: "volume", volume: volumeBeforeMute.current ?? 70 });
    }
  };

  const nudgeVolume = (delta: number) => {
    void musicStore.control({ action: "volume", volume: Math.min(100, Math.max(0, playback.volume + delta)) });
  };

  const toggleDesktopLyrics = async () => {
    const next = !desktopLyrics;
    setDesktopLyrics(next);
    try {
      const config = await fetch("/api/config").then((response) => response.json() as Promise<Record<string, unknown>>);
      await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...config, music: { ...(config.music as object), desktopLyrics: next } }),
      });
    } catch {
      setDesktopLyrics(!next);
    }
  };

  return (
    <div className="m-bottombar" data-music-bar="">
      <button type="button" className="m-bar-left" onClick={onOpenNowPlaying}>
        {current?.track.coverUrl
          ? <img src={current.track.coverUrl} alt="" className="m-bar-cover" />
          : <span className="m-bar-cover"><MaskIcon src="/music/PlayList.svg" size={20} /></span>}
        <span className="m-bar-info">
          <span className="m-bar-title">{current?.track.title ?? t("music.nothingPlaying")}</span>
          <span className="m-bar-artist">
            {current ? trackLabelOf(current.track).replace(`${current.track.title} — `, "") : t("music.queueEmpty")}
          </span>
        </span>
      </button>

      <div className="m-bar-center">
        <div className="m-bar-controls">
          <button type="button" className="m-bar-btn" onClick={() => void toggleFavorite()} disabled={!current} aria-label={t("music.favorite")}>
            <MaskIcon src="/music/Favorite.svg" size={18} className={liked ? "text-[#f5222d]" : "opacity-45"} />
          </button>
          <button type="button" className="m-bar-btn" onClick={() => void musicStore.control({ action: "prev" })} aria-label={t("music.previous")}>
            <MaskIcon src="/music/backward.svg" size={16} />
          </button>
          <button
            type="button"
            className="m-bar-play"
            onClick={() => {
              if (music.needsGesture) void musicStore.unlock().then(() => musicStore.control({ action: "play" }));
              else void musicStore.control({ action: playing ? "pause" : "play" });
            }}
            aria-label={playing ? t("music.pause") : t("music.play")}
          >
            <MaskIcon src={playing ? "/music/pause-1006-svgrepo-com.svg" : "/music/play-1003-svgrepo-com.svg"} size={22} />
          </button>
          <button type="button" className="m-bar-btn" onClick={() => void musicStore.control({ action: "next" })} aria-label={t("music.next")}>
            <MaskIcon src="/music/next-svgrepo-com.svg" size={16} />
          </button>
          <button type="button" className="m-bar-btn" onClick={cycleMode} aria-label={t("music.repeat")}>
            <MaskIcon
              src={mode === "shuffle" ? "/music/shuffle-svgrepo-com.svg" : mode === "one" ? "/music/repeat-one.svg" : "/music/repeat-svgrepo-com.svg"}
              size={18}
            />
          </button>
        </div>

        <div className="m-bar-progress">
          <span className="m-bar-time">{formatDuration(position)}</span>
          <input
            type="range"
            className="m-range"
            min={0}
            max={Math.max(duration, 1)}
            step={1}
            value={position}
            style={{ "--m-range-progress": `${duration ? (position / duration) * 100 : 0}%` } as CSSProperties}
            onChange={(event) => setScrubbing(Number(event.target.value))}
            onPointerUp={() => { if (scrubbing !== null) { void musicStore.control({ action: "seek", positionSeconds: scrubbing }); setScrubbing(null); } }}
            aria-label={t("music.seek")}
          />
          <span className="m-bar-time">{formatDuration(duration)}</span>
        </div>
      </div>

      <div className="m-bar-right">
        <button
          type="button"
          className="m-bar-btn"
          onClick={toggleMute}
          onWheel={(event) => nudgeVolume(event.deltaY < 0 ? 5 : -5)}
          onPointerEnter={() => setVolumeOpen(true)}
          onPointerLeave={(event) => {
            if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest(".m-vol-pop")) setVolumeOpen(false);
          }}
          aria-label={t("music.volume")}
        >
          <MaskIcon src={playback.volume === 0 ? "/music/VolumeOff.svg" : "/music/volume-max-svgrepo-com.svg"} size={18} className="opacity-70" />
        </button>

        <div className="relative">
          <button type="button" className="m-bar-speed" onClick={() => setSpeedOpen((open) => !open)}>
            <MaskIcon src="/music/speed-svgrepo-com.svg" size={16} />
            <span>{rate}x</span>
          </button>
          {speedOpen && (
            <div className="m-menu" style={{ right: 0, bottom: 40 }} onMouseLeave={() => setSpeedOpen(false)}>
              {SPEEDS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => { setRate(Number(option.replace("x", ""))); setSpeedOpen(false); }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
        </div>

        <select
          className="m-bar-quality"
          value={playback.quality}
          onChange={(event) => void musicStore.control({ action: "quality", quality: event.target.value as MusicQuality })}
          aria-label={t("music.quality")}
        >
          {MUSIC_QUALITIES.map((quality) => (
            <option key={quality} value={quality} disabled={!(music.account?.loggedIn ? MUSIC_QUALITIES : ["128k", "320k"] as MusicQuality[]).includes(quality)}>
              {QUALITY_LABELS[quality]}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="m-bar-btn"
          onClick={() => { setQueueOpen((open) => !open); onOpenQueue(); }}
          aria-label={t("music.queue")}
          aria-expanded={queueOpen}
        >
          <MaskIcon src="/music/PlayList.svg" size={18} />
        </button>

        <button
          type="button"
          className="m-bar-btn"
          onClick={() => void toggleDesktopLyrics()}
          aria-label={t("music.settings.desktopLyrics")}
          aria-pressed={desktopLyrics}
        >
          <MaskIcon src="/music/DesktopLyric2.svg" size={20} className={desktopLyrics ? "text-[#0a59f7]" : undefined} />
        </button>
      </div>

      {volumeOpen && (
        <div
          className="m-vol-pop"
          onPointerLeave={() => setVolumeOpen(false)}
        >
          <span className="m-vol-value">{playback.volume}%</span>
          <div className="m-vol-rot">
            <input
              type="range"
              className="m-range"
              min={0}
              max={100}
              step={1}
              value={playback.volume}
              style={{ "--m-range-progress": `${playback.volume}%` } as CSSProperties}
              onChange={(event) => void musicStore.control({ action: "volume", volume: Number(event.target.value) })}
              aria-label={t("music.volume")}
            />
          </div>
        </div>
      )}

      {queueOpen && <PlaybackQueue onClose={() => setQueueOpen(false)} />}
    </div>
  );
}
