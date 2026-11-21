// The music settings page: the account, the quality and mix preferences, the
// equalizer with a drawn curve, the now-playing theme, the desktop lyric window,
// the local folders and the Jellyfin source.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, LogOut, Trash2 } from "lucide-react";

import { MUSIC_QUALITIES, MUSIC_EQ_PRESETS, NOW_PLAYING_THEMES, musicEqPreset, type MusicEq, type MusicQuality, type NowPlayingTheme } from "../../../../shared/music.ts";
import { cn } from "@/lib/music/ports";
import { t } from "@/lib/music/ports";
import { musicStore, useMusic } from "@/lib/music/store";
import { THEME_LABELS } from "@/lib/music/theme";
import { Button } from "@/lib/music/ports";
import { Field, Input, Notice } from "@/lib/music/ports";
import { Switch } from "@/lib/music/ports";
import { EqualizerCurve } from "../controls/EqualizerCurve";

interface MusicSettings {
  defaultQuality: MusicQuality;
  duckVolume: number;
  crossfadeMs: number;
  desktopLyrics: boolean;
  closeToTray: boolean;
  localFolders: string[];
  jellyfin?: { baseUrl: string; apiKey: string; userId?: string };
}

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const music = useMusic();
  const [settings, setSettings] = useState<MusicSettings>({
    defaultQuality: "320k",
    duckVolume: 25,
    crossfadeMs: 0,
    desktopLyrics: false,
    closeToTray: false,
    localFolders: [],
  });
  const [eq, setEq] = useState<MusicEq>(music.eq ?? { gains: Array.from({ length: 10 }, () => 0), preset: "acoustic", enabled: false });
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [jellyfinUrl, setJellyfinUrl] = useState("");
  const [jellyfinKey, setJellyfinKey] = useState("");
  const [folder, setFolder] = useState("");

  const load = useCallback(async () => {
    try {
      const answer = await fetch("/api/config").then((response) => response.json() as Promise<{ music?: Partial<MusicSettings> }>);
      const stored = answer.music ?? {};
      setSettings({
        defaultQuality: stored.defaultQuality ?? "320k",
        duckVolume: stored.duckVolume ?? 25,
        crossfadeMs: stored.crossfadeMs ?? 0,
        desktopLyrics: stored.desktopLyrics === true,
        closeToTray: stored.closeToTray === true,
        localFolders: stored.localFolders ?? [],
        ...(stored.jellyfin ? { jellyfin: stored.jellyfin } : {}),
      });
      setJellyfinUrl(stored.jellyfin?.baseUrl ?? "");
    } catch {
      // The defaults above are what a fresh install has.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (patch: Partial<MusicSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ music: patch }) });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
    }
  }, [settings]);

  const saveEq = useCallback(async (next: MusicEq) => {
    setEq(next);
    try {
      await musicStore.setEq(next);
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const theme = music.theme;
  const presets = useMemo(() => Object.keys(MUSIC_EQ_PRESETS), []);

  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}><ArrowLeft size={13} /> {t("music.back")}</Button>
        <h1 className="text-[15px] font-semibold text-ink">{t("music.settings")}</h1>
      </div>
      {notice && <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">{t("music.settings.account")}</h2>
        <div className="flex items-center justify-between rounded-xl border border-hairline/30 bg-inset px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-[13px] text-ink">{music.account?.loggedIn ? music.account.nickname ?? t("music.account.signedIn") : t("music.account.signIn")}</p>
            <p className="text-[11px] text-ink-secondary">
              {music.account?.loggedIn ? `${music.account.vip ? music.account.vipLabel ?? "VIP" : t("music.account.free")} · ${music.account.entitledQuality}` : t("music.account.signInHint")}
            </p>
          </div>
          {music.account?.loggedIn && (
            <Button size="sm" variant="ghost" onClick={async () => { await fetch("/api/music/account", { method: "DELETE" }); void musicStore.load(); }}>
              <LogOut size={12} /> {t("music.account.signOut")}
            </Button>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">{t("music.settings.playback")}</h2>
        <Field label={t("music.settings.quality")}>
          <select
            value={settings.defaultQuality}
            onChange={(event) => void save({ defaultQuality: event.target.value as MusicQuality })}
            className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[13px] text-ink"
          >
            {MUSIC_QUALITIES.map((quality) => <option key={quality} value={quality}>{quality}</option>)}
          </select>
        </Field>
        <Field label={`${t("music.settings.duckVolume")} · ${settings.duckVolume}%`}>
          <input
            type="range"
            min={0}
            max={100}
            value={settings.duckVolume}
            onChange={(event) => setSettings((current) => ({ ...current, duckVolume: Number(event.target.value) }))}
            onMouseUp={() => void save({ duckVolume: settings.duckVolume })}
            onTouchEnd={() => void save({ duckVolume: settings.duckVolume })}
            className="w-full accent-[var(--color-accent)]"
          />
        </Field>
        <Field label={`${t("music.settings.crossfade")} · ${(settings.crossfadeMs / 1_000).toFixed(1)}s`}>
          <input
            type="range"
            min={0}
            max={12_000}
            step={500}
            value={settings.crossfadeMs}
            onChange={(event) => setSettings((current) => ({ ...current, crossfadeMs: Number(event.target.value) }))}
            onMouseUp={() => void save({ crossfadeMs: settings.crossfadeMs })}
            onTouchEnd={() => void save({ crossfadeMs: settings.crossfadeMs })}
            className="w-full accent-[var(--color-accent)]"
          />
        </Field>
        <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
          <span>{t("music.settings.desktopLyrics")}</span>
          <Switch checked={settings.desktopLyrics} onCheckedChange={(checked) => void save({ desktopLyrics: checked })} />
        </label>
        <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
          <span>{t("music.settings.closeToTray")}</span>
          <Switch checked={settings.closeToTray} onCheckedChange={(checked) => void save({ closeToTray: checked })} />
        </label>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">{t("music.settings.eq")}</h2>
          <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
            <span>{t("music.settings.eqOn")}</span>
            <Switch checked={eq.enabled} onCheckedChange={(checked) => void saveEq({ ...eq, enabled: checked })} />
          </label>
        </div>
        <div className="rounded-xl border border-hairline/30 bg-inset p-3">
          <EqualizerCurve gains={eq.enabled ? eq.gains : Array.from({ length: 10 }, () => 0)} onChange={(index, gain) => {
            const gains = [...eq.gains];
            gains[index] = gain;
            void saveEq({ ...eq, gains, preset: "custom" });
          }} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => void saveEq({ gains: musicEqPreset(name) ?? eq.gains, preset: name, enabled: true })}
              className={cn("rounded-full border px-2.5 py-1 text-[11px]", eq.preset === name ? "border-accent/50 bg-accent/15 text-accent" : "border-hairline/40 text-ink-secondary hover:bg-raised")}
            >
              {t(`music.eq.${name}` as never)}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">{t("music.settings.theme")}</h2>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {NOW_PLAYING_THEMES.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => void musicStore.setTheme(entry)}
              className={cn("rounded-lg border px-2 py-2 text-[11px]", theme === entry ? "border-accent/60 bg-accent/10 text-accent" : "border-hairline/40 text-ink-secondary hover:bg-raised")}
            >
              {THEME_LABELS[entry as NowPlayingTheme]}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">{t("music.settings.sources")}</h2>
        <div className="flex gap-2">
          <Input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={t("music.local.folderPlaceholder")} />
          <Button size="sm" variant="secondary" disabled={!folder.trim()} onClick={() => { void save({ localFolders: [...settings.localFolders, folder.trim()] }); setFolder(""); }}>{t("music.local.add")}</Button>
        </div>
        <ul className="flex flex-col gap-1">
          {settings.localFolders.map((path) => (
            <li key={path} className="flex items-center justify-between gap-2 rounded-lg border border-hairline/30 bg-inset px-2.5 py-1.5 text-[12px]">
              <span className="min-w-0 flex-1 truncate text-ink" title={path}>{path}</span>
              <button type="button" onClick={() => void save({ localFolders: settings.localFolders.filter((entry) => entry !== path) })} className="text-ink-secondary hover:text-danger" aria-label={t("music.remove")}>
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t("music.settings.jellyfinUrl")}>
            <Input value={jellyfinUrl} onChange={(event) => setJellyfinUrl(event.target.value)} placeholder="http://192.168.1.10:8096" />
          </Field>
          <Field label={t("music.settings.jellyfinKey")}>
            <Input type="password" value={jellyfinKey} onChange={(event) => setJellyfinKey(event.target.value)} placeholder={settings.jellyfin ? t("music.settings.jellyfinSet") : ""} />
          </Field>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={!jellyfinUrl.trim() || (!jellyfinKey.trim() && !settings.jellyfin)}
          onClick={() => void save({ jellyfin: { baseUrl: jellyfinUrl.trim(), apiKey: jellyfinKey.trim() || settings.jellyfin?.apiKey || "" } })}
        >
          {t("music.settings.saveJellyfin")}
        </Button>
      </section>
    </div>
  );
}
