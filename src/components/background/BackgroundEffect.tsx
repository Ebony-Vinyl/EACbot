// Ambient motion over the app's ground: drifting petals, glowing fireflies, or blades of grass along the bottom edge.
// Each effect is drawn from a seeded set of elements rather than per-frame work, and all of it is decoration: nothing
// here is focusable, selectable or announced.

import { useEffect, useMemo, useState } from "react";
import type { EffectId } from "@/lib/background-settings";

/** Seeded so a re-render (or React's double invoke in development) draws the same scene instead of reshuffling it. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function Petals({ count }: { count: number }) {
  const petals = useMemo(() => {
    const random = seeded(0x5a4b1);
    return Array.from({ length: count }, (_, index) => ({
      id: index,
      left: random() * 100,
      size: 7 + random() * 11,
      duration: 9 + random() * 10,
      delay: -random() * 20,
      drift: 8 + random() * 14,
    }));
  }, [count]);
  return (
    <>
      {petals.map((petal) => (
        <span
          key={petal.id}
          className="eacbg-petal"
          style={{
            left: `${petal.left}%`,
            width: `${petal.size}px`,
            height: `${petal.size * 1.15}px`,
            animationDuration: `${petal.duration}s`,
            animationDelay: `${petal.delay}s`,
            ["--eacbg-drift" as string]: `${petal.drift}vw`,
          }}
        />
      ))}
    </>
  );
}

function Flies({ count }: { count: number }) {
  const flies = useMemo(() => {
    const random = seeded(0x1f17e5);
    return Array.from({ length: count }, (_, index) => ({
      id: index,
      top: random() * 100,
      left: random() * 100,
      size: 2.5 + random() * 3.5,
      breathe: 3 + random() * 5,
      breatheDelay: -random() * 10,
      float: 18 + random() * 22,
      floatDelay: -random() * 20,
      path: Math.floor(random() * 4) + 1,
    }));
  }, [count]);
  return (
    <>
      {flies.map((fly) => (
        <span
          key={fly.id}
          className="eacbg-fly-holder"
          style={{
            top: `${fly.top}%`,
            left: `${fly.left}%`,
            animationDuration: `${fly.float}s`,
            animationDelay: `${fly.floatDelay}s`,
            animationName: `eacbg-float-${fly.path}`,
          }}
        >
          <span
            className="eacbg-fly"
            style={{
              width: `${fly.size}px`,
              height: `${fly.size}px`,
              animationDuration: `${fly.breathe}s`,
              animationDelay: `${fly.breatheDelay}s`,
            }}
          />
        </span>
      ))}
    </>
  );
}

function Grass({ count }: { count: number }) {
  const blades = useMemo(() => {
    const random = seeded(0x9e3779b9);
    return Array.from({ length: count }, (_, index) => ({
      id: index,
      left: (index / count) * 100 + (random() - 0.5) * 0.6,
      height: 26 + random() * 54,
      width: 1 + random() * 2,
      sway: 3 + random() * 4,
      delay: -random() * 10,
      opacity: 0.16 + random() * 0.34,
      curveLeft: random() > 0.5,
    }));
  }, [count]);
  return (
    <>
      {blades.map((blade) => (
        <span
          key={blade.id}
          className="eacbg-blade-holder"
          style={{
            left: `${blade.left}%`,
            height: `${blade.height}px`,
            width: `${blade.width * 4}px`,
            opacity: blade.opacity,
            animationDuration: `${blade.sway}s`,
            animationDelay: `${blade.delay}s`,
          }}
        >
          <span
            className="eacbg-blade"
            style={{
              width: `${blade.width}px`,
              borderRadius: blade.curveLeft ? "100% 0 0 100%" : "0 100% 100% 0",
              transform: blade.curveLeft ? "translateX(50%)" : "translateX(-50%)",
            }}
          />
        </span>
      ))}
    </>
  );
}

/** The ambient layer. Null when there is nothing to draw, or when the system asks for less motion. */
export function BackgroundEffect({ effect }: { effect: EffectId }) {
  const reduced = useReducedMotion();
  if (effect === "none" || reduced) return null;
  return (
    <div className="eacbg-effect" aria-hidden="true" data-background-effect={effect}>
      {effect === "sakura" && <Petals count={34} />}
      {effect === "fireflies" && <Flies count={42} />}
      {effect === "grass" && <Grass count={130} />}
    </div>
  );
}
