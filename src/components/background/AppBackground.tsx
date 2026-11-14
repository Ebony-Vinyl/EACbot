// The app's ground: a rotating set of bundled wallpapers or one picture the person chose, faded between, with a veil
// over it so the app's own surfaces keep their contrast. Mounted once, behind everything, and inert otherwise.

import { useEffect, useMemo, useState } from "react";
import {
  drawsBackground,
  FADE_MS,
  useBackgroundSettings,
  WALLPAPERS,
  type BackgroundSettings,
} from "@/lib/background-settings";
import { useBackgroundPicture } from "@/lib/background-picture";
import { BackgroundEffect } from "./BackgroundEffect";
import "./background.css";

/** The pictures to cycle, or a single entry for a chosen picture. */
function sourcesFor(settings: BackgroundSettings, pictureUrl: string | null): readonly string[] {
  if (settings.mode === "picture") return pictureUrl ? [pictureUrl] : [];
  if (settings.mode === "wallpaper") return WALLPAPERS;
  return [];
}

/**
 * Which picture is showing, and which is fading out beneath it. Advancing swaps the pair rather than re-mounting, so the
 * outgoing picture keeps painting through its own fade instead of the ground blinking to the skin colour.
 */
function useRotation(
  sources: readonly string[],
  seconds: number,
): { current: string | null; previous: string | null; previousAt: number } {
  const [index, setIndex] = useState(0);
  const [previous, setPrevious] = useState<string | null>(null);
  const [previousAt, setPreviousAt] = useState(0);
  const count = sources.length;

  useEffect(() => {
    setIndex(0);
    setPrevious(null);
  }, [count]);

  useEffect(() => {
    if (count <= 1) return;
    const timer = window.setInterval(() => {
      setIndex((at) => {
        const next = (at + 1) % count;
        setPrevious(sources[at] ?? null);
        setPreviousAt(Date.now());
        return next;
      });
    }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [count, seconds, sources]);

  useEffect(() => {
    if (previous === null) return;
    const timer = window.setTimeout(() => setPrevious(null), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [previous, previousAt]);

  return { current: sources[Math.min(index, Math.max(0, count - 1))] ?? null, previous, previousAt };
}

/** Preloads the next picture so a rotation never fades into a blank frame. */
function usePreload(sources: readonly string[], current: string | null): void {
  useEffect(() => {
    if (!current || sources.length <= 1) return;
    const at = sources.indexOf(current);
    const next = sources[(at + 1) % sources.length];
    if (!next) return;
    const image = new Image();
    image.src = next;
    return () => {
      image.src = "";
    };
  }, [current, sources]);
}

export function AppBackground() {
  const settings = useBackgroundSettings();
  const picture = useBackgroundPicture();
  const sources = useMemo(() => sourcesFor(settings, picture?.url ?? null), [settings, picture?.url]);
  const { current, previous, previousAt } = useRotation(sources, settings.rotateSeconds);
  usePreload(sources, current);
  const live = drawsBackground(settings, Boolean(picture?.url)) && Boolean(current);

  // The app's panes are opaque by default; this flag is what lets the picture through them. Set here rather than in a
  // layout effect so it goes away with the component, whichever page unmounts it.
  useEffect(() => {
    const root = document.documentElement;
    if (live) root.dataset.backgroundLive = "";
    else delete root.dataset.backgroundLive;
    return () => {
      delete root.dataset.backgroundLive;
    };
  }, [live]);

  if (!live || !current) return null;

  return (
    <div
      className="eacbg"
      aria-hidden="true"
      data-background-mode={settings.mode}
      style={{
        ["--eacbg-strength" as string]: settings.strength / 100,
        ["--eacbg-veil" as string]: settings.veil / 100,
        ["--eacbg-fade" as string]: `${FADE_MS}ms`,
      }}
    >
      <div className="eacbg-pictures">
        {previous && (
          <div key={`out-${previousAt}`} className="eacbg-picture eacbg-picture-out" style={{ backgroundImage: `url(${previous})` }} />
        )}
        <div key={current} className="eacbg-picture" style={{ backgroundImage: `url(${current})` }} />
      </div>
      <div className="eacbg-wash" />
      <div className="eacbg-veil" />
      <BackgroundEffect effect={settings.effect} />
    </div>
  );
}
