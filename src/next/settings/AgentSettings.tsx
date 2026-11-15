/**
 * Agent settings: what each engine can do, whether it is installed, how it
 * signs in, and which models it can actually run.
 *
 * Every row here answers with something a source said. A model list that the
 * engine did not report shows "该 Agent 无法列出模型" — never a guessed list —
 * because a person picks a model from this screen and a wrong entry would run
 * their work on an engine they did not choose.
 */
import { useState, type ReactNode } from "react";

import type { AgentDescriptor } from "../../../packages/agent-protocol/agents.ts";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { useAgentModels, useAgents } from "../personal/foundation.ts";
import { LoadableView } from "../personal/ui.tsx";
import {
  AUTH_MODE_DETAILS, AUTH_MODE_LABELS, capabilityRows, defaultAuthMode, installState, missingSelectionNotice,
  modelCatalogState, modelLabel, modelValue, type InstalledTool, type ModelCatalogState,
} from "./agents.ts";

export interface AgentSettingsProps {
  /** The chosen computer's own tool probe. Absent until a computer is picked,
   * and absent means "unchecked", never "installed". */
  readonly tools?: readonly InstalledTool[];
}

const selectClass =
  "rounded-lg border border-hairline/40 bg-app px-2.5 py-1.5 text-[12px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/60";

export function AgentSettings({ tools }: AgentSettingsProps): ReactNode {
  const agents = useAgents();
  return (
    <section className="flex flex-col gap-3" data-testid="agent-settings">
      <header className="flex flex-col gap-1">
        <h2 className="text-[12px] font-semibold text-ink">Agent</h2>
        <p className="text-[10px] leading-relaxed text-ink-secondary">
          这些是你自己安装的 Agent 软件。EACbot 只负责启动、观察和记录，不销售软件，也不代理登录。
        </p>
      </header>
      <LoadableView state={agents} label="正在读取 Agent 列表" what="Agent 设置">
        {(list) =>
          list.length === 0 ? (
            <Card className="p-4" data-testid="agent-settings-empty">
              <p className="text-[11px] leading-relaxed text-ink-secondary">
                服务器没有报告任何 Agent。先连接一台电脑，并在上面安装想用的 Agent。
              </p>
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              {list.map((agent) => (
                <AgentRow key={agent.kind} agent={agent} {...(tools !== undefined ? { tools } : {})} />
              ))}
            </div>
          )
        }
      </LoadableView>
    </section>
  );
}

