/**
 * Starting a task: the prompt, the agent, and — only when the agent lists one
 * — the model.
 *
 * The model picker is fed from `/api/v1/agents/:kind/models`. An agent that
 * cannot list models gets no picker and a sentence saying so; it never gets a
 * guessed list, because a wrong model id runs a person's work on an engine
 * they did not choose.
 */
import { useState, type ReactNode } from "react";

import type { AgentDescriptor, AuthMode } from "../../../packages/agent-protocol/agents.ts";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { actionFailureMessage, useAgentModels, useAgents } from "./foundation.ts";
import { commandId, missionActions } from "./actions.ts";
import { AUTH_MODE_DETAILS, AUTH_MODE_LABELS, defaultAuthMode, modelCatalogState, modelLabel, modelValue, CANNOT_LIST_MODELS } from "../settings/agents.ts";
import { LoadableView } from "./ui.tsx";

/** Only what the form shows about the computer a task will run on. */
export interface CreateEnvironment {
  readonly kind?: "local" | "ssh";
  readonly id: string;
  readonly label: string;
}

export interface CreateMissionProps {
  readonly environment: CreateEnvironment | null;
  readonly onCreated: (missionId: string) => void;
  readonly onCancel: () => void;
  readonly parentMissionId?: string;
}

const selectClass =
  "rounded-lg border border-hairline/40 bg-app px-2.5 py-1.5 text-[12px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/60";
const textareaClass =
  "w-full resize-y rounded-lg border border-hairline/40 bg-app px-2.5 py-1.5 text-[12px] leading-5 text-ink outline-none placeholder:text-ink-secondary focus:ring-1 focus:ring-accent/60";

