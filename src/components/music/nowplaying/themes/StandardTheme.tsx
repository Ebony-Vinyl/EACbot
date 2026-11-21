// The Standard theme, drawn to upstream's StandardNowPlayingThemeView: a 4:6
// split with the 320px glass cover and transport left, the lyrics column right,
// the portrait-mode glass button under the close bar, and the soft visualizer
// glow along the bottom.
import { useEffect, useRef, useState } from "react";

import { t } from "@/lib/music/ports";
import { MaskIcon } from "../../surface/SurfaceIcons";
import { LyricColumn, type ThemeProps } from "../NowPlayingView";

/** A thin bar visualizer painted from the analyser, under the radial glow mask. */
function StandardGlow({ analyser }: { analyser: AnalyserNode | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const bins = new Uint8Array(analyser ? analyser.frequencyBinCount : 64);
    const draw = (): void => {
      const width = canvas.width = canvas.offsetWidth;
      const height = canvas.height = canvas.offsetHeight;
      context.clearRect(0, 0, width, height);
      if (analyser) analyser.getByteFrequencyData(bins);
      const bars = 72;
      const barWidth = width / bars;
      for (let index = 0; index < bars; index++) {
        const value = analyser ? bins[Math.floor((index / bars) * bins.length * 0.6)]! / 255 : 0;
        const barHeight = Math.max(value * height * 0.8, 2);
        context.fillStyle = `rgba(255,255,255,${0.05 + value * 0.25})`;
        context.fillRect(index * barWidth + barWidth * 0.2, height - barHeight, barWidth * 0.6, barHeight);
      }
      raf.current = requestAnimationFrame(draw);
    };
    raf.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf.current);
  }, [analyser]);

  return (
    <canvas
      ref={canvasRef}
      className="m-np-canvas"
      style={{
        top: "auto",
        bottom: -24,
        height: 235,
        opacity: 0.2,
        maskImage: "radial-gradient(80% 70% at 50% 100%, #000 35%, transparent 100%)",
        WebkitMaskImage: "radial-gradient(80% 70% at 50% 100%, #000 35%, transparent 100%)",
      }}
    />
  );
}

export function StandardTheme({ props }: { props: ThemeProps }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [volumeVisible, setVolumeVisible] = useState(false);
  const duration = Math.max(props.durationSeconds, 1);
  const progress = (props.positionSeconds / duration) * 100;

  return (
    <div className="absolute inset-0">
      <StandardGlow analyser={props.analyser} />

      <button type="button" className="m-np-glass" style={{ position: "absolute", left: 40, top: 94 }} aria-label={t("music.nowPlaying")}>
        <MaskIcon src="/music/portrait-mode.svg" size={22} />
      </button>

      <div className="m-np-standard">
        <div className="m-np-standard-left">
          {props.track?.coverUrl
            ? <img className="m-np-cover-card" src={props.track.coverUrl} alt="" />
            : <span className="m-np-cover-card" />}
          <div className="m-np-track-info">
            <h1 className="m-np-title">{props.track?.title ?? t("music.nothingPlaying")}</h1>
            <span className="m-np-artist">{props.track?.artists.join(", ") ?? ""}</span>
            <div className="m-np-controls" style={{ justifyContent: "flex-start" }}>
              <button type="button" className="m-np-btn" aria-label={t("music.favorite")}>
                <MaskIcon src="/music/FavoriteBorder.svg" size={20} />
              </button>
              <button type="button" className="m-np-btn" onClick={props.onPrev} aria-label={t("music.previous")}>
                <MaskIcon src="/music/backward.svg" size={18} />
              </button>
              <button type="button" className="m-np-btn" onClick={props.onPlayPause} aria-label={props.playing ? t("music.pause") : t("music.play")}>
                <MaskIcon src={props.playing ? "/music/pause-1006-svgrepo-com.svg" : "/music/play-1003-svgrepo-com.svg"} size={24} />
              </button>
              <button type="button" className="m-np-btn" onClick={props.onNext} aria-label={t("music.next")}>
                <MaskIcon src="/music/next-svgrepo-com.svg" size={18} />
              </button>
              <button type="button" className="m-np-btn" onClick={() => setMoreOpen((open) => !open)} aria-label={t("music.more")}>
                <MaskIcon src="/music/More.svg" size={22} />
              </button>
            </div>
            <div className="m-np-progress">
              <input
                type="range"
                className="m-range"
                min={0}
                max={duration}
                step={1}
                value={props.positionSeconds}
                style={{ "--m-range-progress": `${progress}%` } as React.CSSProperties}
                onChange={(event) => props.onSeek(Number(event.target.value))}
                aria-label={t("music.seek")}
              />
            </div>
          </div>
        </div>

        <LyricColumn props={props} />
      </div>

      {moreOpen && (
        <div className="m-np-more" onMouseLeave={() => setMoreOpen(false)}>
          <button type="button" className="m-np-more-item" onClick={() => setMoreOpen(false)}>
            <MaskIcon src="/music/translation-svgrepo-com.svg" size={18} />
            <span>
              <span className="m-np-more-title block">{t("music.np.lyricMode")}</span>
              <span className="m-np-more-desc block">{props.lyrics?.lines.some((line) => line.translation) ? t("music.np.lyricModeOn") : t("music.np.lyricModeOff")}</span>
            </span>
          </button>
          <button type="button" className="m-np-more-item" onClick={() => setVolumeVisible((visible) => !visible)}>
            <MaskIcon src="/music/VolumeUp.svg" size={18} />
            <span>
              <span className="m-np-more-title block">{t("music.volume")}</span>
              <span className="m-np-more-desc block">{t("music.np.volumeHint")}</span>
            </span>
          </button>
          {volumeVisible && (
            <input
              type="range"
              className="m-range"
              min={0}
              max={100}
              step={1}
              value={props.volume}
              style={{ "--m-range-progress": `${props.volume}%`, margin: "0 8px 8px" } as React.CSSProperties}
              onChange={(event) => props.onVolume(Number(event.target.value))}
              aria-label={t("music.volume")}
            />
          )}
        </div>
      )}
    </div>
  );
}
