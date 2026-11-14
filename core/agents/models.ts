import type { AgentId, ModelRef } from "./contracts.ts";

/** A provider's own identity, kept apart from the billing that serves it. Two instances may name
 * the same provider and model while one bills a subscription and the other an API key; nothing
 * here merges them. */
export interface ProviderConfig {
  providerId: string;
  /** Display name the picker shows. */
  label?: string;
  /** The endpoint this provider answers on, for `compatibleEndpoint` and `local` instances. */
  baseUrl?: string;
}

export interface ModelConfig {
  /** A provider this instance may use. The engine's own catalog adds to this list, never replaces
   * it, so a model the engine stops offering is reported rather than silently swapped. */
  providers: readonly ProviderConfig[];
  /** The model a session starts on, when the caller has not picked one. */
  defaultModel?: ModelRef;
}

/** What a model entry means for billing. A subscription's own catalog is not a purchase; an API
 * key or endpoint is metered by whoever issued the key. */
export type ModelBilling = "subscription" | "api-key" | "local";

export interface ModelOption {
  ref: ModelRef;
  label: string;
  billing: ModelBilling;
  /** The provider row this option came from, so two options with one model id stay distinct. */
  providerId: string;
}

/** Model ids are `provider/model`; a model id may itself contain slashes, so only the first
 * separates the two. */
export function modelIdString(ref: ModelRef): string {
  return `${ref.providerId}/${ref.modelId}`;
}

export function parseModelIdString(id: string): ModelRef | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  return { providerId: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

/** A model the caller asked for that this instance cannot offer. Reported, never replaced: the
 * turn does not silently run on a different model than the one the person chose. */
export class UnknownModelError extends Error {
  readonly agentId: string;
  readonly modelId: string;

  constructor(agentId: string, modelId: string) {
    super(`${agentId} has no model "${modelId}" in this instance's catalog`);
    this.name = "UnknownModelError";
    this.agentId = agentId;
    this.modelId = modelId;
  }
}

export function requireModel(agentId: AgentId, catalog: readonly ModelOption[], id: string): ModelOption {
  const found = catalog.find((option) => modelIdString(option.ref) === id);
  if (!found) throw new UnknownModelError(agentId, id);
  return found;
}

/** The catalog's default: the configured one when the engine still offers it, else the first
 * option, else null. Never a model the engine did not report. */
export function defaultOption(catalog: readonly ModelOption[], preferred?: ModelRef): ModelOption | null {
  if (preferred) {
    const wanted = modelIdString(preferred);
    const found = catalog.find((option) => modelIdString(option.ref) === wanted);
    if (found) return found;
  }
  return catalog[0] ?? null;
}
