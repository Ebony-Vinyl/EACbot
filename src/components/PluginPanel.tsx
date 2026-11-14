import { useEffect, useState } from "react";
import { readTaskPanelData } from "@/features/tasks/panel-data";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import type { UiPanelSpec } from "../../shared/plugins/panels";
import { PluginSandboxPanel } from "./PluginSandboxPanel";
import { PluginPanelBoundary } from "./PluginPanelBoundary";

export function PluginPanel({ spec, botId }: { spec: UiPanelSpec; botId?: string }) {
  return (
    <PluginPanelBoundary key={JSON.stringify(spec)}>
      <PanelContent spec={spec} botId={botId} />
    </PluginPanelBoundary>
  );
}

function PanelContent({ spec, botId }: { spec: UiPanelSpec; botId?: string }) {
  const { state } = useStore();
  return <section className="min-w-0 rounded-xl border border-hairline bg-panel p-4" aria-label={spec.title}>
    <h3 className="mb-3 text-base font-semibold">{spec.title}</h3>
    <div className="grid gap-3 text-sm">
      {"html" in spec ? <PluginSandboxPanel spec={spec} botId={botId} /> : spec.items.map((item, index) => {
        if (item.type === "text") return <p key={index} className="whitespace-pre-wrap break-words">{item.text}</p>;
        if (item.type === "list") return (
          <div key={index}>
            {item.title && <h4 className="font-medium">{item.title}</h4>}
            <ul className="list-inside list-disc">
              {item.items.map((text, row) => <li key={row} className="break-words">{text}</li>)}
            </ul>
          </div>
        );
        if (item.source !== "platforms") return <TaskPanelData key={index} source={item.source} title={item.title} botId={botId} />;
        const rows = state.bots.filter((bot) => !botId || bot.id === botId).flatMap((bot) => bot.platformBinding ? [`${bot.name} · ${bot.platformBinding.platform}`] : []).slice(0, 30);
        return <div key={index}>{item.title && <h4 className="mb-1 font-medium">{item.title}</h4>}{rows.length
          ? <ul className="grid gap-1">{rows.map((text, row) => <li className="break-words" key={row}>{text}</li>)}</ul>
          : <p className="text-ink-secondary">{t("pluginUi.emptyData")}</p>}</div>;
      })}
    </div>
  </section>;
}

function TaskPanelData({ source, title, botId }: { source: "tasks" | "usage"; title?: string; botId?: string }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const read = () => void readTaskPanelData(source, botId, controller.signal).then((data) => {
      if (!controller.signal.aborted) { setRows(data); setError(""); }
    }).catch((failure: Error) => { if (!controller.signal.aborted) { setRows([]); setError(failure.message); } });
    read();
    const timer = setInterval(read, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [source, botId]);
  return <div>{title && <h4 className="mb-1 font-medium">{title}</h4>}
    {error ? <p role="status">{error}</p> : rows.length ? <ul className="grid gap-1">{rows.map((row, index) => <li key={index} className="break-words">{source === "tasks" ? `${String(row.title)} · ${String(row.column)}` : `${String(row.kind)} · ${String(row.quantity)} ${String(row.unit)} · ${String((row.cost as { state: string }).state)}`}</li>)}</ul> : <p className="text-ink-secondary">{t("pluginUi.emptyData")}</p>}
  </div>;
}
