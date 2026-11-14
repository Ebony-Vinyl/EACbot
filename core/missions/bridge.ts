import type {
  AgentAdapter as CoreAgentAdapter,
  AgentEvent as CoreAgentEvent,
  AgentSession,
  SessionCreateInput,
  SteerOutcome,
} from "../agents/contracts.ts";
import type { AgentAdapter as ProtocolAdapter, AdapterHandle, AdapterStartRequest, AdapterSink } from "../../packages/agent-protocol/adapter.ts";
import type { AgentDescriptor, AgentKind, ModelRef } from "../../packages/agent-protocol/agents.ts";
import type { AdapterEvent } from "../../packages/agent-protocol/events.ts";
import { capabilitiesFor } from "./capabilities.ts";

/** Compile-time proof that this bridge still speaks core/agents' contract. A
 * change to the adapter interface, a session method or a create input field
 * fails `tsc` here instead of drifting silently at runtime. */
export type BridgeTracksCoreContract = [
  CoreAgentAdapter["agentId"] extends AgentKind ? true : never,
  AgentKind extends CoreAgentAdapter["agentId"] ? true : never,
  CoreAgentAdapter["create"] extends (input: SessionCreateInput) => Promise<AgentSession> ? true : never,
  AgentSession["events"] extends () => AsyncIterable<CoreAgentEvent> ? true : never,
  AgentSession["steer"] extends (text: string) => Promise<SteerOutcome> ? true : never,
  AgentSession["nativeSessionId"] extends string | null ? true : never,
];

/** One event variant without the envelope the bridge stamps itself. Distributing
 * over the union keeps each variant's own fields required. */
type EventBody = AdapterEvent extends infer Variant
  ? Variant extends AdapterEvent
    ? Omit<Variant, "eventId" | "seq" | "missionId" | "runId" | "source">
    : never
  : never;

/** core/agents names its agents exactly as the protocol's `AgentKind` does, so
 * the mapping is identity. Kept as a function so a future divergence has one
 * place to live. */
export function coreAgentId(kind: AgentKind): CoreAgentAdapter["agentId"] {
  return kind;
}

export function agentKindOf(coreId: CoreAgentAdapter["agentId"]): AgentKind {
  return coreId;
}

/** The protocol's `ModelRef` to the engine's provider/model pair. The protocol
 * treats `model` as the adapter's own identifier; core/agents splits it into a
 * provider and a model, so `provider/model` is the wire form and a bare id
 * keeps the agent kind as its provider. */
export function toCoreModel(ref: ModelRef | undefined): SessionCreateInput["model"] {
  if (!ref) return undefined;
  const slash = ref.model.indexOf("/");
  const providerId = slash > 0 ? ref.model.slice(0, slash) : ref.agent;
  const modelId = slash > 0 ? ref.model.slice(slash + 1) : ref.model;
  return { providerId, modelId, ...(ref.variant !== undefined ? { variant: ref.variant } : {}) };
}

export function fromCoreModel(
  model: { providerId: string; modelId: string; variant?: string } | null,
  agent: AgentKind,
): ModelRef | undefined {
  if (!model) return undefined;
  return {
    agent,
    model: `${model.providerId}/${model.modelId}`,
    ...(model.variant !== undefined ? { variant: model.variant } : {}),
  };
}

/** The caller's run id is the core session id: one run is one native session,
 * and every core event already carries it back. */
export interface BridgeOptions {
  readonly adapter: CoreAgentAdapter;
  readonly kind: AgentKind;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly system?: string;
  /** Called for every session the bridge opens, so the runtime can reach the
   * native control methods after `start` returned. */
  readonly onSession?: (runId: string, session: AgentSession) => void;
}

interface LiveSession {
  readonly session: AgentSession;
  readonly pump: AbortController;
}

/** Adapts one core/agents adapter to the protocol's start/steer/interrupt/
 * resume/cancel surface. It imports core/agents types only and never modifies
 * that slice. */
