// A chart's detail on the collection surface, with upstream's load-more.
import { useCallback, useEffect, useState } from "react";

import type { MusicTrack } from "../../../../shared/music.ts";
import { SurfaceCollection } from "../surface/SurfaceCollection";

export function RankPage({ rankId, onBack }: { rankId: string; onBack: () => void }) {
  const [name, setName] = useState("");
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (nextPage: number, append: boolean) => {
    setLoading(true);
    try {
      const answer = await fetch(`/api/music/discover?kind=rank&id=${encodeURIComponent(rankId)}&page=${nextPage}`)
        .then((response) => response.json() as Promise<{ name?: string; tracks?: MusicTrack[]; hasMore?: boolean; error?: { message: string } }>);
      setName((current) => current || answer.name || "");
      setTracks((current) => append ? [...current, ...(answer.tracks ?? [])] : answer.tracks ?? []);
      setHasMore(answer.hasMore === true);
      setPage(nextPage);
    } finally {
      setLoading(false);
    }
  }, [rankId]);

  useEffect(() => { void load(1, false); }, [load]);

  return (
    <SurfaceCollection
      title={name}
      songs={tracks}
      loading={loading && !tracks.length}
      loadingMore={loading && tracks.length > 0}
      onLoadMore={hasMore ? () => void load(page + 1, true) : undefined}
      onBack={onBack}
    />
  );
}
