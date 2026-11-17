/** OpenCode's V2 HTTP API, from the official spec at https://opencode.ai/docs/openapi.json
 * (OpenAPI 3.1.0, read 2026-11-15). Only paths and field names that spec states are used.
 *
 * Two facts drive this file's shape:
 * - The event stream is the global `GET /api/event`; there is no per-session event route, so the
 *   adapter subscribes globally and filters on the event's own `data.sessionID`.
 * - Prompt bodies are flat (`{ text, delivery, … }`), and `delivery` is `steer` or `queue`. */

export const OPENCODE_API_PREFIX = "/api";

export function sessionPath(base: string, sessionId: string): string {
  return `${base}${OPENCODE_API_PREFIX}/session/${encodeURIComponent(sessionId)}`;
}

/** `POST /api/session`: `{ id?, parentID?, title?, agent?, model? }`. A caller may supply its own
 * id; the response's `data.id` is authoritative either way. */
export function createSessionRequest(
  base: string,
  model?: { providerId: string; modelId: string; variant?: string },
): { url: string; body: Record<string, unknown> } {
  return {
    url: `${base}${OPENCODE_API_PREFIX}/session`,
    body: model
      ? { model: { providerID: model.providerId, id: model.modelId, ...(model.variant ? { variant: model.variant } : {}) } }
      : {},
  };
}

/** `POST /api/session/{id}/prompt`: `{ text, delivery?, resume?, id?, files?, … }`. `delivery`
 * `steer` wakes a running execution; `queue` parks the text for the next one. */
export function promptRequest(
  base: string,
  sessionId: string,
  input: { text: string; delivery?: "steer" | "queue"; resume?: boolean },
): { url: string; body: Record<string, unknown> } {
  return {
    url: `${sessionPath(base, sessionId)}/prompt`,
    body: {
      text: input.text,
      ...(input.delivery ? { delivery: input.delivery } : {}),
      ...(input.resume === undefined ? {} : { resume: input.resume }),
    },
  };
}

/** `POST /api/session/{id}/interrupt?resume=true|false`. `resume=true` resumes pending steering
 * input and next-in-line control items; queued prompts stay parked. */
export function interruptUrl(base: string, sessionId: string, resume: boolean): string {
  return `${sessionPath(base, sessionId)}/interrupt?resume=${resume ? "true" : "false"}`;
}

/** The one event stream the server offers. */
export function eventsUrl(base: string): string {
  return `${base}${OPENCODE_API_PREFIX}/event`;
}

/** `PATCH /api/session/{id}/inbox/{inboxID}`: `{ delivery }`. Changing a pending item's delivery
 * mode; steering wakes execution. */
export function inboxDeliveryRequest(
  base: string,
  sessionId: string,
  inboxId: string,
  delivery: "steer" | "queue",
): { url: string; body: { delivery: "steer" | "queue" } } {
  return {
    url: `${sessionPath(base, sessionId)}/inbox/${encodeURIComponent(inboxId)}`,
    body: { delivery },
  };
}

/** `POST /api/session/{id}/permission/{requestID}/reply`: `{ decision, message? }`. */
export function permissionReplyUrl(base: string, sessionId: string, requestId: string): string {
  return `${sessionPath(base, sessionId)}/permission/${encodeURIComponent(requestId)}/reply`;
}

/** The engine's own reply vocabulary: `once`, `always` and `reject`. */
export function permissionReply(behavior: "allow" | "deny", always: boolean | undefined): "once" | "always" | "reject" {
  if (behavior === "deny") return "reject";
  return always ? "always" : "once";
}

/** `POST /api/session/{id}/model`: `{ model: { providerID, id, variant? } }`. */
export function switchModelRequest(
  base: string,
  sessionId: string,
  model: { providerId: string; modelId: string; variant?: string },
): { url: string; body: Record<string, unknown> } {
  return {
    url: `${sessionPath(base, sessionId)}/model`,
    body: { model: { providerID: model.providerId, id: model.modelId, ...(model.variant ? { variant: model.variant } : {}) } },
  };
}

