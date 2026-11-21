// The person's Kugou cloud drive: the tracks they uploaded, which play like any
// other. Signed out, the page says so instead of showing an empty list.
import { useCallback, useEffect, useState } from "react";

import type { MusicTrack } from "../../../../shared/music.ts";
import { t } from "@/lib/music/ports";
import { useMusic } from "@/lib/music/store";
import { EmptyState } from "@/lib/music/ports";
import { SurfaceCollection } from "../surface/SurfaceCollection";

export function UserCloudPage() {
  const music = useMusic();
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (nextPage: number, append: boolean) => {
    setLoading(true);
    try {
      const answer = await fetch(`/api/music/discover?kind=cloud&page=${nextPage}`)
        .then((response) => response.json() as Promise<{ tracks?: MusicTrack[]; hasMore?: boolean; error?: { message: string } }>);
      setTracks((current) => append ? [...current, ...(answer.tracks ?? [])] : answer.tracks ?? []);
      setHasMore(answer.hasMore === true);
      setPage(nextPage);
    } catch {
      if (!append) setTracks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (music.account?.loggedIn) void load(1, false); }, [music.account?.loggedIn, load]);

  if (!music.account?.loggedIn) {
    return <div className="p-5"><EmptyState title={t("music.cloud.signedOut")} body={t("music.cloud.signedOutBody")} /></div>;
  }

  return (
    <SurfaceCollection
      title={t("music.page.cloud")}
      subtitle={tracks.length ? `${tracks.length} ${t("music.songs")}` : null}
      songs={tracks}
      loading={loading && !tracks.length}
      loadingMore={loading && tracks.length > 0}
      onLoadMore={hasMore ? () => void load(page + 1, true) : undefined}
    />
  );
}
