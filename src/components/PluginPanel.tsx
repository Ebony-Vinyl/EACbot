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
        const rows = state.bots.filter((bot) => !botId || bot.id === botId).flatMap((bot) => {
          if (item.source === "platforms") return bot.platformBinding ? [`${bot.name} · ${bot.platformBinding.platform}`] : [];
          if (item.source === "usage") return (bot.tasks ?? []).filter((task) => task.usage).map((task) => `${bot.name} · ${task.title} · ${task.usage!.input + task.usage!.output} tokens`);
          return (bot.tasks ?? []).map((task) => `${bot.name} · ${task.title} · ${task.busy ? t("pluginUi.running") : t("pluginUi.idle")}`);
        }).slice(0, 30);
        return <div key={index}>{item.title && <h4 className="mb-1 font-medium">{item.title}</h4>}{rows.length
          ? <ul className="grid gap-1">{rows.map((text, row) => <li className="break-words" key={row}>{text}</li>)}</ul>
          : <p className="text-ink-secondary">{t("pluginUi.emptyData")}</p>}</div>;
      })}
    </div>
  </section>;
}
