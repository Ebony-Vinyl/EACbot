/** The workbench's light/dark mode, which is the app's skin.
 *
 * There is one source of truth: the skin (`src/lib/skins.ts`). Astryx's mode is
 * derived from it, so a person can never end up with Astryx's dark text on the
 * app's light skin — the two are the same decision. Choosing light or dark here
 * writes the skin choice, exactly as the app's own skin picker does, and
 * "system" hands the decision back to `prefers-color-scheme`. */

import { useSyncExternalStore } from "react";
import {
  applySkinChoice,
  readSkinChoice,
  resolveSkin,
  subscribeSkin,
  THEME_SKINS,
  type SkinChoice,
  type SkinId,
} from "@/lib/skins";

export const THEME_CHOICES = ["system", "light", "dark"] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

export type ResolvedTheme = "light" | "dark";

/** The skins that paint light. Kept beside the mode because a skin id is not
 * self-describing: `pop` is a light skin whose name says nothing about it. */
const LIGHT_SKINS: ReadonlySet<SkinId> = new Set<SkinId>([
  "atelier",
  "lagoon",
  "linen",
  "daylight",
  "meadow",
  "pop",
]);

export function modeOf(skin: SkinId): ResolvedTheme {
  return LIGHT_SKINS.has(skin) ? "light" : "dark";
}

/** The choice as this control shows it: a pinned skin answers with its mode,
 * and `system` stays `system`. */
export function choiceOf(choice: SkinChoice): ThemeChoice {
  if (choice === "system") return "system";
  return modeOf(choice);
}

/** The skin a workbench choice asks for. A pinned choice names the skin the app
 * itself uses for that mode, so the two pickers agree on which skin "dark" is. */
export function skinFor(choice: ThemeChoice): SkinChoice {
  if (choice === "system") return "system";
  return choice === "dark" ? THEME_SKINS.dark : THEME_SKINS.light;
}

export function readThemeChoice(): ThemeChoice {
  return choiceOf(readSkinChoice());
}

export function setThemeChoice(next: ThemeChoice): void {
  applySkinChoice(skinFor(next));
}

function subscribe(listener: () => void): () => void {
  return subscribeSkin(listener);
}

export function currentTheme(): ResolvedTheme {
  return modeOf(resolveSkin(readSkinChoice()));
}

export function useTheme(): { readonly choice: ThemeChoice; readonly theme: ResolvedTheme } {
  const choice = useSyncExternalStore(subscribe, readThemeChoice, () => "system" as ThemeChoice);
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "dark" as ResolvedTheme);
  return { choice, theme };
}
