// Recently played, from this server's own history: a real play only, so a skipped
// track never appears as if it had been listened to. Rendered through upstream's
// collection surface, with the trash as the hero action.
import { useCallback, useEffect, useState } from "react";

import type { MusicTrack } from "../../../../shared/music.ts";
import { t } from "@/lib/music/ports";
import { SurfaceCollection } from "../surface/SurfaceCollection";

interface HistoryEntry {
  track: MusicTrack;
  at: string;
  playedSeconds: number;
  by: "person" | "bot" | "radio";
}

export function HistoryPage() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const answer = await fetch("/api/music/history?limit=200").then((response) => response.json() as Promise<{ entries?: HistoryEntry[] }>);
      setEntries(answer.entries ?? []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const clear = useCallback(async () => {
    await fetch("/api/music/history", { method: "DELETE" }).catch(() => {});
    setEntries([]);
  }, []);

  return (
    <SurfaceCollection
      title={t("music.page.history")}
      subtitle={entries.length ? `${entries.length} ${t("music.songs")}` : null}
      songs={entries.map((entry) => entry.track)}
      loading={loading}
      heroAction={{ icon: "/music/trash-svgrepo-com.svg", label: t("music.history.clear"), onClick: () => void clear() }}
    />
  );
}