function AgentRow({ agent, tools }: { readonly agent: AgentDescriptor; readonly tools?: readonly InstalledTool[] }): ReactNode {
  const models = useAgentModels(agent.kind);
  const install = installState(agent.kind, tools);
  const catalog = modelCatalogState(agent, models.status === "ready" ? { agent: agent.kind, models: models.data.models, reported: models.data.reported } : undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [authMode, setAuthMode] = useState(() => defaultAuthMode(agent));
  const modes = agent.authModes;

  return (
    <Card className="flex flex-col gap-2.5 p-4" data-testid={`agent-row-${agent.kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 truncate text-[12px] font-semibold text-ink">{agent.label}</h3>
        <span className="font-mono text-[10px] text-ink-secondary">{agent.kind}</span>
        <InstallBadge install={install} />
      </div>

      {install.state === "missing" && (
        <Notice tone="accent" title="还没有安装" detail="在选中的电脑上按该 Agent 自己的说明安装。安装完成后回到这里测试连接，安装状态会重新读取。" />
      )}
      {install.state === "probeFailed" && (
        <Notice tone="warning" title="没能确认安装状态" detail={install.detail ?? "探测没有返回结果，所以这里不声称已安装。"} />
      )}
      {install.state === "notThisTool" && (
        <Notice tone="warning" title="这个命令不是该 Agent" detail={`${install.path ?? "该路径"} 上的程序不是 ${agent.label}。换一个可执行文件，或检查 PATH。`} />
      )}
      {install.state === "unchecked" && <p className="text-[10px] text-ink-secondary">还没有在这台电脑上检查安装状态。</p>}
      {(install.state === "installed" || install.state === "outdated") && (
        <p className="text-[10px] text-ink-secondary">
          版本 {install.version ?? "未报告"} · {install.path ?? "路径未报告"}
          {install.state === "outdated" ? " · 有新版本可用" : ""}
        </p>
      )}

      <hr className="border-hairline/30" />

      <div className="flex flex-col gap-1">
        <p className="text-[10px] uppercase tracking-wide text-ink-secondary">认证方式</p>
        {modes.length === 0 ? (
          <p className="text-[11px] text-ink-secondary">该 Agent 没有声明任何认证方式。</p>
        ) : (
          <div role="radiogroup" aria-label={`${agent.label} 的认证方式`} className="flex flex-col gap-1">
            {modes.map((mode) => (
              <label
                key={mode}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 transition-colors duration-150",
                  authMode === mode ? "bg-raised" : "hover:bg-raised/60",
                )}
              >
                <input
                  type="radio"
                  name={`auth-${agent.kind}`}
                  value={mode}
                  checked={authMode === mode}
                  onChange={() => setAuthMode(mode)}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <span className="flex flex-col">
                  <span className="text-[12px] text-ink">{AUTH_MODE_LABELS[mode]}</span>
                  <span className="text-[10px] leading-relaxed text-ink-secondary">{AUTH_MODE_DETAILS[mode]}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <hr className="border-hairline/30" />

      <ModelRow agent={agent} catalog={catalog} selected={selected} onSelect={setSelected} loading={models.status === "loading"} />

      <details>
        <summary className="cursor-pointer select-none text-[11px] text-ink-secondary">能力</summary>
        <dl className="m-0 mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          {capabilityRows(agent).map((row) => (
            <div key={row.label} className="flex justify-between gap-2">
              <dt className="text-ink-secondary">{row.label}</dt>
              <dd className="m-0 text-ink">{row.value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </Card>
  );
}

const INSTALL_TONE: Readonly<Record<ReturnType<typeof installState>["state"], string>> = {
  installed: "bg-success/15 text-success",
  outdated: "bg-warning/15 text-warning",
  missing: "bg-raised text-ink-secondary",
  probeFailed: "bg-warning/15 text-warning",
  notThisTool: "bg-danger/15 text-danger",
  unchecked: "bg-raised text-ink-secondary",
};

const INSTALL_LABEL: Readonly<Record<ReturnType<typeof installState>["state"], string>> = {
  installed: "已安装",
  outdated: "版本较旧",
  missing: "未安装",
  probeFailed: "探测失败",
  notThisTool: "不是该 Agent",
  unchecked: "未检查",
};

function InstallBadge({ install }: { readonly install: ReturnType<typeof installState> }): ReactNode {
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px]", INSTALL_TONE[install.state])}>{INSTALL_LABEL[install.state]}</span>;
}

function Notice({ tone, title, detail }: { readonly tone: "accent" | "warning"; readonly title: string; readonly detail: string }): ReactNode {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2",
        tone === "warning" ? "border-warning/30 bg-warning/10" : "border-accent/30 bg-accent/10",
      )}
    >
      <p className={cn("text-[11px] font-medium", tone === "warning" ? "text-warning" : "text-accent")}>{title}</p>
      <p className="mt-0.5 text-[10px] leading-relaxed text-ink-secondary">{detail}</p>
    </div>
  );
}

function ModelRow({
  agent,
  catalog,
  selected,
  onSelect,
  loading,
}: {
  readonly agent: AgentDescriptor;
  readonly catalog: ModelCatalogState;
  readonly selected: string | undefined;
  readonly onSelect: (value: string) => void;
  readonly loading: boolean;
}): ReactNode {
  const notice = missingSelectionNotice(selected, catalog);

  if (catalog.state === "loading" || loading) {
    return <p className="text-[11px] text-ink-secondary">正在读取模型目录</p>;
  }

  if (catalog.state === "unknown" || catalog.state === "empty") {
    return (
      <div className="flex flex-col gap-0.5" data-testid={`model-unavailable-${agent.kind}`}>
        <p className="text-[11px] text-ink">{catalog.state === "unknown" ? "该 Agent 无法列出模型" : "该 Agent 没有报告任何模型"}</p>
        <p className="text-[10px] text-ink-secondary">{catalog.reason}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Field label={`${agent.label} 的模型`}>
        <select value={selected ?? ""} onChange={(event) => onSelect(event.currentTarget.value)} className={cn(selectClass, "w-full")}>
          <option value="">选择模型</option>
          {catalog.entries.map((entry) => (
            <option key={modelValue(entry)} value={modelValue(entry)}>
              {modelLabel(entry)}
            </option>
          ))}
        </select>
      </Field>
      {notice !== undefined && <p className="text-[10px] text-danger">{notice}</p>}
    </div>
  );
}
