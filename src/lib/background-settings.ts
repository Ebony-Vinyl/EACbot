// What the app's ground is made of: a colour (the skin's own, unchanged), the bundled wallpapers that rotate behind the
// app, ambient effects over them, and a picture the person supplies. Only the wallpaper/effects/picture choices are
// persisted here; the colour stays the skin's business.

import { useSyncExternalStore } from "react";

export const BACKGROUND_MODES = ["skin", "wallpaper", "picture"] as const;
export type BackgroundMode = (typeof BACKGROUND_MODES)[number];

export const EFFECT_IDS = ["none", "sakura", "fireflies", "grass"] as const;
export type EffectId = (typeof EFFECT_IDS)[number];

/** The bundled wallpapers, in rotation order. Empty means the mode has nothing to show and falls back to the skin. */
export const WALLPAPERS: readonly string[] = [
  "/backgrounds/aurora-1.webp",
  "/backgrounds/aurora-2.webp",
  "/backgrounds/aurora-3.webp",
];

export const ROTATE_MIN_SECONDS = 5;
export const ROTATE_MAX_SECONDS = 600;
export const ROTATE_DEFAULT_SECONDS = 20;
/** How long one picture takes to fade into the next. */
export const FADE_MS = 1600;

export type BackgroundSettings = {
  mode: BackgroundMode;
  /** Bundled wallpapers rotate every this many seconds. */
  rotateSeconds: number;
  effect: EffectId;
  /** 0–100. How much the ground shows through: 0 hides the picture entirely, 100 is the picture at full strength. */
  strength: number;
  /** 0–100. How much the app's own surface darkens over the picture, so text keeps its contrast. */
  veil: number;
};

export const BACKGROUND_DEFAULTS: BackgroundSettings = {
  mode: "skin",
  rotateSeconds: ROTATE_DEFAULT_SECONDS,
  effect: "none",
  strength: 100,
  veil: 35,
};

const KEY = "eacbot.background.v1";
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Settings as stored, with every field checked: a hand-edited or half-written value never reaches the renderer. */
export function parseBackgroundSettings(raw: unknown): BackgroundSettings {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    mode: oneOf(source.mode, BACKGROUND_MODES, BACKGROUND_DEFAULTS.mode),
    rotateSeconds: clamp(
      typeof source.rotateSeconds === "number" ? source.rotateSeconds : ROTATE_DEFAULT_SECONDS,
      ROTATE_MIN_SECONDS,
      ROTATE_MAX_SECONDS,
    ),
    effect: oneOf(source.effect, EFFECT_IDS, BACKGROUND_DEFAULTS.effect),
    strength: clamp(typeof source.strength === "number" ? source.strength : BACKGROUND_DEFAULTS.strength, 0, 100),
    veil: clamp(typeof source.veil === "number" ? source.veil : BACKGROUND_DEFAULTS.veil, 0, 100),
  };
}

let cached: BackgroundSettings | undefined;

function read(): BackgroundSettings {
  if (cached) return cached;
  let raw: unknown;
  try {
    const stored = storage()?.getItem(KEY);
    raw = stored ? JSON.parse(stored) : undefined;
  } catch {
    raw = undefined;
  }
  cached = parseBackgroundSettings(raw);
  return cached;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  cached = undefined;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function readBackgroundSettings(): BackgroundSettings {
  return read();
}

export function writeBackgroundSettings(patch: Partial<BackgroundSettings>): void {
  cached = parseBackgroundSettings({ ...read(), ...patch });
  try {
    storage()?.setItem(KEY, JSON.stringify(cached));
  } catch {}
  notify();
}

export function resetBackgroundSettings(): void {
  cached = { ...BACKGROUND_DEFAULTS };
  try {
    storage()?.removeItem(KEY);
  } catch {}
  notify();
}

export function useBackgroundSettings(): BackgroundSettings {
  return useSyncExternalStore(subscribe, read, () => BACKGROUND_DEFAULTS);
}

/** Whether anything at all is drawn behind the app, so the layer can stay out of the DOM otherwise. */
export function drawsBackground(settings: BackgroundSettings, hasPicture: boolean): boolean {
  if (settings.mode === "wallpaper") return WALLPAPERS.length > 0;
  if (settings.mode === "picture") return hasPicture;
  return false;
}
