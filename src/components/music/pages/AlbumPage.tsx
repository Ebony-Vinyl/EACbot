// An album's detail on the collection surface: the cover, the artist line and the songs.
import { useCallback, useEffect, useState } from "react";

import type { MusicAlbum, MusicTrack } from "../../../../shared/music.ts";
import { SurfaceCollection } from "../surface/SurfaceCollection";

export function AlbumPage({ albumId, onBack }: { albumId: string; onBack: () => void }) {
  const [album, setAlbum] = useState<MusicAlbum | null>(null);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const answer = await fetch(`/api/music/discover?kind=album&id=${encodeURIComponent(albumId)}`)
        .then((response) => response.json() as Promise<{ album?: MusicAlbum; tracks?: MusicTrack[]; error?: { message: string } }>);
      setAlbum(answer.album ?? null);
      setTracks(answer.tracks ?? answer.album?.tracks ?? []);
    } finally {
      setLoading(false);
    }
  }, [albumId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <SurfaceCollection
      cover={album?.coverUrl ?? null}
      title={album?.name ?? ""}
      subtitle={album?.artist || null}
      songs={tracks}
      loading={loading}
      onBack={onBack}
    />
  );
}
