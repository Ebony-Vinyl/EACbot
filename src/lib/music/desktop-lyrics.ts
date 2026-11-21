// Drives the desktop lyric strip from whatever is playing, whether or not the
// now-playing layer is open. The strip is this computer's own window, so a remote
// page has no bridge for it and this does nothing there.
import { useEffect, useRef, useState } from "react";

import type { MusicLyrics } from "../../../shared/music.ts";
import { lineIndexAt } from "./lyrics";
import { useMusic } from "./store";

/** The bridge the preload exposes; absent in a browser and on a remote page. */
function stripBridge() {
  return typeof window !== "undefined" ? window.ogb?.musicLyrics : undefined;
}

export function useDesktopLyrics(): void {
  const music = useMusic();
  const bridge = stripBridge();
  const [enabled, setEnabled] = useState(false);
  const [lyrics, setLyrics] = useState<MusicLyrics | null>(null);
  const trackId = music.playback?.current?.track.id ?? null;
  const positionMs = (music.playback?.positionSeconds ?? 0) * 1_000;
  const lineIndex = lineIndexAt(lyrics?.lines ?? [], positionMs);
  /** The line already pushed, so a position tick does not re-send the whole timeline. */
  const pushed = useRef<string>("");

  // Whether the strip is wanted is a settings flag; read it once.
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void fetch("/api/config")
      .then((response) => response.json() as Promise<{ music?: { desktopLyrics?: boolean } }>)
      .then((config) => { if (!cancelled) setEnabled(config.music?.desktopLyrics === true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [bridge]);

  // Lyrics follow the track, not the snapshot.
  useEffect(() => {
    if (!bridge || !enabled || !trackId) { setLyrics(null); return; }
    let cancelled = false;
    void fetch(`/api/music/lyrics?trackId=${encodeURIComponent(trackId)}`)
      .then((response) => response.json() as Promise<MusicLyrics>)
      .then((answer) => { if (!cancelled) setLyrics(answer); })
      .catch(() => { if (!cancelled) setLyrics(null); });
    return () => { cancelled = true; };
  }, [bridge, enabled, trackId]);

  useEffect(() => {
    if (!bridge || !enabled) return;
    if (!lyrics?.lines.length) {
      void bridge.hide();
      pushed.current = "";
      return;
    }
    // The whole timeline goes once per track; after that only the index moves.
    const key = `${trackId}:${lineIndex}`;
    if (pushed.current === key) return;
    pushed.current = key;
    void bridge.show({ lines: lyrics.lines.map((line) => ({ text: line.text })), index: lineIndex });
  }, [bridge, enabled, lyrics, lineIndex, trackId]);

  useEffect(() => {
    if (!bridge) return;
    return () => { void bridge.hide(); };
  }, [bridge]);
}
