// The six now-playing themes as CSS custom properties. Upstream hard-codes hex
// colours per theme; here each theme sets its own variables on the layer, and the
// components read those, so the app's eleven skins keep working everywhere else.
//
// A theme may override any of these; the fallbacks are the standard theme's, which
// is the one that stays closest to the app's own tokens.
import type { CSSProperties } from "react";

import type { NowPlayingTheme } from "../../../shared/music.ts";
import { isSilkTheme } from "../../../shared/music.ts";

export interface ThemeSkin {
  /** The full-bleed background: a gradient, or `none` when a canvas paints it. */
  background: string;
  /** The panel glass: floating bars, subtitle cards, the settings flyout. */
  glass: string;
  glassBorder: string;
  glassShadow: string;
  /** Lyric colours: the line being sung, the rest, and the one that just passed. */
  lyricActive: string;
  lyricIdle: string;
  lyricGlow: string;
  /** Accent for controls, progress and the selection dot. */
  accent: string;
  accentSoft: string;
  /** Whether a canvas draws the background, so the CSS gradient stays out of the way. */
  canvasBackground: boolean;
  /** The font stack for lyrics, when a theme sets its own. */
  lyricFont?: string;
  /** How a line's emphasis is drawn: a glow, a scale, or both. */
  emphasis: "glow" | "scale" | "both";
}

const STANDARD: ThemeSkin = {
  background: "linear-gradient(160deg, var(--color-app), var(--color-inset))",
  glass: "color-mix(in oklab, var(--color-panel) 82%, transparent)",
  glassBorder: "color-mix(in oklab, var(--color-hairline) 60%, transparent)",
  glassShadow: "0 24px 64px color-mix(in oklab, var(--color-app) 60%, transparent)",
  lyricActive: "var(--color-ink)",
  lyricIdle: "color-mix(in oklab, var(--color-ink-secondary) 80%, transparent)",
  lyricGlow: "transparent",
  accent: "var(--color-accent)",
  accentSoft: "color-mix(in oklab, var(--color-accent) 18%, transparent)",
  canvasBackground: false,
  emphasis: "scale",
};

/** Pendolo: a full-bleed visualizer, deep navy glass, an icy cyan accent, mouse parallax. */
const PENDOLO: ThemeSkin = {
  background: "linear-gradient(180deg, #0a1420, #060d16)",
  glass: "rgba(10, 20, 32, 0.90)",
  glassBorder: "rgba(95, 168, 201, 0.21)",
  glassShadow: "0 28px 72px rgba(0, 0, 0, 0.55)",
  lyricActive: "#dff3fb",
  lyricIdle: "rgba(190, 220, 235, 0.52)",
  lyricGlow: "rgba(120, 210, 245, 0.55)",
  accent: "#5fc8e8",
  accentSoft: "rgba(95, 200, 232, 0.16)",
  canvasBackground: true,
  emphasis: "both",
};

/** Fume: a warm gold-on-navy scene with a latent material, glow on the hero line, a quiet subtitle rail. */
const FUME: ThemeSkin = {
  background: "linear-gradient(170deg, #121928, #0b1018)",
  glass: "rgba(18, 25, 40, 0.90)",
  glassBorder: "rgba(242, 235, 221, 0.16)",
  glassShadow: "0 26px 68px rgba(0, 0, 0, 0.40)",
  lyricActive: "#f2ebdd",
  lyricIdle: "rgba(242, 235, 221, 0.46)",
  lyricGlow: "rgba(214, 169, 31, 0.60)",
  accent: "#d6a91f",
  accentSoft: "rgba(214, 169, 31, 0.16)",
  canvasBackground: true,
  emphasis: "both",
};

/**
 * Silk, the shell Lumiere, Sonnet and Tempera share. Each preset is a palette and a
 * flow character over the same 60 fps silk background.
 */
const SILK_PRESETS: Record<string, ThemeSkin> = {
  // Lumiere: warm light, the brightest of the three.
  lumiere: {
    background: "linear-gradient(165deg, #1a1410, #0d0a08)",
    glass: "rgba(20, 16, 12, 0.82)",
    glassBorder: "rgba(255, 240, 220, 0.14)",
    glassShadow: "0 26px 70px rgba(0, 0, 0, 0.5)",
    lyricActive: "#fff4e4",
    lyricIdle: "rgba(255, 240, 220, 0.42)",
    lyricGlow: "rgba(255, 196, 120, 0.55)",
    accent: "#ffc478",
    accentSoft: "rgba(255, 196, 120, 0.16)",
    canvasBackground: true,
    emphasis: "both",
  },
  // Sonnet: cool ink and silver, the quietest.
  sonnet: {
    background: "linear-gradient(165deg, #0d1117, #070a0e)",
    glass: "rgba(13, 17, 23, 0.86)",
    glassBorder: "rgba(210, 220, 235, 0.12)",
    glassShadow: "0 26px 70px rgba(0, 0, 0, 0.55)",
    lyricActive: "#e8eef6",
    lyricIdle: "rgba(210, 220, 235, 0.40)",
    lyricGlow: "rgba(150, 190, 235, 0.50)",
    accent: "#96bee8",
    accentSoft: "rgba(150, 190, 232, 0.15)",
    canvasBackground: true,
    emphasis: "glow",
  },
  // Tempera: pigment and depth, the most saturated.
  tempera: {
    background: "linear-gradient(165deg, #14101c, #08060c)",
    glass: "rgba(20, 16, 28, 0.86)",
    glassBorder: "rgba(228, 210, 245, 0.13)",
    glassShadow: "0 26px 70px rgba(0, 0, 0, 0.55)",
    lyricActive: "#f0e6ff",
    lyricIdle: "rgba(228, 210, 245, 0.42)",
    lyricGlow: "rgba(186, 140, 245, 0.55)",
    accent: "#ba8cf5",
    accentSoft: "rgba(186, 140, 245, 0.16)",
    canvasBackground: true,
    emphasis: "both",
  },
};

export function themeSkin(theme: NowPlayingTheme): ThemeSkin {
  if (theme === "pendolo") return PENDOLO;
  if (theme === "fume") return FUME;
  if (isSilkTheme(theme)) return SILK_PRESETS[theme] ?? SILK_PRESETS.sonnet!;
  return STANDARD;
}

/** The variables a theme layer sets, so its children read one set of names. */
export function themeStyle(theme: NowPlayingTheme): CSSProperties {
  const skin = themeSkin(theme);
  return {
    "--np-background": skin.background,
    "--np-glass": skin.glass,
    "--np-glass-border": skin.glassBorder,
    "--np-glass-shadow": skin.glassShadow,
    "--np-lyric-active": skin.lyricActive,
    "--np-lyric-idle": skin.lyricIdle,
    "--np-lyric-glow": skin.lyricGlow,
    "--np-accent": skin.accent,
    "--np-accent-soft": skin.accentSoft,
    ...(skin.lyricFont ? { "--np-lyric-font": skin.lyricFont } : {}),
  } as CSSProperties;
}

export const THEME_LABELS: Readonly<Record<NowPlayingTheme, string>> = {
  standard: "Standard",
  pendolo: "Pendolo",
  fume: "Fume",
  sonnet: "Sonnet",
  lumiere: "Lumiere",
  tempera: "Tempera",
};
