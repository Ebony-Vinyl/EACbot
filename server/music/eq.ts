// The equalizer's stored shape. The filter graph itself runs in the browser
// (a BiquadFilter per band, one gain node); this file only validates and persists
// the gains, so the settings survive a restart and the same curve is drawn and
// applied.
import { MUSIC_EQ_BANDS_HZ, musicEqPreset, type MusicEq } from "../../shared/music.ts";

export const EQ_SETTING_KEY = "eq";


export function defaultEq(): MusicEq {
  return { gains: musicEqPreset("acoustic") ?? Array.from({ length: MUSIC_EQ_BANDS_HZ.length }, () => 0), preset: "acoustic", enabled: false };
}

/** Coerces anything stored or posted into a valid curve, so one bad value cannot break the graph. */
export function normaliseEq(input: unknown): MusicEq {
  if (!input || typeof input !== "object") return defaultEq();
  const record = input as Record<string, unknown>;
  const raw = Array.isArray(record.gains) ? record.gains : [];
  const gains = MUSIC_EQ_BANDS_HZ.map((_band, index) => {
    const value = Number(raw[index]);
    return Number.isFinite(value) ? Math.min(Math.max(value, -15), 15) : 0;
  });
  const preset = typeof record.preset === "string" ? record.preset.slice(0, 60) : "custom";
  return { gains, preset, enabled: record.enabled === true };
}

export function isFlat(gains: readonly number[]): boolean {
  return gains.every((gain) => Math.abs(gain) < 0.01);
}
