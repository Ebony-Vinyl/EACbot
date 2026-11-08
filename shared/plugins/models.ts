import { z } from "zod";

export const MODEL_MODALITIES = ["text", "vision", "tools", "streaming", "audio-in", "audio-out", "video-in"] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

/**
 * `verified`: the host sent a real request of this kind and it worked. `unverified`: the provider claims it, or it was
 * never exercised. `unavailable`: do not offer it. A model listing alone never promotes a modality to verified.
 */
export const MODALITY_STATES = ["verified", "unverified", "unavailable"] as const;
export type ModalityState = (typeof MODALITY_STATES)[number];

export const COST_STATES = ["actual", "estimated", "free", "unknown"] as const;
export type CostState = (typeof COST_STATES)[number];

export const modelPricingSchema = z.object({
  currency: z.enum(["USD", "CNY"]),
  state: z.enum(COST_STATES),
  inputPerMillion: z.number().finite().min(0).optional(),
  outputPerMillion: z.number().finite().min(0).optional(),
  note: z.string().trim().max(200).optional(),
}).strict().superRefine((pricing, context) => {
  if (pricing.state === "actual" && pricing.inputPerMillion === undefined && pricing.outputPerMillion === undefined) {
    context.addIssue({ code: "custom", message: "actual pricing needs at least one per-million rate" });
  }
});

export type ModelPricing = z.infer<typeof modelPricingSchema>;

export const modelDescriptorSchema = z.object({
  /** Stable host key: `<provider>/<model>`. */
  key: z.string().min(1).max(240).regex(/^[a-z0-9][a-z0-9._-]*\/[^/\s]{1,200}$/),
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(120),
  modalities: z.partialRecord(z.enum(MODEL_MODALITIES), z.enum(MODALITY_STATES)),
  pricing: modelPricingSchema.optional(),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
  /** True only when the provider is the host's own free endpoint; a free-looking price is not proof. */
  free: z.boolean().optional(),
}).strict();

export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;

export type ModalityCheck =
  | { ok: true; state: "verified" | "unverified" }
  | { ok: false; code: "MODALITY_UNAVAILABLE" | "MODALITY_UNVERIFIED"; error: string };

/** Ask for a modality explicitly; an unverified capability is not silently treated as working. */
export function requireModality(descriptor: ModelDescriptor, modality: ModelModality, options: { allowUnverified?: boolean } = {}): ModalityCheck {
  const state = descriptor.modalities[modality] ?? "unavailable";
  if (state === "unavailable") return { ok: false, code: "MODALITY_UNAVAILABLE", error: `${descriptor.title} does not support ${modality}` };
  if (state === "unverified" && options.allowUnverified !== true) {
    return { ok: false, code: "MODALITY_UNVERIFIED", error: `${descriptor.title} has not verified ${modality}` };
  }
  return { ok: true, state };
}

const MODALITY_RANK: Readonly<Record<ModalityState, number>> = { unavailable: 0, unverified: 1, verified: 2 };

/** A refresh replaces the previous catalog: a model the provider no longer lists is no longer offered. */
export function mergeModels(previous: readonly ModelDescriptor[], incoming: readonly ModelDescriptor[]): ModelDescriptor[] {
  const byKey = new Map(previous.map((model) => [model.key, model]));
  const out: ModelDescriptor[] = [];
  for (const model of incoming) {
    const old = byKey.get(model.key);
    if (!old) {
      out.push(model);
      continue;
    }
    const modalities = { ...model.modalities };
    // A listing refresh may lower a claim but never raise one: only a recorded probe result may do that.
    for (const modality of MODEL_MODALITIES) {
      const before = old.modalities[modality];
      const after = modalities[modality];
      if (before && after && MODALITY_RANK[after] > MODALITY_RANK[before]) modalities[modality] = before;
      if (!after && before) modalities[modality] = before;
    }
    out.push({ ...model, modalities });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function supportsAnyText(descriptor: ModelDescriptor): boolean {
  return descriptor.modalities.text === "verified" || descriptor.modalities.text === "unverified";
}
