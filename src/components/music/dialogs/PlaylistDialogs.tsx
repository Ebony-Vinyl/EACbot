// The two playlist dialogs upstream opens from its "new playlist" flyout: one
// creates an empty playlist here, the other imports one from NetEase or QQ by
// pasting its share link.
import { useState } from "react";
import { Loader2 } from "lucide-react";

import { t } from "@/lib/music/ports";
import { Button } from "@/lib/music/ports";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/lib/music/ports";
import { Chip, ChipRow, Field, Input, Notice } from "@/lib/music/ports";

export function CreatePlaylistDialog({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (playlistId: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await fetch("/api/music/playlists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      }).then((response) => response.json() as Promise<{ playlist?: { playlistId: string }; error?: { message: string } }>);
      if (answer.error) throw new Error(answer.error.message);
      setName("");
      if (answer.playlist) onCreated(answer.playlist.playlistId);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {open && (
        <DialogContent>
          <DialogTitle>{t("music.playlists.create")}</DialogTitle>
          <DialogDescription>{t("music.playlists.createBody")}</DialogDescription>
          <div className="mt-3 flex flex-col gap-2">
            <Field label={t("music.playlists.name")}>
              <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t("music.playlists.namePlaceholder")} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} />
            </Field>
            {error && <Notice tone="bad">{error}</Notice>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t("music.close")}</Button>
            <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : null} {t("music.playlists.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

export function ImportPlaylistDialog({ open, onClose, onImported }: {
  open: boolean;
  onClose: () => void;
  onImported: (result: { matched: number; unmatched: number }) => void;
}) {
  const [platform, setPlatform] = useState<"netease" | "qq">("netease");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ matched: number; unmatched: number } | null>(null);

  const run = async () => {
    if (!link.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const answer = await fetch("/api/music/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, link: link.trim() }),
      }).then((response) => response.json() as Promise<{ matched?: number; unmatched?: number; error?: { message: string } }>);
      if (answer.error) throw new Error(answer.error.message);
      const summary = { matched: answer.matched ?? 0, unmatched: answer.unmatched ?? 0 };
      setResult(summary);
      onImported(summary);
      setLink("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {open && (
        <DialogContent>
          <DialogTitle>{t("music.playlists.import")}</DialogTitle>
          <DialogDescription>{t("music.playlists.importBody")}</DialogDescription>
          <ChipRow className="mt-3">
            <Chip active={platform === "netease"} onClick={() => setPlatform("netease")}>{t("music.playlists.netease")}</Chip>
            <Chip active={platform === "qq"} onClick={() => setPlatform("qq")}>{t("music.playlists.qq")}</Chip>
          </ChipRow>
          <div className="mt-2 flex flex-col gap-2">
            <Field label={t("music.playlists.link")}>
              <Input autoFocus value={link} onChange={(event) => setLink(event.target.value)} placeholder={platform === "netease" ? "https://music.163.com/playlist?id=123456789" : "https://y.qq.com/n/ryqq/playlist/123456789"} />
            </Field>
            {error && <Notice tone="bad">{error}</Notice>}
            {result && <Notice tone="ok">{t("music.playlists.imported", { matched: result.matched, unmatched: result.unmatched })}</Notice>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t("music.close")}</Button>
            <Button variant="primary" disabled={busy || !link.trim()} onClick={() => void run()}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : null} {t("music.playlists.import")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
