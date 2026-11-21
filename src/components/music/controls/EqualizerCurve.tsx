// The ten-band curve, drawn and draggable. The curve is a Catmull-Rom spline
// through the band gains, so the shape reads like an equalizer rather than ten
// disconnected bars; a drag sets that band's gain and the audio graph follows.
import { useCallback, useRef } from "react";

import { MUSIC_EQ_BANDS_HZ } from "../../../../shared/music.ts";
import { t } from "@/lib/music/ports";

const HEIGHT = 96;
const PADDING = 8;
const MIN_GAIN = -15;
const MAX_GAIN = 15;

/** A band's x position on the logarithmic frequency axis upstream draws. */
function bandX(frequency: number, usable: number): number {
  return PADDING + (usable * Math.log(frequency / 32)) / Math.log(500);
}

function pointsFor(gains: readonly number[], width: number): Array<{ x: number; y: number }> {
  const usable = Math.max(width - PADDING * 2, 1);
  return gains.map((gain, index) => ({
    x: bandX(MUSIC_EQ_BANDS_HZ[index]!, usable),
    y: PADDING + ((MAX_GAIN - gain) / (MAX_GAIN - MIN_GAIN)) * (HEIGHT - PADDING * 2),
  }));
}

/** A smooth path through the points, with the control points pulled to a horizontal tangent. */
function splinePath(points: ReadonlyArray<{ x: number; y: number }>): string {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 0; index < points.length - 1; index++) {
    const current = points[index]!;
    const next = points[index + 1]!;
    const midX = (current.x + next.x) / 2;
    path += ` C ${midX} ${current.y}, ${midX} ${next.y}, ${next.x} ${next.y}`;
  }
  return path;
}

export function EqualizerCurve({ gains, onChange }: {
  gains: readonly number[];
  onChange: (index: number, gain: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const width = 480;
  const points = pointsFor(gains, width);
  const path = splinePath(points);
  const zeroY = PADDING + ((MAX_GAIN - 0) / (MAX_GAIN - MIN_GAIN)) * (HEIGHT - PADDING * 2);

  const gainAt = useCallback((clientY: number): number => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return 0;
    const ratio = (clientY - box.top) / box.height;
    const gain = MAX_GAIN - ratio * (MAX_GAIN - MIN_GAIN);
    return Math.round(Math.min(Math.max(gain, MIN_GAIN), MAX_GAIN));
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="w-full touch-none select-none"
        role="group"
        aria-label={t("music.eq.curve")}
      >
        <line x1={PADDING} y1={zeroY} x2={width - PADDING} y2={zeroY} stroke="currentColor" className="text-hairline/40" strokeWidth={1} strokeDasharray="3 4" />
        <path d={`${path} L ${width - PADDING} ${zeroY} L ${PADDING} ${zeroY} Z`} fill="currentColor" className="text-accent/12" />
        <path d={path} fill="none" stroke="currentColor" className="text-accent" strokeWidth={1.6} strokeLinecap="round" />
        {points.map((point, index) => (
          <circle
            key={index}
            cx={point.x}
            cy={point.y}
            r={5}
            fill="currentColor"
            className="cursor-ns-resize text-accent"
            tabIndex={0}
            role="slider"
            aria-label={`${MUSIC_EQ_BANDS_HZ[index]} Hz`}
            aria-valuemin={MIN_GAIN}
            aria-valuemax={MAX_GAIN}
            aria-valuenow={gains[index] ?? 0}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              onChange(index, gainAt(event.clientY));
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              onChange(index, gainAt(event.clientY));
            }}
            onKeyDown={(event) => {
              const current = gains[index] ?? 0;
              if (event.key === "ArrowUp") { event.preventDefault(); onChange(index, Math.min(current + 1, MAX_GAIN)); }
              if (event.key === "ArrowDown") { event.preventDefault(); onChange(index, Math.max(current - 1, MIN_GAIN)); }
            }}
          />
        ))}
      </svg>
      <div className="flex justify-between px-1 text-[9px] tabular-nums text-ink-secondary/70">
        {MUSIC_EQ_BANDS_HZ.map((frequency) => (
          <span key={frequency}>{frequency >= 1_000 ? `${frequency / 1_000}k` : frequency}</span>
        ))}
      </div>
    </div>
  );
}