export function CreateMission({ environment, onCreated, onCancel, parentMissionId }: CreateMissionProps): ReactNode {
  const agents = useAgents();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState<string | null>(null);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const selected = agents.status === "ready" ? agents.data.find((candidate) => candidate.kind === agent) : undefined;
  const modes = selected?.authModes ?? [];
  const chosenMode = authMode !== null && modes.includes(authMode) ? authMode : selected === undefined ? undefined : defaultAuthMode(selected);
  const models = useAgentModels(agent);
  const catalog = selected === undefined ? undefined : modelCatalogState(selected, models.status === "ready" ? { agent: selected.kind, models: models.data.models, reported: models.data.reported } : undefined);

  const ready = title.trim().length > 0 && prompt.trim().length > 0 && agent !== null && environment !== null && chosenMode !== undefined;

  const submit = async (): Promise<void> => {
    if (!ready || agent === null || environment === null || chosenMode === undefined) {
      setMissing(environment === null);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      const result = await missionActions.create({
        commandId: commandId(),
        title: title.trim(),
        prompt: prompt.trim(),
        agent,
        environment: {
          id: environment.id,
          label: environment.label,
          kind: environment.kind ?? "ssh",
          authMode: chosenMode,
        },
        ...(model !== undefined ? { model: { agent, model } } : {}),
        ...(parentMissionId !== undefined ? { parentMissionId } : {}),
      });
      onCreated(result.missionId);
    } catch (error) {
      setFailure(actionFailureMessage(error));
    } finally {
      setSaving(false);
    }
  };

  if (environment === null) {
    return (
      <div className="rounded-xl border border-hairline/40 bg-card/60 p-4" data-testid="create-mission-no-environment">
        <p className="text-[12px] font-medium text-ink">先连接一台电脑</p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-secondary">
          任务需要在一台电脑上运行。在设置的“我的云电脑”里添加你自己的 SSH 电脑，然后回到这里。
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="create-mission">
      <h2 className="text-[12px] font-semibold text-ink">{parentMissionId === undefined ? "新任务" : "新子任务"}</h2>

      <Field label="标题">
        <Input value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="例如：整理收件箱并起草回复" />
      </Field>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-ink-secondary">交给 Agent 的说明</span>
        <textarea
          className={textareaClass}
          value={prompt}
          rows={5}
          placeholder="写清楚目标、范围和你希望的完成条件"
          onChange={(event) => setPrompt(event.currentTarget.value)}
        />
      </label>

      <LoadableView state={agents} label="正在读取 Agent 列表" what="Agent 列表">
        {(list) => (
          <AgentPicker list={list} value={agent} onChange={(kind) => { setAgent(kind); setModel(undefined); }} />
        )}
      </LoadableView>

      {selected !== undefined && modes.length > 0 && (
        <SignInPicker agent={selected} modes={modes} value={chosenMode} onChange={setAuthMode} />
      )}

      {selected !== undefined && catalog !== undefined && (
        <ModelPicker
          label={`${selected.label} 的模型`}
          catalog={catalog}
          value={model}
          onChange={setModel}
        />
      )}

      <p className="text-[10px] text-ink-secondary">运行在 {environment.label}。</p>

      {missing && <Notice tone="warning" title="还没有选电脑" detail="任务需要一台电脑才能运行。" />}
      {failure !== null && <Notice tone="danger" title="没能创建任务" detail={failure} />}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="primary" size="sm" disabled={!ready || saving} onClick={() => void submit()}>
          {saving ? "创建中…" : "创建任务"}
        </Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

function Notice({ tone, title, detail }: { readonly tone: "warning" | "danger"; readonly title: string; readonly detail: string }): ReactNode {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cn(
        "rounded-lg border px-3 py-2",
        tone === "danger" ? "border-danger/30 bg-danger/10" : "border-warning/30 bg-warning/10",
      )}
    >
      <p className={cn("text-[11px] font-medium", tone === "danger" ? "text-danger" : "text-warning")}>{title}</p>
      <p className="mt-0.5 text-[10px] leading-relaxed text-ink-secondary">{detail}</p>
    </div>
  );
}

function AgentPicker({ list, value, onChange }: { readonly list: readonly AgentDescriptor[]; readonly value: string | null; readonly onChange: (kind: string) => void }): ReactNode {
  return (
    <Field label="Agent">
      <select value={value ?? ""} onChange={(event) => onChange(event.currentTarget.value)} className={cn(selectClass, "w-full")}>
        <option value="">选择一个 Agent</option>
        {list.map((agent) => (
          <option key={agent.kind} value={agent.kind}>
            {agent.label} · {agent.authModes.join(" · ")}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** The sign-in mode belongs to this task's agent instance, so it is chosen
 * here and travels with the environment reference. Only the modes the agent
 * declares are offered. */
export function SignInPicker({
  agent,
  modes,
  value,
  onChange,
}: {
  readonly agent: AgentDescriptor;
  readonly modes: readonly AuthMode[];
  readonly value: AuthMode | undefined;
  readonly onChange: (mode: AuthMode) => void;
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={`${agent.label} 的认证方式`} className="flex flex-col gap-1">
      <p className="text-[10px] uppercase tracking-wide text-ink-secondary">认证方式</p>
      {modes.map((mode) => (
        <label
          key={mode}
          className={cn(
            "flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 transition-colors duration-150",
            value === mode ? "bg-raised" : "hover:bg-raised/60",
          )}
        >
          <input
            type="radio"
            name={`mission-auth-${agent.kind}`}
            value={mode}
            checked={value === mode}
            onChange={() => onChange(mode)}
            className="mt-0.5 accent-[var(--color-accent)]"
          />
          <span className="flex flex-col">
            <span className="text-[12px] text-ink">{AUTH_MODE_LABELS[mode]}</span>
            <span className="text-[10px] leading-relaxed text-ink-secondary">{AUTH_MODE_DETAILS[mode]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

export function ModelPicker({
  label,
  catalog,
  value,
  onChange,
}: {
  readonly label: string;
  readonly catalog: ReturnType<typeof modelCatalogState>;
  readonly value: string | undefined;
  readonly onChange: (value: string) => void;
}): ReactNode {
  if (catalog.state === "loading") {
    return <p className="text-[10px] text-ink-secondary">正在读取模型目录</p>;
  }
  if (catalog.state !== "listed") {
    return (
      <div className="flex flex-col gap-0.5">
        <p className="text-[11px] text-ink">{catalog.state === "empty" ? "该 Agent 没有报告任何模型" : CANNOT_LIST_MODELS}</p>
        <p className="text-[10px] text-ink-secondary">{catalog.reason}</p>
      </div>
    );
  }
  return (
    <Field label={label}>
      <select value={value ?? ""} onChange={(event) => onChange(event.currentTarget.value)} className={cn(selectClass, "w-full")}>
        <option value="">使用该 Agent 的默认模型</option>
        {catalog.entries.map((entry) => (
          <option key={modelValue(entry)} value={modelValue(entry)}>
            {modelLabel(entry)}
          </option>
        ))}
      </select>
    </Field>
  );
}
