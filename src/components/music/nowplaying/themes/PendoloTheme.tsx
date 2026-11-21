// Pendolo: the full-bleed spectrum with the deep navy glass card, pointer
// parallax on the content, and the four-slider tuning panel upstream's gear opens
// (max tilt, response, origin X and Y) plus restore-to-default.
import { useEffect, useRef, useState } from "react";

import { t } from "@/lib/music/ports";
import { MaskIcon } from "../../surface/SurfaceIcons";
import { FloatingBar, LyricColumn, type ThemeProps } from "../NowPlayingView";

const DEFAULT_PARALLAX = { tilt: 6, response: 40, originX: 50, originY: 50 };

function PendoloSpectrum({ analyser }: { analyser: AnalyserNode | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const bins = new Uint8Array(analyser ? analyser.frequencyBinCount : 64);
    const smooth = new Float32Array(48);
    const draw = (): void => {
      const width = canvas.width = canvas.offsetWidth;
      const height = canvas.height = canvas.offsetHeight;
      context.clearRect(0, 0, width, height);
      if (analyser) analyser.getByteFrequencyData(bins);
      const bars = smooth.length;
      for (let index = 0; index < bars; index++) {
        const raw = analyser ? bins[Math.floor((index / bars) * bins.length * 0.5)]! / 255 : 0;
        smooth[index] = smooth[index]! * 0.72 + raw * 0.28;
        const value = smooth[index]!;
        const barHeight = Math.max(value * height * 0.72, 3);
        const x = (index / bars) * width;
        const gradient = context.createLinearGradient(0, height - barHeight, 0, height);
        gradient.addColorStop(0, "rgba(126,231,255,0.85)");
        gradient.addColorStop(1, "rgba(126,231,255,0.05)");
        context.fillStyle = gradient;
        context.fillRect(x + 2, height - barHeight, width / bars - 4, barHeight);
      }
      raf.current = requestAnimationFrame(draw);
    };
    raf.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf.current);
  }, [analyser]);

  return <canvas ref={canvasRef} className="m-np-canvas" />;
}

export function PendoloTheme({ props }: { props: ThemeProps }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [parallax, setParallax] = useState(DEFAULT_PARALLAX);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const box = contentRef.current?.getBoundingClientRect();
      if (!box) return;
      const originX = box.left + (box.width * parallax.originX) / 100;
      const originY = box.top + (box.height * parallax.originY) / 100;
      const tiltX = ((event.clientY - originY) / box.height) * parallax.tilt * parallax.response * 0.02;
      const tiltY = ((event.clientX - originX) / box.width) * parallax.tilt * parallax.response * 0.02;
      contentRef.current?.style.setProperty("transform", `perspective(1200px) rotateX(${(-tiltX).toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg)`);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [parallax]);

  return (
    <div className="absolute inset-0" style={{ background: "rgba(10,20,32,0.72)" }}>
      <PendoloSpectrum analyser={props.analyser} />

      <div ref={contentRef} className="absolute inset-0 flex flex-col items-center justify-center gap-8 px-10" style={{ transformStyle: "preserve-3d" }}>
        <div className="m-np-glass" style={{ width: 200, height: 200, borderRadius: 20, background: "rgba(10,20,32,0.88)", border: "1px solid rgba(126,231,255,0.35)", overflow: "hidden" }}>
          {props.track?.coverUrl ? <img src={props.track.coverUrl} alt="" className="size-full object-cover" /> : null}
        </div>
        <h1 className="m-np-title" style={{ textAlign: "center" }}>{props.track?.title ?? t("music.nothingPlaying")}</h1>
        <span className="m-np-artist" style={{ fontSize: 14 }}>{props.track?.artists.join(", ") ?? ""}</span>
        <LyricColumn props={props} />
        <FloatingBar props={props} />
      </div>

      <button
        type="button"
        className="m-np-glass m-np-glass--wide"
        style={{ position: "absolute", right: 28, bottom: 26 }}
        onClick={() => setSettingsOpen((open) => !open)}
        aria-label={t("music.np.parallax")}
      >
        <MaskIcon src="/music/gear-svgrepo-com.svg" size={18} />
      </button>

      {settingsOpen && (
        <div className="m-np-settings" onMouseLeave={() => setSettingsOpen(false)}>
          <p className="m-np-settings-title">{t("music.np.parallax")}</p>
          {([
            ["tilt", "music.np.tilt", 1, 12],
            ["response", "music.np.response", 10, 100],
            ["originX", "music.np.originX", 0, 100],
            ["originY", "music.np.originY", 0, 100],
          ] as const).map(([key, label, min, max]) => (
            <label key={key} className="m-np-slider-row">
              <span>{t(label)}</span>
              <input
                type="range"
                className="m-range"
                min={min}
                max={max}
                value={parallax[key]}
                style={{ "--m-range-progress": `${((parallax[key] - min) / (max - min)) * 100}%` } as React.CSSProperties}
                onChange={(event) => setParallax((current) => ({ ...current, [key]: Number(event.target.value) }))}
              />
            </label>
          ))}
          <button type="button" className="m-np-more-item" onClick={() => setParallax(DEFAULT_PARALLAX)}>{t("music.np.restore")}</button>
        </div>
      )}
    </div>
  );
}
