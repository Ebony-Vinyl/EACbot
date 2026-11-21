// Fume: the cinematic scene over a warm material the cover tints, the hero title
// with an adjustable glow, the translation and romanization cards above the bar,
// and the tuning panel (glow, lyric scale, background material).
import { useEffect, useRef, useState } from "react";

import { t } from "@/lib/music/ports";
import { MaskIcon } from "../../surface/SurfaceIcons";
import { FloatingBar, LyricColumn, type ThemeProps } from "../NowPlayingView";

function FumeMaterial({ coverUrl, blur }: { coverUrl: string | null; blur: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let phase = 0;
    const draw = (): void => {
      const width = canvas.width = canvas.offsetWidth;
      const height = canvas.height = canvas.offsetHeight;
      phase += 0.004;
      context.clearRect(0, 0, width, height);
      for (let index = 0; index < 3; index++) {
        const x = width * (0.3 + 0.24 * Math.sin(phase * (index + 1)));
        const y = height * (0.42 + 0.2 * Math.cos(phase * (index + 2)));
        const radius = Math.min(width, height) * (0.36 + 0.08 * Math.sin(phase + index));
        const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, `rgba(${64 + index * 46},${30 + index * 16},${index === 2 ? 18 : 8},0.5)`);
        gradient.addColorStop(1, "rgba(0,0,0,0)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);
      }
      raf.current = requestAnimationFrame(draw);
    };
    raf.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  if (blur && coverUrl) return <div className="m-np-canvas" style={{ backgroundImage: `url(${coverUrl})`, backgroundSize: "cover", backgroundPosition: "center", filter: "blur(64px)", opacity: 0.55 }} />;
  return <canvas ref={canvasRef} className="m-np-canvas" style={{ opacity: 0.8 }} />;
}

export function FumeTheme({ props }: { props: ThemeProps }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [glow, setGlow] = useState(60);
  const [scale, setScale] = useState(100);
  const [blurMaterial, setBlurMaterial] = useState(false);

  return (
    <div className="absolute inset-0" style={{ background: "#120806" }}>
      <FumeMaterial coverUrl={props.track?.coverUrl ?? null} blur={blurMaterial} />

      <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-10">
        <h1
          className="m-np-title"
          style={{
            fontSize: (44 + glow * 0.2) * (scale / 100),
            fontWeight: 600,
            textAlign: "center",
            textShadow: `0 0 ${20 + glow * 0.6}px rgba(255,214,170,${glow / 140})`,
            maxWidth: "80vw",
          }}
        >
          {props.track?.title ?? t("music.nothingPlaying")}
        </h1>
        <div style={{ fontSize: `${scale}%` }} className="w-full flex-1 min-h-0 flex items-center">
          <LyricColumn props={props} className="max-h-[46vh]" />
        </div>
        <FloatingBar props={props} />
      </div>

      <button
        type="button"
        className="m-np-glass m-np-glass--wide"
        style={{ position: "absolute", right: 28, bottom: 26 }}
        onClick={() => setSettingsOpen((open) => !open)}
        aria-label={t("music.np.fume")}
      >
        <MaskIcon src="/music/gear-svgrepo-com.svg" size={18} />
      </button>

      {settingsOpen && (
        <div className="m-np-settings" onMouseLeave={() => setSettingsOpen(false)}>
          <p className="m-np-settings-title">{t("music.np.fume")}</p>
          <label className="m-np-slider-row">
            <span>{t("music.np.glow")}</span>
            <input type="range" className="m-range" min={0} max={100} value={glow} style={{ "--m-range-progress": `${glow}%` } as React.CSSProperties} onChange={(event) => setGlow(Number(event.target.value))} />
          </label>
          <label className="m-np-slider-row">
            <span>{t("music.np.lyricScale")}</span>
            <input type="range" className="m-range" min={80} max={140} value={scale} style={{ "--m-range-progress": `${((scale - 80) / 60) * 100}%` } as React.CSSProperties} onChange={(event) => setScale(Number(event.target.value))} />
          </label>
          <div className="m-np-choice-row">
            {([["dynamic", false], ["blur", true]] as const).map(([key, value]) => (
              <button key={key} type="button" className="m-np-choice" data-active={blurMaterial === value} onClick={() => setBlurMaterial(value)}>
                {t(key === "dynamic" ? "music.np.materialDynamic" : "music.np.materialBlur")}
                <span className="m-np-choice-grid">
                  {Array.from({ length: 12 }, (_, dot) => (
                    <span key={dot} className="m-np-choice-dot" data-active={blurMaterial === value && dot === 0} />
                  ))}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
