// The full-screen now-playing layer, drawn to upstream's NowPlayingView: a black
// layer over the window, the cover as a blurred background, the glass close
// button and window keys, the theme picker at 57/10, and a foreground that rises
// 72px as it opens. Each theme is a component that receives the same props.
import { useCallback, useEffect, useMemo, useState } from "react";

import { NOW_PLAYING_THEMES, type NowPlayingTheme } from "../../../../shared/music.ts";
import type { MusicLyrics, MusicTrack } from "../../../../shared/music.ts";
import { formatDuration } from "../../../../shared/music.ts";
import { cn } from "@/lib/music/ports";
import { t } from "@/lib/music/ports";
import { lineIndexAt, lyricsPlaceholder } from "@/lib/music/lyrics";
import { musicStore, useMusic } from "@/lib/music/store";
import { THEME_LABELS } from "@/lib/music/theme";
import { MaskIcon, WindowGlyph } from "../surface/SurfaceIcons";
import { StandardTheme } from "./themes/StandardTheme";
import { PendoloTheme } from "./themes/PendoloTheme";
import { FumeTheme } from "./themes/FumeTheme";
import { SilkTheme } from "./themes/SilkTheme";

/** Everything a theme draws from. A theme reads this and nothing else. */
export interface ThemeProps {
  track: MusicTrack | null;
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  lyrics: MusicLyrics | null;
  lineIndex: number;
  analyser: AnalyserNode | null;
  theme: NowPlayingTheme;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (volume: number) => void;
  onClose: () => void;
}

