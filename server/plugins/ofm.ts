import { z } from "zod";

import { modelDescriptorSchema, type ModelDescriptor } from "../../shared/plugins/models.ts";

const opaqueKeyRef = z.string().max(120).regex(/^[a-z0-9][a-z0-9._-]{1,119}$/, "must be an opaque secret-store key");

export const ofmEndpointSchema = z.object({
  endpointId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  baseUrl: z.string().url().max(1_000),
  api: z.literal("openai-compatible"),
  apiKeyRef: opaqueKeyRef.optional(),
  /** Provider-declared modalities. A declaration is `unverified` until a real request succeeds. */
  declares: z.record(
    z.string().trim().min(1).max(200),
    z.object({
      vision: z.boolean().optional(),
      tools: z.boolean().optional(),
      streaming: z.boolean().optional(),
      audioIn: z.boolean().optional(),
      audioOut: z.boolean().optional(),
      videoIn: z.boolean().optional(),
    }).strict(),
  ).optional(),
  free: z.boolean().optional(),
}).strict();

export type OfmEndpoint = z.infer<typeof ofmEndpointSchema>;

export class OfmConfigError extends Error {
  readonly code: "invalid-url" | "credentials-in-url" | "not-https" | "invalid";
  constructor(code: OfmConfigError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function loopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** The base URL is a server address, never a place to smuggle a key: credentials must use `apiKeyRef`. */
export function parseOfmEndpoint(input: unknown): OfmEndpoint {
  const parsed = ofmEndpointSchema.safeParse(input);
  if (!parsed.success) throw new OfmConfigError("invalid", parsed.error.issues[0]?.message ?? "invalid OFM endpoint");
  const url = new URL(parsed.data.baseUrl);
  if (url.username || url.password) throw new OfmConfigError("credentials-in-url", "the OFM URL must not contain credentials");
  if (url.hash) throw new OfmConfigError("invalid-url", "the OFM URL must not contain a fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost(url.hostname))) {
    throw new OfmConfigError("not-https", "OFM endpoints must use https, or http on loopback for a local server");
  }
  if (url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return { ...parsed.data, baseUrl: url.toString().replace(/\/$/, "") };
}

interface ModelListing {
  data?: Array<{ id?: unknown; owned_by?: unknown }>;
}

/**
 * An OpenAI-compatible `/models` answer proves only that the id exists. Every modality stays `unverified`; nothing here
 * makes a model safe to offer for image input or audio output.
 */
export function modelsFromOfmListing(endpoint: OfmEndpoint, listing: ModelListing): ModelDescriptor[] {
  const claimed = endpoint.declares ?? {};
  const models: ModelDescriptor[] = [];
  for (const row of listing.data ?? []) {
    if (!row || typeof row.id !== "string" || !row.id.trim() || row.id.length > 200) continue;
    const model = row.id.trim();
    const declaration = claimed[model] ?? {};
    const state = (value: boolean | undefined): "unverified" | "unavailable" | undefined => value === true ? "unverified" : value === false ? "unavailable" : undefined;
    const vision = state(declaration.vision), tools = state(declaration.tools), streaming = state(declaration.streaming);
    const audioIn = state(declaration.audioIn), audioOut = state(declaration.audioOut), videoIn = state(declaration.videoIn);
    models.push(modelDescriptorSchema.parse({
      key: `${endpoint.endpointId}/${model}`,
      provider: endpoint.endpointId,
      model,
      title: model,
      modalities: {
        text: "unverified",
        ...(vision ? { vision } : {}),
        ...(tools ? { tools } : {}),
        ...(streaming ? { streaming } : {}),
        ...(audioIn ? { "audio-in": audioIn } : {}),
        ...(audioOut ? { "audio-out": audioOut } : {}),
        ...(videoIn ? { "video-in": videoIn } : {}),
      },
      pricing: endpoint.free ? { currency: "USD", state: "free" as const } : { currency: "USD", state: "unknown" as const },
      ...(endpoint.free ? { free: true } : {}),
    }));
  }
  return models.sort((a, b) => a.key.localeCompare(b.key));
}

export interface OfmChatRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  stream: boolean;
  tools?: Array<{ name: string; description?: string; parameters: Record<string, unknown> }>;
  maxTokens?: number;
}

/** Build an OpenAI-compatible body without letting a caller quietly turn on a modality the model lacks. */
export function ofmChatBody(model: ModelDescriptor, request: OfmChatRequest): Record<string, unknown> {
  if (model.model !== request.model) throw new OfmConfigError("invalid", "the request model does not match the descriptor");
  if (request.stream && (model.modalities.streaming ?? "unavailable") === "unavailable") {
    throw new OfmConfigError("invalid", "streaming is unavailable for this model");
  }
  if (request.tools?.length && (model.modalities.tools ?? "unavailable") === "unavailable") {
    throw new OfmConfigError("invalid", "tools are unavailable for this model");
  }
  return {
    model: request.model,
    messages: request.messages,
    stream: request.stream,
    ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
  };
}
