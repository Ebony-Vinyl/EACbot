// The OS media overlay (SMTC on Windows, MPRIS on Linux, Now Playing on macOS):
// Chromium builds it from the standard MediaSession API, so publishing the
// current track here is the whole integration. Position updates are throttled to
// 750 ms, the cadence upstream uses for its native session.
import type { MusicPlayback } from "../../../shared/music.ts";
import { musicStore } from "./store";

let lastPositionPush = 0;

function stateOf(playback: MusicPlayback): MediaSessionPlaybackState {
  if (playback.state === "playing") return "playing";
  if (playback.state === "paused" || playback.state === "buffering") return "paused";
  return "none";
}

/** Reports what is playing to the operating system; safe to call from any mount. */
export function publishMediaSession(playback: MusicPlayback | null): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const session = navigator.mediaSession;
  const current = playback?.current ?? null;

  if (!playback || !current || playback.state === "idle") {
    session.metadata = null;
    session.playbackState = "none";
    return;
  }

  session.metadata = new MediaMetadata({
    title: current.track.title,
    artist: current.track.artists.join(", "),
    album: current.track.album ?? "",
    ...(current.track.coverUrl ? { artwork: [{ src: current.track.coverUrl, sizes: "512x512" }] } : {}),
  });
  session.playbackState = stateOf(playback);

  session.setActionHandler("play", () => void musicStore.control({ action: "play" }));
  session.setActionHandler("pause", () => void musicStore.control({ action: "pause" }));
  session.setActionHandler("previoustrack", () => void musicStore.control({ action: "prev" }));
  session.setActionHandler("nexttrack", () => void musicStore.control({ action: "next" }));
  session.setActionHandler("seekto", (details) => {
    if (typeof details.seekTime === "number") void musicStore.control({ action: "seek", positionSeconds: details.seekTime });
  });

  const duration = current.track.durationSeconds;
  const now = Date.now();
  if (duration > 0 && "setPositionState" in session && now - lastPositionPush >= 750) {
    lastPositionPush = now;
    try {
      session.setPositionState({ duration, position: Math.min(playback.positionSeconds, duration), playbackRate: playback.speed || 1 });
    } catch {
      // A stale position after a track change is not worth reporting.
    }
  }
}
