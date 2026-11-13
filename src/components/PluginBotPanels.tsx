import { useEffect, useState } from "react";

import { api } from "@/state/store";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { panelsInSlot, pluginUiChoice, type PanelContribution } from "@/lib/plugin-slots";
import type { LayoutSpec, SavedPanel } from "../../shared/plugins/panels";
import { PluginPanel } from "./PluginPanel";

export function PluginBotPanels({ botId }: { botId: string }) {
  const owner = useOwnerOrAdmin();
  const [panels, setPanels] = useState<PanelContribution[]>([]);
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    const load = async () => {
      const request = ++sequence;
      if (!owner || pluginUiChoice("safe") === "1") { setPanels([]); return; }
      try {
        const result = await api<{ panels: PanelContribution[]; saved: SavedPanel[]; layouts: Array<{ key: string; spec: LayoutSpec }> }>("/api/plugins/ui", { background: true });
        if (cancelled || request !== sequence) return;
        const available = panelsInSlot([
          ...result.panels,
          ...result.saved.map((panel) => ({ key: `local:${panel.panelId}`, title: panel.spec.title, spec: panel.spec })),
        ], "bot");
        const layout = result.layouts.find((entry) => entry.key === pluginUiChoice("layout"))?.spec;
        setPanels(layout ? layout.panels.flatMap((key) => available.filter((panel) => panel.key === key)) : available);
        setColumns(layout?.columns ?? 1);
      } catch { if (!cancelled && request === sequence) setPanels([]); }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    const refresh = () => { void load(); };
    window.addEventListener("eac-plugin-ui-refresh", refresh);
    window.addEventListener("eac-plugin-ui-choice", refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("eac-plugin-ui-refresh", refresh);
      window.removeEventListener("eac-plugin-ui-choice", refresh);
    };
  }, [owner, botId]);
  return (
    <div className={`grid gap-3 ${columns === 2 ? "md:grid-cols-2" : ""}`}>
      {panels.map((panel) => <PluginPanel key={panel.key} spec={panel.spec} botId={botId} />)}
    </div>
  );
}