export class CoreAgentBridge implements ProtocolAdapter {
  readonly kind: AgentKind;
  private readonly options: BridgeOptions;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly seq = new Map<string, number>();

  constructor(options: BridgeOptions) {
    this.options = options;
    this.kind = options.kind;
  }

  describe(): AgentDescriptor {
    const capabilities = this.options.adapter.capabilities;
    const protocolCapabilities = capabilitiesFor(this.kind);
    return {
      kind: this.kind,
      label: this.kind,
      authModes: ["subscription", "apiKey", "compatibleEndpoint", "local"],
      capabilities: {
        ...protocolCapabilities,
        events: true,
        steer: capabilities.steer,
        interrupt: capabilities.interrupt,
        resume: capabilities.resume,
        cancel: capabilities.cancel,
        approval: capabilities.approvals,
        questions: capabilities.questions,
        nativeTui: capabilities.nativeTui,
        images: capabilities.images,
        usage: capabilities.usage,
      },
      models: [],
    };
  }

  async start(request: AdapterStartRequest, sink: AdapterSink): Promise<AdapterHandle> {
    return this.open(request, sink, {});
  }

  async resume(request: AdapterStartRequest, sink: AdapterSink): Promise<AdapterHandle> {
    const cursor = request.resumeFromSessionId;
    if (!cursor) throw new Error(`resume of ${request.runId} has no native session to reattach`);
    return this.open(request, sink, { resumeCursor: cursor });
  }

  async steer(runId: string, input: string, commandId: string): Promise<{ accepted: boolean; reason?: string }> {
    const live = this.sessions.get(runId);
    if (!live) return { accepted: false, reason: `no live session for ${runId}` };
    const outcome: SteerOutcome = await live.session.steer(input);
    return steerResult(outcome, commandId);
  }

  async interrupt(runId: string, _reason?: string): Promise<{ resumable: boolean }> {
    const live = this.sessions.get(runId);
    if (!live) return { resumable: false };
    await live.session.interrupt();
    return { resumable: this.options.adapter.capabilities.resume };
  }

  async cancel(runId: string, _reason?: string): Promise<void> {
    const live = this.sessions.get(runId);
    if (!live) return;
    try {
      await live.session.cancel();
    } finally {
      await this.closeSession(runId);
    }
  }

  async dispose(): Promise<void> {
    for (const runId of this.sessions.keys()) await this.closeSession(runId);
  }

  sessionOf(runId: string): AgentSession | undefined {
    return this.sessions.get(runId)?.session;
  }

  private async open(
    request: AdapterStartRequest,
    sink: AdapterSink,
    extra: Pick<SessionCreateInput, "resumeCursor">,
  ): Promise<AdapterHandle> {
    const model = toCoreModel(request.model);
    const session = await this.options.adapter.create({
      sessionId: request.runId,
      prompt: request.prompt,
      ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
      ...(this.options.env !== undefined ? { env: this.options.env } : {}),
      ...(this.options.system !== undefined ? { system: this.options.system } : {}),
      ...(model !== undefined ? { model } : {}),
      ...extra,
    });
    const pump = new AbortController();
    this.sessions.set(request.runId, { session, pump });
    this.options.onSession?.(request.runId, session);
    void this.pump(request, session, sink, pump.signal);
    return { runId: request.runId, ...(session.nativeSessionId !== null ? { nativeSessionId: session.nativeSessionId } : {}) };
  }

