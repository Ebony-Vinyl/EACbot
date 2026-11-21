// Silk: the shell Lumiere, Sonnet and Tempera share, as upstream does. One silk
// backdrop at 60fps with a per-preset palette, a near-black glass stage, and the
// background-material picker (dynamic material / blurred cover) in its flyout.
import { useEffect, useRef, useState } from "react";

import { t } from "@/lib/music/ports";
import type { NowPlayingTheme } from "../../../../../shared/music.ts";
import { MaskIcon } from "../../surface/SurfaceIcons";
import { FloatingBar, LyricColumn, type ThemeProps } from "../NowPlayingView";

const PALETTES: Record<string, string[]> = {
  lumiere: ["255,196,120", "255,236,190", "230,120,80"],
  sonnet: ["150,180,255", "200,220,255", "90,120,220"],
  tempera: ["170,140,255", "220,200,255", "120,90,220"],
};

function SilkBackdrop({ theme }: { theme: NowPlayingTheme }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const palette = PALETTES[theme] ?? PALETTES.lumiere!;
    let phase = 0;
    const draw = (): void => {
      const width = canvas.width = canvas.offsetWidth;
      const height = canvas.height = canvas.offsetHeight;
      phase += 0.005;
      context.clearRect(0, 0, width, height);
      for (let band = 0; band < 4; band++) {
        const base = height * (0.25 + band * 0.18);
        const amplitude = height * (0.1 + band * 0.03);
        context.beginPath();
        for (let x = 0; x <= width; x += 8) {
          const y = base + Math.sin(phase * (band + 1) + x / 240) * amplitude;
          if (x === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        const gradient = context.createLinearGradient(0, base - amplitude, 0, base + amplitude);
        gradient.addColorStop(0, `rgba(${palette[band % palette.length]},0.16)`);
        gradient.addColorStop(1, "rgba(0,0,0,0)");
        context.strokeStyle = gradient;
        context.lineWidth = 60 + band * 26;
        context.stroke();
      }
      raf.current = requestAnimationFrame(draw);
    };
    raf.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf.current);
  }, [theme]);

  return <canvas ref={canvasRef} className="m-np-canvas" />;
}

export function SilkTheme({ props }: { props: ThemeProps }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [material, setMaterial] = useState<"dynamic" | "blur">("dynamic");

  return (
    <div className="absolute inset-0" style={{ background: "#0a0b10" }}>
      {material === "dynamic"
        ? <SilkBackdrop theme={props.theme} />
        : <div className="m-np-canvas" style={{ backgroundImage: props.track?.coverUrl ? `url(${props.track.coverUrl})` : undefined, backgroundSize: "cover", backgroundPosition: "center", filter: "blur(64px)", opacity: 0.4 }} />}

      <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-10">
        <div className="m-np-glass flex flex-col items-center gap-3 px-10 py-8" style={{ width: "min(560px, 86vw)", borderRadius: 20 }}>
          <span className="m-np-artist" style={{ fontSize: 12 }}>{props.track?.artists.join(", ") ?? ""}</span>
          <h1 className="m-np-title" style={{ fontSize: 20, textAlign: "center", whiteSpace: "normal" }}>{props.track?.title ?? t("music.nothingPlaying")}</h1>
          <LyricColumn props={props} className="max-h-[38vh] w-full" />
        </div>
        <FloatingBar props={props} />
      </div>

      <button
        type="button"
        className="m-np-glass m-np-glass--wide"
        style={{ position: "absolute", right: 28, bottom: 26 }}
        onClick={() => setSettingsOpen((open) => !open)}
        aria-label={t("music.np.silk")}
      >
        <MaskIcon src="/music/gear-svgrepo-com.svg" size={18} />
      </button>

      {settingsOpen && (
        <div className="m-np-settings" onMouseLeave={() => setSettingsOpen(false)}>
          <p className="m-np-settings-title">{t("music.np.material")}</p>
          <div className="m-np-choice-row">
            {([["dynamic", "dynamic"], ["blur", "blur"]] as const).map(([key, value]) => (
              <button key={key} type="button" className="m-np-choice" data-active={material === value} onClick={() => setMaterial(value)}>
                {t(key === "dynamic" ? "music.np.materialDynamic" : "music.np.materialBlur")}
                <span className="m-np-choice-grid">
                  {Array.from({ length: 12 }, (_, dot) => (
                    <span key={dot} className="m-np-choice-dot" data-active={material === value && dot === 0} />
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