/** `GET /api/model`: `{ location, data: Model.Info[] }`. */
export function modelsUrl(base: string): string {
  return `${base}${OPENCODE_API_PREFIX}/model`;
}

export function defaultModelUrl(base: string): string {
  return `${base}${OPENCODE_API_PREFIX}/model/default`;
}

/** Event types the adapter maps. Names are the spec's own (`session.text.delta`, not the SDK
 * build's `session.next.*`). An unlisted type is ignored rather than guessed at. */
export const OPENCODE_EVENT_TYPES = {
  textDelta: "session.text.delta",
  reasoningDelta: "session.reasoning.delta",
  toolCalled: "session.tool.called",
  toolSuccess: "session.tool.success",
  toolFailed: "session.tool.failed",
  stepEnded: "session.step.ended",
  stepFailed: "session.step.failed",
  executionSucceeded: "session.execution.succeeded",
  executionFailed: "session.execution.failed",
  executionInterrupted: "session.execution.interrupted",
  usageUpdated: "session.usage.updated",
  idle: "session.idle",
  permissionAsked: "permission.asked",
} as const;

/** The SSE frame is `{ id?, event, data }`; the payload's own `type` matches `event`. */
export interface OpenCodeEvent {
  type: string;
  data: Record<string, unknown>;
}

export function openCodeEvent(frame: Record<string, unknown>, sseEvent?: string): OpenCodeEvent | null {
  const payload = frame.data;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = payload as Record<string, unknown>;
  const type = typeof data.type === "string" ? data.type : (sseEvent ?? "");
  if (!type) return null;
  return { type, data };
}

export function eventSessionId(event: OpenCodeEvent): string | null {
  const value = event.data.sessionID;
  return typeof value === "string" && value ? value : null;
}

/** `Model.Info`, narrowed to what a picker needs. `limit.context` and `limit.output` are required
 * by the spec, so a missing limit means the payload is not a model row. */
export interface OpenCodeModel {
  ref: { providerId: string; modelId: string };
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  enabled: boolean;
  /** `capabilities.input` is a list of media kinds; `"image"` is how the engine names pictures. */
  acceptsImages: boolean;
  variants: string[];
}

export function readModels(body: unknown): OpenCodeModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const models: OpenCodeModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const providerId = typeof row.providerID === "string" ? row.providerID : "";
    const modelId = typeof row.modelID === "string" ? row.modelID : "";
    if (!providerId || !modelId) continue;
    const limit = row.limit as { context?: unknown; output?: unknown } | undefined;
    const capabilities = row.capabilities as { input?: unknown } | undefined;
    const input = Array.isArray(capabilities?.input)
      ? capabilities.input.filter((kind): kind is string => typeof kind === "string")
      : [];
    const variants = Array.isArray(row.variants)
      ? row.variants
          .map((variant) => (variant as { id?: unknown } | null)?.id)
          .filter((id): id is string => typeof id === "string" && Boolean(id))
      : [];
    models.push({
      ref: { providerId, modelId },
      label: typeof row.name === "string" && row.name ? row.name : modelId,
      ...(typeof limit?.context === "number" ? { contextWindow: limit.context } : {}),
      ...(typeof limit?.output === "number" ? { maxOutputTokens: limit.output } : {}),
      enabled: row.enabled !== false,
      acceptsImages: input.includes("image"),
      variants,
    });
  }
  return models;
}

/** `TokenUsage.Info`: `input` excludes cached prompt tokens, `cache.read` is the cached part. */
export function readUsage(tokens: unknown): { input: number; output: number; cachedInput?: number } | null {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const row = tokens as { input?: unknown; output?: unknown; cache?: { read?: unknown } };
  const input = typeof row.input === "number" ? row.input : 0;
  const output = typeof row.output === "number" ? row.output : 0;
  const cached = typeof row.cache?.read === "number" ? row.cache.read : undefined;
  return { input: input + (cached ?? 0), output, ...(cached === undefined ? {} : { cachedInput: cached }) };
}
