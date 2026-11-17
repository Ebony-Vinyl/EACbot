/** Agent identities, capabilities, sign-in modes and model references.
 * Adapters report capabilities; the mission authority refuses a command an
 * adapter cannot honour instead of pretending it ran. */

export const AGENT_KINDS = ["hermes", "claudeCode", "codex", "openCode", "pi", "ohMyPi", "custom"] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

export const AUTH_MODES = ["subscription", "apiKey", "compatibleEndpoint", "local"] as const;

/** How an environment authenticates an agent. The credential itself never
 * appears in a wire type; `compatibleEndpoint` names a base URL only. */
export type AuthMode = (typeof AUTH_MODES)[number];

/** How an engine takes a message into a turn already running. `native` folds it
 * into the live turn; `next-boundary` only promises delivery at the engine's
 * next step; `none` is an engine with no mid-turn channel at all. */
export type SteerCapability =
  | { readonly kind: "native" }
  | { readonly kind: "next-boundary"; readonly note: string }
  | { readonly kind: "none"; readonly reason: string };

/** What an adapter can do through structured events. A missing capability is
 * an explicit refusal, not a best-effort fallback. */
export interface AgentCapabilities {
  readonly events: boolean;
  readonly steer: SteerCapability;
  readonly interrupt: boolean;
  readonly resume: boolean;
  readonly cancel: boolean;
  readonly approval: boolean;
  readonly questions: boolean;
  readonly nativeTui: boolean;
  readonly modelCatalog: boolean;
  readonly subagents: boolean;
  readonly images: boolean;
  readonly usage: boolean;
  readonly fileChanges: boolean;
}

export type CapabilityName = keyof AgentCapabilities;

export const CAPABILITY_NAMES = [
  "events",
  "steer",
  "interrupt",
  "resume",
  "cancel",
  "approval",
  "questions",
  "nativeTui",
  "modelCatalog",
  "subagents",
  "images",
  "usage",
  "fileChanges",
] as const satisfies readonly CapabilityName[];

/** `true` when the engine can take mid-turn input at all, whatever its mode. */
export function canSteer(capabilities: AgentCapabilities): boolean {
  return capabilities.steer.kind !== "none";
}

/** A concrete model an agent can run. `model` is the adapter's own identifier,
 * never a display label the mission authority would have to interpret. */
export interface ModelRef {
  readonly agent: AgentKind;
  readonly model: string;
  readonly effort?: string;
  readonly variant?: string;
  readonly label?: string;
}

export interface ModelCatalogEntry {
  readonly ref: ModelRef;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly supportsImages?: boolean;
  readonly defaultEffort?: string;
  readonly efforts?: readonly string[];
}

export interface ModelCatalog {
  readonly agent: AgentKind;
  readonly models: readonly ModelCatalogEntry[];
  readonly defaultModel?: ModelRef;
  readonly fetchedAt: string;
}

/** What a client needs to offer an agent: no secrets, no transport details. */
export interface AgentDescriptor {
  readonly kind: AgentKind;
  readonly label: string;
  readonly authModes: readonly AuthMode[];
  readonly capabilities: AgentCapabilities;
  readonly models: readonly ModelCatalogEntry[];
}
