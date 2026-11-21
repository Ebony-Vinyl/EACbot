// The spectrum the now-playing themes draw, and the silk backdrop they share.
// Both read the engine's analyser and paint on a canvas; neither uses a library.
// Animation is driven by requestAnimationFrame inside the canvas, which is the one
// place a frame loop belongs (a DOM property cannot carry 60 fps).
import { useEffect, useRef } from "react";

/** The frequency bars, as Pendolo and Fume draw them. */
export function AudioVisualizer({ analyser, bars = 64, color = "currentColor", mirrored = true, className, style }: {
  analyser: AnalyserNode | null;
  bars?: number;
  color?: string;
  mirrored?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const data = new Uint8Array(analyser.frequencyBinCount);

    const paint = () => {
      const box = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(Math.round(box.width), 1);
      const height = Math.max(Math.round(box.height), 1);
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      analyser.getByteFrequencyData(data);

      const gap = 2;
      const barWidth = (width - gap * (bars - 1)) / bars;
      const half = height / 2;
      context.fillStyle = color;
      for (let index = 0; index < bars; index++) {
        // The bins are logarithmic to the ear; a linear read makes the bass dominate.
        const from = Math.floor(Math.pow(index / bars, 1.6) * data.length);
        const to = Math.max(Math.floor(Math.pow((index + 1) / bars, 1.6) * data.length), from + 1);
        let sum = 0;
        for (let at = from; at < to; at++) sum += data[at] ?? 0;
        const value = sum / (to - from) / 255;
        const barHeight = Math.max(value * half * 0.92, 1.5);
        const x = index * (barWidth + gap);
        if (mirrored) {
          context.globalAlpha = 0.85;
          context.fillRect(x, half - barHeight, barWidth, barHeight);
          context.globalAlpha = 0.35;
          context.fillRect(x, half, barWidth, barHeight);
        } else {
          context.globalAlpha = 0.85;
          context.fillRect(x, height - barHeight, barWidth, barHeight);
        }
      }
      context.globalAlpha = 1;
      frameRef.current = requestAnimationFrame(paint);
    };

    frameRef.current = requestAnimationFrame(paint);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [analyser, bars, color, mirrored]);

  return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" />;
}

/**
 * The silk backdrop Lumiere, Sonnet and Tempera share: slow ribbons of light that
 * drift with the music's low band, so a loud passage moves the cloth.
 */
export function SilkBackdrop({ analyser, palette, speed = 1, className }: {
  analyser: AnalyserNode | null;
  palette: readonly [string, string, string];
  speed?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    let energy = 0;
    let phase = 0;

    const paint = () => {
      const box = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(Math.round(box.width), 1);
      const height = Math.max(Math.round(box.height), 1);
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      if (analyser && data) {
        analyser.getByteFrequencyData(data);
        // The first eighth of the bins is where a bass line lives.
        let sum = 0;
        const bins = Math.max(Math.floor(data.length / 8), 1);
        for (let index = 0; index < bins; index++) sum += data[index] ?? 0;
        energy += ((sum / bins / 255) - energy) * 0.08;
      }

      context.fillStyle = palette[0];
      context.fillRect(0, 0, width, height);

      phase += 0.0016 * speed * (1 + energy * 2.2);
      const ribbons = 5;
      for (let ribbon = 0; ribbon < ribbons; ribbon++) {
        const t = ribbon / ribbons;
        const drift = Math.sin(phase * 2 + t * Math.PI * 2) * height * 0.18;
        const amplitude = height * (0.10 + energy * 0.16) * (0.6 + t * 0.8);
        const gradient = context.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, palette[1]);
        gradient.addColorStop(1, palette[2]);
        context.globalAlpha = 0.12 + energy * 0.20 + t * 0.06;
        context.fillStyle = gradient;
        context.beginPath();
        context.moveTo(0, height * (0.25 + t * 0.35) + drift);
        for (let x = 0; x <= width; x += 12) {
          const y = height * (0.25 + t * 0.35) + drift
            + Math.sin(x / width * Math.PI * (1.4 + t) + phase * 3) * amplitude;
          context.lineTo(x, y);
        }
        context.lineTo(width, height);
        context.lineTo(0, height);
        context.closePath();
        context.fill();
      }
      context.globalAlpha = 1;
      // A vignette keeps the lyrics legible over the brightest ribbon.
      const vignette = context.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.2, width / 2, height / 2, Math.max(width, height) * 0.75);
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, "rgba(0,0,0,0.55)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, width, height);

      frameRef.current = requestAnimationFrame(paint);
    };

    frameRef.current = requestAnimationFrame(paint);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [analyser, palette, speed]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

/**
 * The pointer-driven tilt Pendolo and Fume expose. Returns the transform to apply
 * and whether the pointer is currently inside, so a theme can show its controls.
 */
export function useParallax(enabled: boolean, maxTiltDeg = 8, response = 0.08) {
  const ref = useRef<HTMLDivElement | null>(null);
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element) return;

    const onMove = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      target.current = {
        x: ((event.clientX - box.left) / box.width - 0.5) * 2,
        y: ((event.clientY - box.top) / box.height - 0.5) * 2,
      };
    };
    const onLeave = () => { target.current = { x: 0, y: 0 }; };

    const tick = () => {
      current.current.x += (target.current.x - current.current.x) * response;
      current.current.y += (target.current.y - current.current.y) * response;
      element.style.transform = `perspective(1200px) rotateY(${current.current.x * maxTiltDeg}deg) rotateX(${-current.current.y * maxTiltDeg}deg)`;
      frameRef.current = requestAnimationFrame(tick);
    };

    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerleave", onLeave);
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerleave", onLeave);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      element.style.transform = "";
    };
  }, [enabled, maxTiltDeg, response]);

  return ref;
}
