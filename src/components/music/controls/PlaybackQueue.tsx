// The queue drawer: what is coming, what is playing, and the two edits a person
// actually makes (remove one, clear all). Reordering is a drag away from the same
// handler, which the player already understands.
import { Trash2, X } from "lucide-react";

import { formatDuration } from "../../../../shared/music.ts";
import { cn } from "@/lib/music/ports";
import { t } from "@/lib/music/ports";
import { musicStore, useMusic } from "@/lib/music/store";

export function PlaybackQueue({ onClose }: { onClose: () => void }) {
  const music = useMusic();
  const playback = music.playback;
  if (!playback) return null;

  return (
    <div className="m-menu" style={{ right: 16, bottom: 84, width: 380, maxHeight: 560, overflow: "hidden", display: "flex", flexDirection: "column" }} data-music-queue="">
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: "1px solid var(--m-border)" }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--m-text)" }}>{t("music.queue.title")} <span style={{ color: "var(--m-mute)" }}>({playback.queue.length})</span></h3>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => void musicStore.editQueue({ action: "clear" })} className="m-bar-speed" style={{ minHeight: 26, height: 26, fontSize: 11 }} disabled={!playback.queue.length}>
            {t("music.queue.clear")}
          </button>
          <button type="button" onClick={onClose} className="m-song-action" aria-label={t("music.close")}>
            <X size={13} />
          </button>
        </div>
      </div>
      <ul style={{ overflowY: "auto", padding: 6, margin: 0, listStyle: "none", flex: 1 }}>
        {playback.queue.map((item, index) => (
          <li
            key={item.queueItemId}
            className={cn("m-plist-item", index === playback.currentIndex && "[&]:bg-[rgba(10,89,247,0.1)]")}
          >
            <span className="m-plist-cover" style={{ marginLeft: 0 }}>
              {item.track.coverUrl ? <img src={item.track.coverUrl} alt="" className="size-full object-cover" loading="lazy" /> : null}
            </span>
            <span className="min-w-0 flex-1" style={{ display: "block" }}>
              <span className="m-plist-name" style={{ color: index === playback.currentIndex ? "var(--m-primary)" : "var(--m-text)" }}>{item.track.title}</span>
              <span className="m-song-artist" style={{ fontSize: 10 }}>{item.track.artists.join(", ") || t("music.unknownArtist")}</span>
            </span>
            <span className="m-song-duration" style={{ fontSize: 10 }}>{formatDuration(item.track.durationSeconds)}</span>
            <button
              type="button"
              onClick={() => void musicStore.editQueue({ action: "remove", queueItemId: item.queueItemId })}
              className="m-song-action"
              aria-label={t("music.queue.remove")}
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
        {!playback.queue.length && <li className="m-empty">{t("music.queue.empty")}</li>}
      </ul>
    </div>
  );
}