  /** Drains the session's async event iterator into protocol events. A failure
   * of the iterator is a typed run failure, never a silent stop. */
  private async pump(request: AdapterStartRequest, session: AgentSession, sink: AdapterSink, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of session.events()) {
        if (signal.aborted) break;
        for (const mapped of this.map(event, request)) sink.emit(mapped);
      }
    } catch (error) {
      if (signal.aborted) return;
      sink.emit(this.next(request, {
        type: "run.failed",
        at: new Date().toISOString(),
        code: "event_stream_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /** One core event may need more than one protocol event, so the mapping
   * returns a list. `turn.completed` ends the run; `session.exited` alone does
   * not, because an interrupted session exits resumably. */
  private map(event: CoreAgentEvent, request: AdapterStartRequest): AdapterEvent[] {
    const at = event.at;
    switch (event.type) {
      case "session.started":
        return [
          this.next(request, {
            type: "run.started",
            at,
            ...(event.nativeSessionId !== null ? { nativeSessionId: event.nativeSessionId } : {}),
            ...(event.rebuilt === true ? { rebuilt: true } : {}),
          }),
        ];
      case "session.resumed":
        return [
          this.next(request, {
            type: "run.resumed",
            at,
            ...(event.nativeSessionId !== null ? { nativeSessionId: event.nativeSessionId } : {}),
            fromRunId: request.resumeOfRunId ?? request.runId,
          }),
        ];
      case "session.exited":
      case "turn.started":
        return [];
      case "text.delta":
      case "reasoning.delta":
        return [this.next(request, { type: "run.output", at, text: event.text, stream: "assistant" })];
      case "tool.started":
        return [this.next(request, { type: "run.tool_call", at, callId: event.itemId, tool: event.title, input: event.summary ?? null })];
      case "tool.output":
        return [this.next(request, { type: "run.output", at, text: event.text, stream: "stdout" })];
      case "tool.completed":
        return [
          this.next(request, {
            type: "run.tool_result",
            at,
            callId: event.itemId,
            tool: event.itemId,
            ok: event.ok,
            ...(event.output !== undefined ? { output: event.output } : {}),
          }),
        ];
      case "approval.requested":
        return [
          this.next(request, {
            type: "run.approval_requested",
            at,
            approvalId: event.requestId,
            action: event.title,
            detail: event.detail ?? "",
          }),
        ];
      case "question.requested":
        return [
          this.next(request, {
            type: "run.approval_requested",
            at,
            approvalId: event.requestId,
            action: event.title,
            detail: event.questions.map((question) => question.question).join("\n"),
          }),
        ];
      case "approval.resolved":
        return [
          this.next(request, {
            type: "run.approval_resolved",
            at,
            approvalId: event.requestId,
            decision: event.behavior === "allow" ? "allow" : event.behavior === "deny" ? "deny" : "expired",
          }),
        ];
      case "usage.updated":
        return [
          this.next(request, {
            type: "run.usage",
            at,
            inputTokens: event.input,
            outputTokens: event.output,
          }),
        ];
      case "turn.completed":
        return event.ok
          ? [this.next(request, { type: "run.completed", at, outcome: "succeeded" })]
          : [this.next(request, { type: "run.failed", at, code: event.stopReason, message: event.stopReason })];
      case "notice":
        return [this.next(request, { type: "run.output", at, text: event.message, stream: "stdout" })];
      case "error":
        return [
          this.next(request, {
            type: "run.failed",
            at,
            code: event.setup === true ? "setup_failed" : "agent_error",
            message: event.message,
          }),
        ];
    }
  }

  private next(request: AdapterStartRequest, body: EventBody): AdapterEvent {
    const seq = (this.seq.get(request.runId) ?? 0) + 1;
    this.seq.set(request.runId, seq);
    return {
      source: "adapter",
      eventId: `${request.runId}-${seq}`,
      seq,
      missionId: request.missionId,
      runId: request.runId,
      ...body,
    } as AdapterEvent;
  }

  private async closeSession(runId: string): Promise<void> {
    const live = this.sessions.get(runId);
    if (!live) return;
    this.sessions.delete(runId);
    live.pump.abort();
    try {
      await live.session.close();
    } catch {
      // A session that failed to close has already lost its native process;
      // the durable record is what a caller reads.
    }
  }
}

function steerResult(outcome: SteerOutcome, commandId: string): { accepted: boolean; reason?: string } {
  switch (outcome) {
    case "steered":
      return { accepted: true };
    case "refused":
      return { accepted: false, reason: `steer ${commandId} was refused` };
    case "indeterminate":
      return { accepted: false, reason: `steer ${commandId} delivery is indeterminate` };
  }
}
