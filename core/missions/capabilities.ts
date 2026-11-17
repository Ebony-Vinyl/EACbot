import type { AgentCapabilities, AgentKind, SteerCapability } from "../../packages/agent-protocol/agents.ts";
import { AGENT_REGISTRY } from "../agents/registry.ts";

/** The protocol's view of an agent, derived from the one registry rather than kept beside it.
 * `modelCatalog` is a two-valued engine fact there and a boolean here; `subagents` and
 * `fileChanges` stay false because no adapter surfaces those events yet, and a capability
 * the caller cannot use is worse than one it does not see. */
function project(kind: AgentKind): AgentCapabilities {
  const registryKind = kind === "custom" ? "custom" : kind;
  const source = AGENT_REGISTRY[registryKind].capabilities;
  const steer: SteerCapability = source.steer;
  return {
    events: true,
    steer,
    interrupt: source.interrupt,
    resume: source.resume,
    cancel: source.cancel,
    approval: source.approvals,
    questions: source.questions,
    nativeTui: source.nativeTui,
    modelCatalog: source.modelCatalog === "native",
    subagents: false,
    images: source.images,
    usage: source.usage,
    fileChanges: false,
  };
}

const CAPABILITIES: Readonly<Record<AgentKind, AgentCapabilities>> = {
  hermes: project("hermes"),
  claudeCode: project("claudeCode"),
  codex: project("codex"),
  openCode: project("openCode"),
  pi: project("pi"),
  ohMyPi: project("ohMyPi"),
  custom: project("custom"),
};

export function capabilitiesFor(agent: AgentKind): AgentCapabilities {
  return CAPABILITIES[agent];
}

export function supports(agent: AgentKind, capability: keyof AgentCapabilities): boolean {
  const value = CAPABILITIES[agent][capability];
  return typeof value === "boolean" ? value : value.kind !== "none";
}