export function NowPlayingView({ onClose }: { onClose: () => void }) {
  const music = useMusic();
  const [lyrics, setLyrics] = useState<MusicLyrics | null>(null);
  const [lyricsFor, setLyricsFor] = useState<string | null>(null);
  const playback = music.playback;
  const current = playback?.current ?? null;

  // The lyrics follow the track, not the snapshot: a volume change must not refetch.
  useEffect(() => {
    const trackId = current?.track.id ?? null;
    if (!trackId) { setLyrics(null); setLyricsFor(null); return; }
    if (lyricsFor === trackId) return;
    let cancelled = false;
    void fetch(`/api/music/lyrics?trackId=${encodeURIComponent(trackId)}`)
      .then((response) => response.json() as Promise<MusicLyrics>)
      .then((answer) => {
        if (cancelled) return;
        setLyrics(answer);
        setLyricsFor(trackId);
      })
      .catch(() => {
        if (!cancelled) { setLyrics(null); setLyricsFor(trackId); }
      });
    return () => { cancelled = true; };
  }, [current?.track.id, lyricsFor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === " " && event.target === document.body) { event.preventDefault(); void musicStore.control({ action: playback?.state === "playing" ? "pause" : "play" }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, playback?.state]);

  const positionMs = (playback?.positionSeconds ?? 0) * 1_000;
  const lineIndex = useMemo(() => lineIndexAt(lyrics?.lines ?? [], positionMs), [lyrics?.lines, positionMs]);

  const theme = music.theme;
  const props: ThemeProps = {
    track: current?.track ?? null,
    playing: playback?.state === "playing" || playback?.state === "buffering",
    positionSeconds: playback?.positionSeconds ?? 0,
    durationSeconds: current?.track.durationSeconds ?? 0,
    volume: playback?.volume ?? 70,
    lyrics,
    lineIndex,
    analyser: musicStore.analyser(),
    theme,
    onPlayPause: () => {
      if (music.needsGesture) void musicStore.unlock().then(() => musicStore.control({ action: "play" }));
      else void musicStore.control({ action: playback?.state === "playing" ? "pause" : "play" });
    },
    onPrev: () => void musicStore.control({ action: "prev" }),
    onNext: () => void musicStore.control({ action: "next" }),
    onSeek: (seconds) => void musicStore.control({ action: "seek", positionSeconds: seconds }),
    onVolume: (volume) => void musicStore.control({ action: "volume", volume }),
    onClose,
  };

  const Theme = theme === "pendolo" ? PendoloTheme
    : theme === "fume" ? FumeTheme
    : theme === "sonnet" || theme === "lumiere" || theme === "tempera" ? SilkTheme
    : StandardTheme;

  return (
    <div className="m-np" data-now-playing="" data-open="true" data-theme={theme}>
      {/* The cover as the shared background; the themes paint their own canvas over it. */}
      <div
        className="m-np-bg"
        style={current?.track.coverUrl ? { backgroundImage: `url(${current.track.coverUrl})` } : { background: "#0b0e14" }}
        aria-hidden
      />
      <div className="m-np-dim" aria-hidden />
      <Theme props={props} />

      <div className="m-np-foreground">
        <div className="m-np-topbar">
          <button type="button" className="m-np-glass" onClick={onClose} aria-label={t("music.close")}>
            <svg className="m-svg" width="15" height="15" viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z" /></svg>
          </button>
          <div className="flex items-center gap-2">
            <button type="button" className="m-np-glass" style={{ width: 36, height: 36, borderRadius: 12, background: "transparent", border: "none" }} onClick={() => document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen()}>
              <WindowGlyph name="fullscreen" size={13} />
            </button>
            <button type="button" className="m-np-glass" style={{ width: 36, height: 36, borderRadius: 12, background: "transparent", border: "none" }} onClick={() => void window.ogb?.windowControls?.minimize()}>
              <WindowGlyph name="minimize" size={13} />
            </button>
            <button type="button" className="m-np-glass" style={{ width: 36, height: 36, borderRadius: 12, background: "transparent", border: "none" }} onClick={() => void window.ogb?.windowControls?.toggleMaximize()}>
              <WindowGlyph name="maximize" size={13} />
            </button>
            <button type="button" className="m-np-glass" style={{ width: 36, height: 36, borderRadius: 12, background: "transparent", border: "none" }} onClick={() => void window.ogb?.windowControls?.close()}>
              <WindowGlyph name="close" size={13} />
            </button>
          </div>
        </div>

        <ThemePicker current={theme} />
      </div>

      {music.needsGesture && (
        <div className="absolute inset-x-0 bottom-24 z-20 flex justify-center">
          <button type="button" onClick={() => void musicStore.unlock().then(() => musicStore.control({ action: "play" }))} className="m-np-glass" style={{ width: 160 }}>
            {t("music.tapToPlay")}
          </button>
        </div>
      )}

      {!current && (
        <div className="m-np-no-lyrics">{t("music.nothingPlaying")}</div>
      )}
    </div>
  );
}

/** The theme picker: a 96px pill that drops the six themes out, in upstream's colours. */
function ThemePicker({ current }: { current: NowPlayingTheme }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="m-np-picker" data-expanded={expanded}>
      <div className="m-np-picker-body">
        {NOW_PLAYING_THEMES.map((theme) => (
          <button
            key={theme}
            type="button"
            className="m-np-picker-item"
            aria-pressed={theme === current}
            onClick={() => { void musicStore.setTheme(theme); setExpanded(false); }}
          >
            {THEME_LABELS[theme]}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="m-np-glass"
        style={{ marginTop: 8, width: 96, borderRadius: 18, fontSize: 12, fontWeight: 600 }}
        onClick={() => setExpanded((open) => !open)}
      >
        {THEME_LABELS[current]}
      </button>
    </div>
  );
}

/** The floating player bar every theme but Standard places at its bottom. */
export function FloatingBar({ props, glass = true }: { props: ThemeProps; glass?: boolean }) {
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const duration = Math.max(props.durationSeconds, 1);
  const position = scrubbing ?? props.positionSeconds;

  return (
    <div
      className={cn("mx-auto w-full max-w-3xl", glass && "m-np-glass px-4 py-3")}
      style={glass ? { borderRadius: 18, width: "min(680px, 100%)" } : undefined}
    >
      <div className="flex items-center gap-3">
        {props.track?.coverUrl
          ? <img src={props.track.coverUrl} alt="" className="m-bar-cover" />
          : <span className="m-bar-cover"><MaskIcon src="/music/Default.webp" size={20} /></span>}
        <div className="min-w-0 flex-1">
          <p className="m-bar-title" style={{ color: "#fff" }}>{props.track?.title ?? t("music.nothingPlaying")}</p>
          <p className="m-bar-artist" style={{ color: "rgba(255,255,255,0.8)" }}>{props.track?.artists.join(", ") ?? ""}</p>
        </div>
        <button type="button" onClick={props.onPlayPause} className="m-bar-play" aria-label={props.playing ? t("music.pause") : t("music.play")}>
          <MaskIcon src={props.playing ? "/music/pause-1006-svgrepo-com.svg" : "/music/play-1003-svgrepo-com.svg"} size={22} />
        </button>
      </div>
      <div className="m-bar-progress" style={{ width: "100%" }}>
        <span className="m-bar-time" style={{ color: "rgba(255,255,255,0.7)" }}>{formatDuration(position)}</span>
        <input
          type="range"
          className="m-range"
          min={0}
          max={duration}
          step={1}
          value={position}
          style={{ "--m-range-progress": `${duration ? (position / duration) * 100 : 0}%` } as React.CSSProperties}
          onChange={(event) => setScrubbing(Number(event.target.value))}
          onPointerUp={() => { if (scrubbing !== null) props.onSeek(scrubbing); setScrubbing(null); }}
          aria-label={t("music.seek")}
        />
        <span className="m-bar-time" style={{ color: "rgba(255,255,255,0.7)" }}>{formatDuration(props.durationSeconds)}</span>
      </div>
    </div>
  );
}

/** The lyric column every theme draws, with the current line emphasised. */
export function LyricColumn({ props, className, align = "center" }: { props: ThemeProps; className?: string; align?: "center" | "left" }) {
  const lines = props.lyrics?.lines ?? [];
  const placeholder = lyricsPlaceholder(props.lyrics);
  const activeRef = useCallback((node: HTMLParagraphElement | null) => {
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  if (placeholder) return <p className={cn("m-np-lyric-line", className)}>{placeholder}</p>;
  if (!lines.length) return null;

  return (
    <div className={cn("m-np-lyrics", className)}>
      {lines.map((line, index) => {
        const active = index === props.lineIndex;
        const near = Math.abs(index - props.lineIndex) === 1;
        return (
          <p
            key={`${line.atMs}:${index}`}
            ref={active ? activeRef : undefined}
            onClick={() => props.onSeek(line.atMs / 1_000)}
            className="m-np-lyric-line"
            data-active={active || undefined}
            data-near={near || undefined}
            style={align === "left" ? { textAlign: "left" } : { textAlign: "center" }}
          >
            {line.text || "♪"}
            {line.translation && <span className="m-np-lyric-translation block">{line.translation}</span>}
            {line.romanization && <span className="m-np-lyric-roman block">{line.romanization}</span>}
          </p>
        );
      })}
    </div>
  );
}

export { NOW_PLAYING_THEMES, THEME_LABELS };
