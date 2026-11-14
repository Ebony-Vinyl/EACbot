import { readTaskPanelData } from "@/features/tasks/panel-data";
import { useEffect, useRef } from "react";

import { useStore } from "@/state/store";
import { mountAppFrame } from "./app/app-frame-host";
import { panelFrameRpc, pluginPanelDocument } from "../../shared/plugins/panel-frame";
import type { SandboxPanelSpec } from "../../shared/plugins/panels";

export function PluginSandboxPanel({ spec, botId }: { spec: SandboxPanelSpec; botId?: string }) {
  const { state } = useStore();
  const current = useRef(state);
  current.current = state;
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    let active = true;
    const nonce = crypto.randomUUID();
    const refuse = () => { throw new Error("This panel has read-only access."); };
    const frame = mountAppFrame({
      container: container.current,
      doc: pluginPanelDocument(spec),
      title: spec.title,
      height: 240,
      hostContext: { pluginPanelNonce: nonce, containerDimensions: { maxHeight: 720 } },
      hostVersion: "1.0.0",
      adapter: {
        callRpc: async (method, params) => panelFrameRpc(method, params, {
          nonce,
          active: () => active,
          read: (source) => source !== "platforms" ? readTaskPanelData(source, botId) : current.current.bots.filter((bot) => !botId || bot.id === botId).flatMap<Record<string, unknown>>((bot) => {
            if (source === "platforms") return bot.platformBinding ? [{ botId: bot.id, name: bot.name, platform: bot.platformBinding.platform }] : [];
            return (bot.tasks ?? []).flatMap<Record<string, unknown>>((task) => {
              if (source === "usage") return task.usage ? [{ botId: bot.id, title: task.title, usage: task.usage }] : [];
              return [{ botId: bot.id, title: task.title, busy: task.busy === true }];
            });
          }).slice(0, 30),
        }),
        sendMessage: refuse,
        openLink: refuse,
        setContext: refuse,
        resize: () => {},
        teardownRequested: () => { active = false; frame.destroy(); },
      },
    });
    return () => {
      active = false;
      void frame.teardown();
    };
  }, [spec.html, spec.title, spec.slot, botId]);
  return <div ref={container} className="min-w-0 overflow-hidden rounded-lg" />;
}
