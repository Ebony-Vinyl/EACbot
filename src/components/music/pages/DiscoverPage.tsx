// Discover: charts, scenes and the personal FM, in the segmented control
// upstream's DiscoverView uses. Ranks and scenes are card grids; the FM tab
// reads the server's FM session and hands it to the collection surface.
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { MusicTrack } from "../../../../shared/music.ts";
import { cn } from "@/lib/music/ports";
import { t } from "@/lib/music/ports";
import { EmptyState } from "@/lib/music/ports";
import { MediaCard } from "../controls/SongList";
import { SurfaceCollection } from "../surface/SurfaceCollection";

type Tab = "rank" | "scene" | "fm";

interface FmState {
  current?: { track: MusicTrack } | null;
  upcoming?: Array<{ track: MusicTrack }>;
  active?: boolean;
}

export function DiscoverPage({ onOpenRank, onOpenPlaylist }: {
  onOpenRank: (rankId: string) => void;
  onOpenPlaylist: (playlistId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("rank");
  const [ranks, setRanks] = useState<Array<{ rankId: string; name: string; coverUrl: string | null }>>([]);
  const [scenes, setScenes] = useState<Array<{ sceneId: string; name: string; coverUrl: string | null }>>([]);
  const [fm, setFm] = useState<FmState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (which: Tab) => {
    setLoading(true);
    setError(null);
    try {
      if (which === "rank") {
        const answer = await fetch("/api/music/discover?kind=rank").then((response) => response.json() as Promise<{ ranks?: Array<{ rankId: string; name: string; coverUrl: string | null }>; error?: { message: string } }>);
        if (answer.error) throw new Error(answer.error.message);
        setRanks(answer.ranks ?? []);
      } else if (which === "scene") {
        const answer = await fetch("/api/music/discover?kind=scene").then((response) => response.json() as Promise<{ scenes?: Array<{ sceneId: string; name: string; coverUrl: string | null }>; error?: { message: string } }>);
        if (answer.error) throw new Error(answer.error.message);
        setScenes(answer.scenes ?? []);
      } else {
        const answer = await fetch("/api/music/fm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start" }) })
          .then((response) => response.json() as Promise<FmState & { error?: { message: string } }>);
        if (answer.error) throw new Error(answer.error.message);
        setFm(answer);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(tab); }, [tab, load]);

  const fmTracks: MusicTrack[] = fm?.current
    ? [fm.current.track, ...(fm.upcoming ?? []).map((item) => item.track)]
    : (fm?.upcoming ?? []).map((item) => item.track);

  return (
    <div className="flex flex-col gap-4">
      <div className="m-card flex w-fit gap-1 p-1.5">
        {(["rank", "scene", "fm"] as Tab[]).map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setTab(entry)}
            className={cn("rounded-full px-4 py-1.5 text-[13px]", tab === entry ? "bg-[rgba(10,89,247,0.1)] font-semibold text-[#0a59f7]" : "text-[var(--m-low)] hover:bg-[rgba(0,0,0,0.04)]")}
          >
            {t(entry === "rank" ? "music.discover.ranks" : entry === "scene" ? "music.discover.scenes" : "music.discover.fm")}
          </button>
        ))}
      </div>

      {error && <div className="m-empty">{error}</div>}
      {loading ? <div className="m-empty"><Loader2 size={18} className="animate-spin" /></div> : (
        <>
          {tab === "rank" && (ranks.length ? (
            <div className="m-card flex flex-wrap p-2">{ranks.map((rank) => <MediaCard key={rank.rankId} coverUrl={rank.coverUrl} title={rank.name} onClick={() => onOpenRank(rank.rankId)} />)}</div>
          ) : <div className="m-card"><EmptyState title={t("music.discover.emptyRanks")} body={t("music.discover.emptyRanksBody")} /></div>)}

          {tab === "scene" && (scenes.length ? (
            <div className="m-card flex flex-wrap p-2">{scenes.map((scene) => <MediaCard key={scene.sceneId} coverUrl={scene.coverUrl} title={scene.name} onClick={() => onOpenPlaylist(`kugou:${scene.sceneId}`)} />)}</div>
          ) : <div className="m-card"><EmptyState title={t("music.discover.emptyScenes")} body={t("music.discover.emptyScenesBody")} /></div>)}

          {tab === "fm" && (fmTracks.length ? (
            <SurfaceCollection
              title={t("music.discover.fmTitle")}
              subtitle={fm?.current ? `${fm.current.track.title} — ${fm.current.track.artists.join(", ")}` : null}
              songs={fmTracks}
            />
          ) : <div className="m-card"><EmptyState title={t("music.discover.emptyFm")} body={t("music.discover.emptyFmBody")} /></div>)}
        </>
      )}
    </div>
  );
}
