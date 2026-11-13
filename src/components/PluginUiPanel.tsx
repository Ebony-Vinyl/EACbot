import { useCallback, useEffect, useState } from "react";

import { api, useStore } from "@/state/store";
import { choosePluginUi, panelsInSlot, pluginUiChoice, type PanelContribution } from "@/lib/plugin-slots";
import { t } from "@/lib/i18n";
import { panelSpecSchema, type LayoutSpec, type PanelSpec, type SavedPanel } from "../../shared/plugins/panels";
import { PluginPanel } from "./PluginPanel";

interface UiCatalog {
  panels: PanelContribution[];
  themes: Array<{ key: string; title: string }>;
  layouts: Array<{ key: string; title: string; spec: LayoutSpec }>;
  errors: Array<{ key: string; error: string }>;
  saved: SavedPanel[];
}

export function PluginUiPanel() {
  const { state } = useStore();
  const [catalog, setCatalog] = useState<UiCatalog | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [safe, setSafe] = useState(pluginUiChoice("safe") === "1");
  const [theme, setTheme] = useState(pluginUiChoice("theme") ?? "");
  const [slot, setSlot] = useState<"workspace" | "bot">("workspace");
  const [layout, setLayout] = useState(pluginUiChoice("layout") ?? "");
  const [prompt, setPrompt] = useState("");
  const [botId, setBotId] = useState(state.bots[0]?.id ?? "");
  const [panelId, setPanelId] = useState("");
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<PanelSpec | null>(null);
  const [editing, setEditing] = useState<SavedPanel | null>(null);
  const load = useCallback(async () => {
    try {
      setCatalog(await api<UiCatalog>("/api/plugins/ui"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);
  useEffect(() => {
    const refresh = () => { void load(); };
    refresh();
    const timer = setInterval(refresh, 10_000);
    window.addEventListener("eac-plugin-ui-refresh", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("eac-plugin-ui-refresh", refresh);
    };
  }, [load]);
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setError("");
      await load();
      window.dispatchEvent(new Event("eac-plugin-ui-refresh"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const parseDraft = () => {
    try {
      setPreview(panelSpecSchema.parse(JSON.parse(draft)));
      setError("");
    } catch (reason) {
      setPreview(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const generate = () => mutate(async () => {
    const result = await api<{ spec: PanelSpec }>("/api/plugins/ui/generate", { method: "POST", body: JSON.stringify({ prompt, botId }), timeoutMs: 65_000 });
    const spec = panelSpecSchema.parse(result.spec);
    setDraft(JSON.stringify(spec, null, 2));
    setPreview(spec);
    setEditing(null);
    setPanelId("");
  });
  const save = () => mutate(async () => {
    const spec = panelSpecSchema.parse(JSON.parse(draft));
    const result = await api<{ panel: SavedPanel }>("/api/plugins/ui/panels", { method: "POST", body: JSON.stringify({ panelId, expectedRevision: editing?.revision ?? 0, spec }) });
    setEditing(result.panel);
    setPreview(spec);
  });
  const edit = (panel: SavedPanel) => {
    setEditing(panel);
    setPanelId(panel.panelId);
    setDraft(JSON.stringify(panel.spec, null, 2));
    setPreview(panel.spec);
  };
  const reset = () => {
    setEditing(null);
    setPanelId("");
    setDraft("");
    setPreview(null);
  };
  const rollback = (panel: SavedPanel) => mutate(async () => {
    const result = await api<{ history: SavedPanel[] }>(`/api/plugins/ui/panels/${panel.panelId}`);
    const previous = result.history[1];
    if (!previous) return;
    const restored = await api<{ panel: SavedPanel }>(`/api/plugins/ui/panels/${panel.panelId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: panel.revision, revision: previous.revision }),
    });
    if (editing?.panelId === panel.panelId) edit(restored.panel);
  });
  const remove = (panel: SavedPanel) => mutate(async () => {
    await api(`/api/plugins/ui/panels/${panel.panelId}?revision=${panel.revision}`, { method: "DELETE" });
    if (editing?.panelId === panel.panelId) reset();
  });
  const button = "rounded-lg border border-hairline px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-50";
  const field = "min-w-0 rounded-lg border border-hairline bg-panel px-3 py-2 text-sm text-ink";
  const allPanels = [
    ...(catalog?.panels ?? []),
    ...(catalog?.saved ?? []).map((panel) => ({ key: `local:${panel.panelId}`, title: panel.spec.title, spec: panel.spec })),
  ];
  const selectedLayout = catalog?.layouts.find((entry) => entry.key === layout)?.spec;
  const slotPanels = panelsInSlot(allPanels, slot);
  const visible = selectedLayout
    ? selectedLayout.panels.flatMap((key) => slotPanels.filter((panel) => panel.key === key))
    : slotPanels;
  return (
    <section className="mt-6 border-t border-hairline pt-5" aria-label={t("pluginUi.title")}>
      <h3 className="text-base font-semibold">{t("pluginUi.title")}</h3>
      <div className="my-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={safe}
            onChange={(event) => {
              setSafe(event.target.checked);
              choosePluginUi("safe", event.target.checked ? "1" : null);
            }}
          />
          {t("pluginUi.safeMode")}
        </label>
        <select
          className={field}
          value={catalog?.themes.some((entry) => entry.key === theme) ? theme : ""}
          disabled={safe}
          aria-label={t("pluginUi.theme")}
          onChange={(event) => {
            setTheme(event.target.value);
            choosePluginUi("theme", event.target.value || null);
          }}
        >
          <option value="">{t("pluginUi.builtinTheme")}</option>
          {catalog?.themes.map((entry) => <option key={entry.key} value={entry.key}>{entry.title}</option>)}
        </select>
        <select
          className={field}
          value={slot}
          aria-label={t("pluginUi.slot")}
          onChange={(event) => setSlot(event.target.value as "workspace" | "bot")}
        >
          <option value="workspace">{t("pluginUi.workspace")}</option>
          <option value="bot">{t("pluginUi.bot")}</option>
        </select>
        <select
          className={field}
          value={selectedLayout ? layout : ""}
          aria-label={t("pluginUi.layout")}
          onChange={(event) => {
            setLayout(event.target.value);
            choosePluginUi("layout", event.target.value || null);
          }}
        >
          <option value="">{t("pluginUi.defaultLayout")}</option>
          {catalog?.layouts.map((entry) => <option key={entry.key} value={entry.key}>{entry.title}</option>)}
        </select>
      </div>
      {error && <p role="alert" className="my-2 break-words text-sm text-danger">{error}</p>}
      {!safe && (
        <div className={`grid gap-3 ${selectedLayout?.columns === 2 ? "md:grid-cols-2" : ""}`}>
          {visible.map((panel) => <PluginPanel key={panel.key} spec={panel.spec} />)}
        </div>
      )}
      {catalog?.errors.map((entry) => (
        <p key={entry.key} className="mt-2 break-words text-sm text-danger">{entry.key} · {entry.error}</p>
      ))}
      <details className="mt-4 rounded-xl border border-hairline p-3">
        <summary className="cursor-pointer text-sm font-medium">{t("pluginUi.create")}</summary>
        <div className="mt-3 grid gap-2">
          <select className={field} value={botId} aria-label={t("pluginUi.modelBot")} onChange={(event) => setBotId(event.target.value)}>
            {state.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
          <textarea
            className={field}
            value={prompt}
            maxLength={4000}
            aria-label={t("pluginUi.request")}
            placeholder={t("pluginUi.request")}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <button className={button} disabled={busy || !prompt.trim() || !botId} onClick={() => void generate()}>
            {t("pluginUi.generate")}
          </button>
          <textarea
            className={`${field} min-h-44 font-mono`}
            value={draft}
            maxLength={128000}
            aria-label={t("pluginUi.json")}
            onChange={(event) => {
              setDraft(event.target.value);
              setPreview(null);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={busy || !draft} onClick={parseDraft}>{t("pluginUi.preview")}</button>
            <input
              className={field}
              value={panelId}
              placeholder={t("pluginUi.id")}
              aria-label={t("pluginUi.id")}
              disabled={editing !== null}
              onChange={(event) => setPanelId(event.target.value)}
            />
            <button className={button} disabled={busy || !preview || !panelId} onClick={() => void save()}>{t("pluginUi.save")}</button>
            <button className={button} disabled={busy} onClick={reset}>{t("pluginUi.new")}</button>
          </div>
          {preview && <PluginPanel spec={preview} />}
        </div>
      </details>
      <div className="mt-3 grid gap-2">
        {catalog?.saved.map((panel) => (
          <div key={panel.panelId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex-1">{panel.spec.title} · v{panel.revision}</span>
            <button className={button} disabled={busy} onClick={() => edit(panel)}>{t("pluginUi.edit")}</button>
            <button className={button} disabled={busy || panel.revision <= 1} onClick={() => void rollback(panel)}>{t("pluginUi.rollback")}</button>
            <button className={button} disabled={busy} onClick={() => void remove(panel)}>{t("pluginUi.delete")}</button>
          </div>
        ))}
      </div>
    </section>
  );
}
