import type { PanelSlot, UiPanelSpec } from "../../shared/plugins/panels";
import type { ThemeSpec } from "../../shared/plugins/themes";

export interface PanelContribution {
  key: string;
  title: string;
  spec: UiPanelSpec;
}

export function panelsInSlot(panels: readonly PanelContribution[], slot: PanelSlot): PanelContribution[] {
  return panels.filter((panel) => panel.spec.slot === slot);
}

const THEME_KEY = "eac-plugin-theme";
const SAFE_MODE_KEY = "eac-plugin-ui-safe-mode";
const LAYOUT_KEY = "eac-plugin-layout";

const CHOICE_KEYS = { theme: THEME_KEY, safe: SAFE_MODE_KEY, layout: LAYOUT_KEY };

export function pluginUiChoice(key: keyof typeof CHOICE_KEYS): string | null {
  try { return localStorage.getItem(CHOICE_KEYS[key]); } catch { return null; }
}

export function choosePluginUi(key: keyof typeof CHOICE_KEYS, value: string | null): void {
  try {
    const storageKey = CHOICE_KEYS[key];
    if (value === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, value);
  } catch {}
  window.dispatchEvent(new Event("eac-plugin-ui-choice"));
}

export function pluginThemeStyle(theme: ThemeSpec): string {
  const { app, panel, ink, secondary, accent, accentInk } = theme.tokens;
  return `:root { --color-app:${app}; --color-panel:${panel}; --color-card:${panel}; --color-raised:${panel}; --color-raised-hover:${panel}; --color-menu:${panel}; --color-inset:${panel}; --color-control:${panel}; --color-composer:${panel}; --color-ink:${ink}; --color-ink-secondary:${secondary}; --color-ink-tertiary:${secondary}; --color-accent:${accent}; --color-accent-ink:${accentInk}; --color-accent-text:${ink}; }`;
}
