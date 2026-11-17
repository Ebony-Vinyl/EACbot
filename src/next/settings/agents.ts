/**
 * What the Agent settings screen can truthfully say about an engine.
 *
 * Three different sources answer three different questions, and this module
 * keeps them apart:
 *
 * - `/api/v1/agents` says which engines exist, how each signs in, and whether
 *   it can list models at all;
 * - `/api/v1/agents/:kind/models` says which models it listed *this time*, or
 *   `reported: false` when it cannot list any;
 * - the environment's own tool probe says whether the executable is installed
 *   and which version answered.
 *
 * A question no source answered is shown as unanswered. It is never filled in
 * from a default, because a person chooses a model and a sign-in method from
 * these rows.
 */
import type { AgentDescriptor, AuthMode, ModelCatalogEntry } from "../../../packages/agent-protocol/agents.ts";

export interface AgentModelsResponse {
  readonly agent: string;
  readonly models: readonly ModelCatalogEntry[];
  readonly reported: boolean;
}

export interface InstalledTool {
  readonly name: string;
  readonly status: "installed" | "missing" | "outdated" | "notThisTool" | "probeFailed";
  readonly path: string | null;
  readonly version: string | null;
  readonly detail?: string;
}

export type InstallState =
  | { readonly state: "installed"; readonly version: string | null; readonly path: string | null }
  | { readonly state: "outdated"; readonly version: string | null; readonly path: string | null }
  | { readonly state: "missing" }
  | { readonly state: "probeFailed"; readonly detail: string | undefined }
  | { readonly state: "notThisTool"; readonly path: string | null }
  /** The computer has not been probed, or the probe did not run: no claim. */
  | { readonly state: "unchecked" };

/** The tool name each agent's executable answers to. An agent with no entry
 * here (a custom ACP agent) has no fixed executable to look for. */
const TOOL_FOR_AGENT: Readonly<Record<string, string>> = {
  hermes: "hermes",
  claudeCode: "claude",
  codex: "codex",
  openCode: "opencode",
  pi: "pi",
  ohMyPi: "omp",
};

export function installState(agent: string, tools: readonly InstalledTool[] | undefined): InstallState {
  if (tools === undefined) return { state: "unchecked" };
  const toolName = TOOL_FOR_AGENT[agent];
  if (toolName === undefined) return { state: "unchecked" };
  const tool = tools.find((entry) => entry.name === toolName);
  if (tool === undefined) return { state: "unchecked" };
  switch (tool.status) {
    case "installed":
      return { state: "installed", version: tool.version, path: tool.path };
    case "outdated":
      return { state: "outdated", version: tool.version, path: tool.path };
    case "missing":
      return { state: "missing" };
    case "notThisTool":
      return { state: "notThisTool", path: tool.path };
    case "probeFailed":
      return { state: "probeFailed", detail: tool.detail };
  }
}

/** The model list, with the difference between "no models" and "cannot list"
 * preserved. */
export type ModelCatalogState =
  | { readonly state: "loading" }
  | { readonly state: "unknown"; readonly reason: string }
  | { readonly state: "empty"; readonly reason: string }
  | { readonly state: "listed"; readonly entries: readonly ModelCatalogEntry[] };

export const CANNOT_LIST_MODELS = "该 Agent 无法列出模型";

export function modelCatalogState(agent: AgentDescriptor, response: AgentModelsResponse | undefined): ModelCatalogState {
  if (response === undefined) {
    if (agent.capabilities.modelCatalog === false) return { state: "unknown", reason: CANNOT_LIST_MODELS };
    return { state: "loading" };
  }
  if (!response.reported) {
    return {
      state: "unknown",
      reason: agent.capabilities.modelCatalog === false
        ? CANNOT_LIST_MODELS
        : `${CANNOT_LIST_MODELS}。该引擎本次没有报告模型目录。`,
    };
  }
  if (response.models.length === 0) return { state: "empty", reason: "该 Agent 报告了模型目录，但其中没有任何模型。" };
  return { state: "listed", entries: response.models };
}

export const AUTH_MODE_LABELS: Readonly<Record<AuthMode, string>> = {
  subscription: "CLI 订阅登录",
  apiKey: "API key",
  compatibleEndpoint: "兼容端点",
  local: "本地 Provider",
};

export const AUTH_MODE_DETAILS: Readonly<Record<AuthMode, string>> = {
  subscription: "用该 Agent 自己的登录态，不经过 EACbot 计费。",
  apiKey: "由签发 key 的一方计费；key 属于这个 Agent 实例，不与其他 Agent 共享。",
  compatibleEndpoint: "填写一个兼容端点的 base URL；不内置任何供应商。",
  local: "在本机运行的 Provider。",
};

export function modelLabel(entry: ModelCatalogEntry): string {
  if (entry.ref.label !== undefined && entry.ref.label.length > 0) return entry.ref.label;
  return entry.ref.model;
}

export function modelValue(entry: ModelCatalogEntry): string {
  return entry.ref.model;
}

/** A model the person picked earlier, still present in this reading. A model
 * that disappeared is reported rather than silently swapped. */
export function selectedStillListed(selected: string | undefined, state: ModelCatalogState): boolean {
  if (selected === undefined) return true;
  if (state.state !== "listed") return true;
  return state.entries.some((entry) => modelValue(entry) === selected);
}

export function missingSelectionNotice(selected: string | undefined, state: ModelCatalogState): string | undefined {
  if (selected === undefined || state.state !== "listed" || selectedStillListed(selected, state)) return undefined;
  return `所选模型 ${selected} 已不在该 Agent 当前报告的目录中。请重新选择，或确认该引擎的登录状态。`;
}

/** How each auth mode is described for the agent that offers it. An agent
 * that does not offer a mode never shows it, so a person cannot pick a path
 * the engine cannot honour. */
export function authModesFor(agent: AgentDescriptor): readonly AuthMode[] {
  return agent.authModes;
}

export function defaultAuthMode(agent: AgentDescriptor): AuthMode | undefined {
  const modes = authModesFor(agent);
  return modes.includes("subscription") ? "subscription" : modes[0];
}

/** Capability rows worth showing, in the words a person chooses with. */
export function capabilityRows(agent: AgentDescriptor): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const capabilities = agent.capabilities;
  const steer = capabilities.steer;
  return [
    { label: "结构化事件", value: capabilities.events ? "支持" : "不支持" },
    {
      label: "追加指令",
      value: steer.kind === "native" ? "直接进入当前回合" : steer.kind === "next-boundary" ? "在下一个工具边界送达" : "不支持",
    },
    { label: "中断", value: capabilities.interrupt ? "支持" : "不支持" },
    { label: "恢复", value: capabilities.resume ? "支持" : "不支持" },
    { label: "终止", value: capabilities.cancel ? "支持" : "不支持" },
    { label: "审批", value: capabilities.approval ? "支持" : "不支持" },
    { label: "提问", value: capabilities.questions ? "支持" : "不支持" },
    { label: "模型目录", value: capabilities.modelCatalog ? "由引擎实时报告" : CANNOT_LIST_MODELS },
    { label: "子 Agent", value: capabilities.subagents ? "支持" : "不支持" },
    { label: "图片输入", value: capabilities.images ? "支持" : "不支持" },
  ];
}
