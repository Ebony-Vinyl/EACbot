// The Settings rows for the app's ground: which picture, how fast it rotates, what drifts over it, and how strongly it
// shows through the app.

import { useRef, useState } from "react";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import {
  ROTATE_MAX_SECONDS,
  ROTATE_MIN_SECONDS,
  useBackgroundSettings,
  writeBackgroundSettings,
  type BackgroundMode,
  type EffectId,
} from "@/lib/background-settings";
import {
  clearBackgroundPicture,
  preparePicture,
  saveBackgroundPicture,
  useBackgroundPicture,
  type PictureProblem,
} from "@/lib/background-picture";
import { SettingRow } from "../SettingsPrimitives";

const PROBLEM: Readonly<Record<PictureProblem, LocaleKey>> = {
  format: "background.pictureFormat",
  read: "background.pictureRead",
  size: "background.pictureSize",
  failed: "background.pictureFailed",
};

const MODES: readonly { id: BackgroundMode; title: LocaleKey; subtitle: LocaleKey }[] = [
  { id: "skin", title: "background.mode.skin", subtitle: "background.mode.skinHint" },
  { id: "wallpaper", title: "background.mode.wallpaper", subtitle: "background.mode.wallpaperHint" },
  { id: "picture", title: "background.mode.picture", subtitle: "background.mode.pictureHint" },
];

const EFFECTS: readonly { id: EffectId; label: LocaleKey }[] = [
  { id: "none", label: "background.effect.none" },
  { id: "sakura", label: "background.effect.sakura" },
  { id: "fireflies", label: "background.effect.fireflies" },
  { id: "grass", label: "background.effect.grass" },
];

/** The picture itself: choose one, or take it away. Kept in this browser, never uploaded. */
export function BackgroundPictureRow() {
  const input = useRef<HTMLInputElement>(null);
  const picture = useBackgroundPicture();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LocaleKey | null>(null);

  const chosen = async (file: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!file) return;
    setBusy(true);
    setProblem(null);
    const prepared = await preparePicture(file).catch(() => ({ ok: false as const, problem: "failed" as const }));
    const saved = prepared.ok ? await saveBackgroundPicture(prepared.blob, prepared.width, prepared.height) : prepared;
    setBusy(false);
    if (!saved.ok) setProblem(PROBLEM[saved.problem]);
    else writeBackgroundSettings({ mode: "picture" });
  };

  return (
    <SettingRow
      title={t("background.picture.title")}
      subtitle={t("background.picture.subtitle")}
      message={problem ? <p role="alert" className="text-danger">{t(problem)}</p> : null}
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        {picture && (
          <img src={picture.url} alt={t("background.picture.current")} className="h-8 w-14 rounded-md border border-ink/10 object-cover" />
        )}
        <button type="button" className="ui-button" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? t("background.picture.saving") : t(picture ? "background.picture.change" : "background.picture.choose")}
        </button>
        {picture && (
          <button
            type="button"
            className="ui-button"
            disabled={busy}
            onClick={() => {
              void clearBackgroundPicture();
              writeBackgroundSettings({ mode: "wallpaper" });
            }}
          >
            {t("background.picture.remove")}
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          hidden
          data-background-picture-input
          onChange={(event) => void chosen(event.target.files?.[0])}
        />
      </div>
    </SettingRow>
  );
}

/** What the ground is made of, and how much of it shows. */
export function BackgroundRows({ simple = false }: { simple?: boolean }) {
  const settings = useBackgroundSettings();
  return (
    <>
      <SettingRow title={t("background.mode.title")} subtitle={t("background.mode.subtitle")}>
        <div role="radiogroup" aria-label={t("background.mode.title")} className="flex flex-wrap items-center justify-end gap-1.5">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={settings.mode === mode.id}
              title={t(mode.subtitle)}
              className={`ui-button ${settings.mode === mode.id ? "ui-button-primary" : ""}`}
              onClick={() => writeBackgroundSettings({ mode: mode.id })}
            >
              {t(mode.title)}
            </button>
          ))}
        </div>
      </SettingRow>
      {settings.mode === "picture" && <BackgroundPictureRow />}
      {settings.mode === "wallpaper" && (
        <SettingRow title={t("background.rotate.title")} subtitle={t("background.rotate.subtitle")}>
          <div className="flex items-center justify-end gap-2">
            <input
              type="range"
              min={ROTATE_MIN_SECONDS}
              max={ROTATE_MAX_SECONDS}
              step={5}
              value={settings.rotateSeconds}
              aria-label={t("background.rotate.title")}
              className="w-40"
              onChange={(event) => writeBackgroundSettings({ rotateSeconds: Number(event.target.value) })}
            />
            <span className="w-14 text-right text-[12px] tabular-nums text-ink-secondary">
              {t("background.rotate.seconds", { count: settings.rotateSeconds })}
            </span>
          </div>
        </SettingRow>
      )}
      <SettingRow title={t("background.strength.title")} subtitle={t("background.strength.subtitle")}>
        <div className="flex items-center justify-end gap-2">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={settings.strength}
            aria-label={t("background.strength.title")}
            className="w-40"
            onChange={(event) => writeBackgroundSettings({ strength: Number(event.target.value) })}
          />
          <span className="w-10 text-right text-[12px] tabular-nums text-ink-secondary">{settings.strength}%</span>
        </div>
      </SettingRow>
      <SettingRow title={t("background.veil.title")} subtitle={t("background.veil.subtitle")}>
        <div className="flex items-center justify-end gap-2">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={settings.veil}
            aria-label={t("background.veil.title")}
            className="w-40"
            onChange={(event) => writeBackgroundSettings({ veil: Number(event.target.value) })}
          />
          <span className="w-10 text-right text-[12px] tabular-nums text-ink-secondary">{settings.veil}%</span>
        </div>
      </SettingRow>
      <SettingRow title={t("background.effect.title")} subtitle={simple ? t("background.effect.subtitleSimple") : t("background.effect.subtitle")}>
        <div role="radiogroup" aria-label={t("background.effect.title")} className="flex flex-wrap items-center justify-end gap-1.5">
          {EFFECTS.map((effect) => (
            <button
              key={effect.id}
              type="button"
              role="radio"
              aria-checked={settings.effect === effect.id}
              className={`ui-button ${settings.effect === effect.id ? "ui-button-primary" : ""}`}
              onClick={() => writeBackgroundSettings({ effect: effect.id })}
            >
              {t(effect.label)}
            </button>
          ))}
        </div>
      </SettingRow>
    </>
  );
}
