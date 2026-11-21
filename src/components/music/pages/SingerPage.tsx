// An artist's page on the collection surface: their portrait, the album grid
// below the songs, like upstream's SingerView.
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { MusicAlbum, MusicArtist, MusicTrack } from "../../../../shared/music.ts";
import { t } from "@/lib/music/ports";
import { SurfaceCollection } from "../surface/SurfaceCollection";
import { MediaCard } from "../controls/SongList";

interface ArtistAnswer {
  artist?: MusicArtist;
  tracks?: MusicTrack[];
  albums?: MusicAlbum[];
  error?: { message: string };
}

export function SingerPage({ artistId, onBack, onOpenAlbum }: {
  artistId: string;
  onBack: () => void;
  onOpenAlbum: (albumId: string) => void;
}) {
  const [answer, setAnswer] = useState<ArtistAnswer | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetch(`/api/music/discover?kind=artist&id=${encodeURIComponent(artistId)}`).then((response) => response.json() as Promise<ArtistAnswer>);
      setAnswer(result);
    } finally {
      setLoading(false);
    }
  }, [artistId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <div className="m-empty"><Loader2 size={18} className="animate-spin" /></div>;
  if (!answer?.artist) return <div className="m-empty">{t("music.empty")}</div>;

  return (
    <div className="m-collection">
      <SurfaceCollection
        cover={answer.artist.avatarUrl}
        title={answer.artist.name}
        subtitle={`${answer.artist.trackCount} ${t("music.songs")} · ${answer.artist.albumCount} ${t("music.albums")}`}
        songs={answer.tracks ?? []}
        onBack={onBack}
      />
      {answer.albums?.length ? (
        <div className="m-card mt-4 p-4">
          <div className="flex flex-wrap">{answer.albums.map((album) => (
            <MediaCard key={album.albumId} coverUrl={album.coverUrl} title={album.name} subtitle={album.releaseDate ?? undefined} onClick={() => onOpenAlbum(album.albumId)} />
          ))}</div>
        </div>
      ) : null}
    </div>
  );
}
