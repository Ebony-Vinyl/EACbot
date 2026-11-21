// A playlist's detail on the collection surface: cover, name, count and songs.
import { useCallback, useEffect, useState } from "react";

import type { MusicPlaylist, MusicTrack } from "../../../../shared/music.ts";
import { SurfaceCollection } from "../surface/SurfaceCollection";

export function PlaylistPage({ playlistId, onBack }: { playlistId: string; onBack: () => void }) {
  const [playlist, setPlaylist] = useState<MusicPlaylist | null>(null);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const answer = await fetch(`/api/music/playlists/${encodeURIComponent(playlistId)}`)
        .then((response) => response.json() as Promise<{ playlist?: MusicPlaylist; tracks?: MusicTrack[] }>);
      setPlaylist(answer.playlist ?? null);
      setTracks(answer.tracks ?? []);
    } finally {
      setLoading(false);
    }
  }, [playlistId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <SurfaceCollection
      cover={playlist?.coverUrl ?? null}
      title={playlist?.name ?? ""}
      subtitle={tracks.length ? `${tracks.length} ` + "首" : null}
      songs={tracks}
      loading={loading}
      onBack={onBack}
    />
  );
}
