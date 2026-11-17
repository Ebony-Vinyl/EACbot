/** pi and omp speak the same JSONL RPC dialect with three differences that matter:
 *
 * - omp chunks a frame over 1 MiB into `rpc_chunk` pieces, but only after the client negotiates
 *   protocol v2. Vanilla pi refuses `negotiate_protocol` and never chunks.
 * - omp's `agent_end` can carry `isTerminal: false` while maintenance or an async delivery is
 *   scheduled; upstream pi's `agent_end` can carry `willRetry: true` before an automatic retry.
 * - pi's `agent_settled` is its explicit "no retry or queued continuation remains" guarantee.
 *
 * Everything else — prompt/steer/abort/switch_session/set_model/get_state — is the same frame
 * shape, so both adapters share this codec and differ only in their descriptor. */

export interface RpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: unknown;
}

export function isResponse(frame: Record<string, unknown>): frame is Record<string, unknown> & RpcResponse {
  return frame.type === "response";
}

export type AssistantMessageEvent = { type?: string; delta?: string };

export function assistantDelta(frame: Record<string, unknown>): { kind: "text" | "reasoning"; text: string } | null {
  const event = frame.assistantMessageEvent as AssistantMessageEvent | undefined;
  if (!event || typeof event.delta !== "string" || event.delta === "") return null;
  if (event.type === "text_delta") return { kind: "text", text: event.delta };
  if (event.type === "thinking_delta") return { kind: "reasoning", text: event.delta };
  return null;
}

/** pi's stop reasons that mean "the engine continues by itself"; they are not turn endings. */
const CONTINUING_STOP_REASONS = new Set(["toolUse", "tool_use", "tool_calls"]);

export function stopReasonContinues(reason: unknown): boolean {
  return typeof reason === "string" && CONTINUING_STOP_REASONS.has(reason);
}

export interface TurnTrackerOptions {
  /** How long to wait for `agent_end` after a `turn_end` that looks final. */
  agentEndGraceMs: number;
  /** The engine sends `agent_settled` after everything is quiescent. */
  settleOnAgentSettled: boolean;
}

/** Decides when one turn is over. It is deliberately conservative: a frame that might still be
 * followed by work never settles the turn. */
export class TurnTracker {
  private settled = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopReason: string | undefined;
  private readonly options: TurnTrackerOptions;
  private readonly onFinish: (outcome: { ok: boolean; stopReason: string }) => void;

  constructor(options: TurnTrackerOptions, onFinish: (outcome: { ok: boolean; stopReason: string }) => void) {
    this.options = options;
    this.onFinish = onFinish;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  turnEnd(frame: Record<string, unknown>): void {
    if (this.settled) return;
    this.clearGrace();
    const message = frame.message as { stopReason?: unknown } | undefined;
    const reason = typeof message?.stopReason === "string" ? message.stopReason : undefined;
    // pi auto-continues after a tool call; the next turn_end carries the real outcome.
    if (stopReasonContinues(reason)) return;
    this.stopReason = reason;
    // pi may schedule maintenance (overflow-recovery compaction) after the final turn_end, so a
    // grace window waits for agent_end rather than trusting turn_end alone.
    this.graceTimer = setTimeout(() => this.finish(), this.options.agentEndGraceMs);
    this.graceTimer.unref?.();
  }

  agentEnd(frame: Record<string, unknown>): void {
    if (this.settled) return;
    this.clearGrace();
    // Non-terminal agent_end: omp sets isTerminal false while maintenance runs; pi sets
    // willRetry true before an automatic retry. Neither ends the turn.
    if (frame.isTerminal === false || frame.willRetry === true) return;
    this.finish();
  }

  agentSettled(): void {
    if (this.settled) return;
    if (!this.options.settleOnAgentSettled) return;
    this.clearGrace();
    this.finish();
  }

  /** Anything that proves the engine is still working cancels a pending grace finish. */
  stillWorking(): void {
    this.clearGrace();
  }

  forceSettle(stopReason: string): void {
    if (this.settled) return;
    this.clearGrace();
    this.finish(stopReason);
  }

  private finish(forced?: string): void {
    if (this.settled) return;
    this.settled = true;
    const reason = forced ?? this.stopReason ?? "end_turn";
    // An interrupted turn is a clean stop, not a failure: the session is still resumable.
    if (reason === "cancelled" || reason === "aborted" || reason === "interrupted") {
      this.onFinish({ ok: true, stopReason: "cancelled" });
      return;
    }
    const ok = reason !== "error" && reason !== "failed";
    this.onFinish({ ok, stopReason: ok ? reason : "failed" });
  }

  private clearGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }
}

/** A model frame's `provider/id` pair, the id pi and omp use in set_model and the catalog. */
export function modelPair(model: { providerId: string; modelId: string }): { provider: string; modelId: string } {
  return { provider: model.providerId, modelId: model.modelId };
}

export function parseModelId(id: string): { providerId: string; modelId: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  return { providerId: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

export interface ExtensionUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | string;
  title?: string;
  options?: string[];
}

export function extensionRequest(frame: Record<string, unknown>): ExtensionUiRequest | null {
  if (frame.type !== "extension_ui_request") return null;
  const method = typeof frame.method === "string" ? frame.method : "";
  // pi floods setWidget/setStatus; only these three wait for an answer.
  if (method !== "select" && method !== "confirm" && method !== "input") return null;
  const id = typeof frame.id === "string" ? frame.id : "";
  if (!id) return null;
  const options = Array.isArray(frame.options)
    ? frame.options.filter((option): option is string => typeof option === "string")
    : undefined;
  return {
    id,
    method,
    ...(typeof frame.title === "string" ? { title: frame.title } : {}),
    ...(options ? { options } : {}),
  };
}
