// The bar that follows the person across every page. It sits beside the app's own
// overlays, so switching to chat does not stop the music; it collapses to nothing
// when nothing is loaded, so it costs no space until there is something to show.
import { useEffect, useRef, useState } from "react";
import { ChevronUp, ListMusic, Loader2, Maximize2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";

import { formatDuration } from "../../../../shared/music.ts";
import { cn } from "@/lib/music/ports";
import { t } from "@/lib/music/ports";
import { useDesktopLyrics } from "@/lib/music/desktop-lyrics";
import { installSpeechFocus } from "@/lib/music/focus-bridge";
import { musicStore, useMusic } from "@/lib/music/store";
import { publishMediaSession } from "@/lib/music/smtc";
import { Slider } from "@/lib/music/ports";

/** A cover, or a neutral placeholder so a row never jumps when an image loads. */
export function MusicCover({ src, size = 40, alt }: { src: string | null; size?: number; alt?: string }) {
  const [broken, setBroken] = useState(false);
  const show = src && !broken ? src : null;
  return (
    <span
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-md bg-raised"
      style={{ width: size, height: size }}
    >
      {show
        ? <img src={show} alt={alt ?? ""} className="size-full object-cover" onError={() => setBroken(true)} loading="lazy" />
        : <ListMusic size={Math.max(12, Math.round(size * 0.4))} className="text-ink-secondary" aria-hidden="true" />}
    </span>
  );
}

export function MiniPlayer({ onOpenMusic, onOpenNowPlaying }: {
  onOpenMusic: () => void;
  onOpenNowPlaying: () => void;
}) {
  const music = useMusic();
  useDesktopLyrics();
  const playback = music.playback;
  const current = playback?.current ?? null;

  // The OS media overlay is a second face of the same state.
  useEffect(() => { publishMediaSession(playback); }, [playback]);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  // The store starts with nothing; read once and follow the server's frames after that.
  useEffect(() => {
    musicStore.connect();
    void musicStore.load();
    // Speech and music share the speaker: the first mount is where the claim is made.
    installSpeechFocus();
    return () => { void musicStore.disconnect(); };
  }, []);

  // The tray is a second face of this same player: it shows what is playing and
  // sends its clicks back here, so there is still one queue and one revision.
  const tray = typeof window !== "undefined" ? window.ogb?.musicLyrics : undefined;
  const trayTitle = current?.track.title ?? "";
  const trayArtists = current?.track.artists.join(", ") ?? "";
  const trayPlaying = playback?.state === "playing" || playback?.state === "buffering";
  useEffect(() => {
    if (!tray) return;
    void tray.trayState(trayTitle ? { title: trayTitle, artists: trayArtists, playing: trayPlaying } : null);
  }, [tray, trayTitle, trayArtists, trayPlaying]);
  useEffect(() => {
    if (!tray) return;
    return tray.onTrayCommand((command) => {
      if (command === "next") void musicStore.control({ action: "next" });
      else if (command === "previous") void musicStore.control({ action: "prev" });
      else void musicStore.control({ action: trayPlaying ? "pause" : "play" });
    });
  }, [tray, trayPlaying]);

  // A browser refuses audio before a gesture; the bar is the first thing the person
  // can tap, so it is the natural place to unlock the graph.
  useEffect(() => {
    if (!playback || playback.state !== "buffering") return;
    void musicStore.unlock();
  }, [playback?.state]);

  const duration = current?.track.durationSeconds ?? 0;
  const position = scrubbing ?? playback?.positionSeconds ?? 0;
  const playing = playback?.state === "playing" || playback?.state === "buffering";
  const muted = (playback?.volume ?? 0) === 0;

  if (!playback || !current) return null;

  const repeatIcon = playback.repeat === "one" ? Repeat1 : Repeat;

  return (
    <div
      ref={barRef}
      data-music-mini=""
      className={cn(
        "relative z-30 flex shrink-0 items-center gap-3 border-t border-hairline/40 bg-panel/95 px-3 backdrop-blur-sm",
        "h-[58px]",
      )}
      role="region"
      aria-label={t("music.mini.label")}
    >
      {/* A hairline progress line above the bar, so a glance is enough. */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-accent/70 transition-[width] duration-150"
        style={{ width: `${duration > 0 ? Math.min((position / duration) * 100, 100) : 0}%` }}
        aria-hidden="true"
      />

      <button type="button" onClick={onOpenNowPlaying} className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded-lg">
        <MusicCover src={current.track.coverUrl} size={40} alt={current.track.title} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-tight text-ink">{current.track.title}</span>
          <span className="block truncate text-[11px] leading-tight text-ink-secondary">
            {current.track.artists.join(", ") || t("music.unknownArtist")}
            {playback.ducked ? ` · ${t("music.ducked")}` : ""}
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => void musicStore.control({ action: "prev" })} className="grid size-8 place-items-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("music.previous")}>
          <SkipBack size={15} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (music.needsGesture || !playing) void musicStore.unlock().then(() => musicStore.control({ action: playing ? "pause" : "play" }));
            else void musicStore.control({ action: "pause" });
          }}
          className="grid size-9 place-items-center rounded-full bg-accent text-app hover:brightness-110"
          aria-label={playing ? t("music.pause") : t("music.play")}
        >
          {music.loading ? <Loader2 size={16} className="animate-spin" /> : playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button type="button" onClick={() => void musicStore.control({ action: "next" })} className="grid size-8 place-items-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("music.next")}>
          <SkipForward size={15} />
        </button>
      </div>

      <span className="hidden shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-ink-secondary sm:flex">
        <span>{formatDuration(position)}</span>
        <span aria-hidden="true">/</span>
        <span>{formatDuration(duration)}</span>
      </span>

      <div className="hidden w-32 shrink-0 md:block">
        <Slider
          min={0}
          max={Math.max(duration, 1)}
          step={1}
          value={[position]}
          onValueChange={([value]) => setScrubbing(value ?? 0)}
          onValueCommit={([value]) => {
            setScrubbing(null);
            void musicStore.control({ action: "seek", positionSeconds: value ?? 0 });
          }}
          aria-label={t("music.seek")}
        />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => void musicStore.control({ action: "shuffle", shuffle: !playback.shuffle })} className={cn("grid size-8 place-items-center rounded-full hover:bg-raised", playback.shuffle ? "text-accent" : "text-ink-secondary")} aria-label={t("music.shuffle")} aria-pressed={playback.shuffle}>
          <Shuffle size={14} />
        </button>
        <button
          type="button"
          onClick={() => void musicStore.control({ action: "repeat", repeat: playback.repeat === "off" ? "all" : playback.repeat === "all" ? "one" : "off" })}
          className={cn("grid size-8 place-items-center rounded-full hover:bg-raised", playback.repeat === "off" ? "text-ink-secondary" : "text-accent")}
          aria-label={t("music.repeat")}
          aria-pressed={playback.repeat !== "off"}
        >
          {(() => { const Icon = repeatIcon; return <Icon size={14} />; })()}
        </button>
        <button
          type="button"
          onClick={() => setVolumeOpen((open) => !open)}
          className="grid size-8 place-items-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
          aria-label={t("music.volume")}
        >
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
        <button type="button" onClick={onOpenMusic} className="grid size-8 place-items-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("music.openPage")}>
          <ChevronUp size={15} />
        </button>
        <button type="button" onClick={onOpenNowPlaying} className="hidden size-8 place-items-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink sm:grid" aria-label={t("music.nowPlaying")}>
          <Maximize2 size={14} />
        </button>
      </div>

      {volumeOpen && (
        <div className="absolute bottom-[62px] right-3 w-40 rounded-xl border border-hairline/40 bg-panel p-3 shadow-lg">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-secondary">
            <span>{t("music.volume")}</span>
            <span className="tabular-nums">{playback.volume}%</span>
          </div>
          <Slider
            min={0}
            max={100}
            step={1}
            value={[playback.volume]}
            onValueCommit={([value]) => void musicStore.control({ action: "volume", volume: value ?? 0 })}
            aria-label={t("music.volume")}
          />
        </div>
      )}
    </div>
  );
}
