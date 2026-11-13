import { useEffect, useState } from "react";

import { api } from "@/state/store";
import { pluginThemeStyle, pluginUiChoice } from "@/lib/plugin-slots";
import { themeSpecSchema } from "../../shared/plugins/themes";
import { isOwnerOrAdmin, readSessionState } from "@/lib/session";

export function PluginUiHost() {
  const [, refresh] = useState(0);
  useEffect(() => {
    const changed = () => refresh((value) => value + 1);
    window.addEventListener("eac-plugin-ui-choice", changed);
    window.addEventListener("storage", changed);
    return () => {
      window.removeEventListener("eac-plugin-ui-choice", changed);
      window.removeEventListener("storage", changed);
    };
  }, []);
  const theme = pluginUiChoice("theme"), safe = pluginUiChoice("safe") === "1";
  useEffect(() => {
    const style = document.createElement("style");
    style.dataset.pluginTheme = "true";
    document.head.append(style);
    let cancelled = false;
    const load = async () => {
      if (!theme || safe) { style.textContent = ""; return; }
      try {
        if (!isOwnerOrAdmin(await readSessionState())) { if (!cancelled) style.textContent = ""; return; }
        const result = await api<{ themes: Array<{ key: string; spec: unknown }> }>("/api/plugins/ui", { background: true });
        if (cancelled) return;
        const selected = result.themes.find((entry) => entry.key === theme);
        const parsed = themeSpecSchema.safeParse(selected?.spec);
        style.textContent = parsed.success ? pluginThemeStyle(parsed.data) : "";
      } catch { if (!cancelled) style.textContent = ""; }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    window.addEventListener("eac-plugin-ui-refresh", load);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener("eac-plugin-ui-refresh", load); style.remove(); };
  }, [theme, safe]);
  return null;
}
