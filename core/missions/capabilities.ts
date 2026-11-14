import type { AgentCapabilities, AgentKind, SteerCapability } from "../../packages/agent-protocol/agents.ts";

/** The protocol's own view of an agent, keyed by its own kind names. `custom`
 * is the protocol's name for core/agents' `customAcp`. Every row must agree
 * with `core/agents/registry.ts`; `capabilities.test.ts` checks the fields the
 * two share. */
const STEER_NATIVE: SteerCapability = { kind: "native" };
const STEER_NEXT_BOUNDARY: SteerCapability = {
  kind: "next-boundary",
  note: "delivered at the agent's next tool boundary, not folded into the running step",
};
const STEER_NONE: SteerCapability = { kind: "none", reason: "this engine has no mid-turn input channel" };

const CAPABILITIES: Readonly<Record<AgentKind, AgentCapabilities>> = {
  hermes: {
    events: true,
    steer: STEER_NEXT_BOUNDARY,
    interrupt: true,
    resume: true,
    cancel: true,
    approval: true,
    questions: true,
    nativeTui: true,
    modelCatalog: true,
    subagents: true,
    images: false,
    usage: true,
    fileChanges: true,
  },
  claudeCode: {
    events: true,
    steer: STEER_NATIVE,
    interrupt: true,
    resume: true,
    cancel: true,
    approval: true,
    questions: true,
    nativeTui: true,
    modelCatalog: true,
    subagents: true,
    images: true,
    usage: true,
    fileChanges: true,
  },
  codex: {
    events: true,
    steer: STEER_NATIVE,
    interrupt: true,
    resume: true,
    cancel: true,
    approval: true,
    questions: true,
    nativeTui: true,
    modelCatalog: true,
    subagents: false,
    images: true,
    usage: true,
    fileChanges: true,
  },
  openCode: {
    events: true,
    steer: STEER_NATIVE,
    interrupt: true,
    resume: true,
    cancel: true,
    approval: true,
    questions: true,
    nativeTui: true,
    modelCatalog: true,
    subagents: false,
    images: false,
    usage: true,
    fileChanges: true,
  },
  pi: {
    events: true,
    steer: STEER_NATIVE,
    interrupt: true,
    resume: true,
    cancel: true,
    approval: true,
    questions: true,
    nativeTui: true,
    modelCatalog: false,
    subagents: false,
    images: true,
    usage: true,
    fileChanges: false,
  },
  ohMyPi: {
    events: true,
    steer: STEER_NATIVE,
    interrupt: true,
    resume: true,
    cancel: true,
    approval: true,
    questions: true,
    nativeTui: true,
    modelCatalog: false,
    subagents: false,
    images: true,
    usage: true,
    fileChanges: false,
  },
  custom: {
    events: true,
    steer: STEER_NONE,
    interrupt: true,
    resume: true,
    cancel: true,
    approval: true,
    questions: true,
    nativeTui: false,
    modelCatalog: false,
    subagents: false,
    images: false,
    usage: false,
    fileChanges: false,
  },
};

export function capabilitiesFor(agent: AgentKind): AgentCapabilities {
  return CAPABILITIES[agent];
}

export function supports(agent: AgentKind, capability: keyof AgentCapabilities): boolean {
  const value = CAPABILITIES[agent][capability];
  return typeof value === "boolean" ? value : value.kind !== "none";
}
