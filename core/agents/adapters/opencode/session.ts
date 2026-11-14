import type {
  AgentAdapter, AgentCapabilities, AgentEvent, AgentSession, ApprovalDecision, ApprovalOutcome, NativeTuiDescriptor,
  ResumeInput, ResumeOutcome, SessionCreateInput, SteerOutcome,
} from "../../contracts.ts";
import { AgentHttpError, AgentTransportError } from "../../errors.ts";
import { eventFactory, EventQueue } from "../../events/queue.ts";
import { readSse, sseJson } from "../../transport/sse.ts";
import type { FetchLike } from "../../transport/types.ts";
import { agentDescriptor, type AgentDescriptor } from "../../registry.ts";
import {
  createSessionRequest, eventSessionId, eventsUrl, interruptUrl, openCodeEvent, OPENCODE_EVENT_TYPES,
  permissionReply, permissionReplyUrl, promptRequest, readUsage, type OpenCodeEvent,
} from "./codec.ts";

export interface OpenCodeAdapterOptions {
  /** Base URL of a running OpenCode server, e.g. `http://127.0.0.1:4096`. */
  baseUrl: string;
  fetch: FetchLike;
  /** Bearer the server requires, when it requires one. */
  token?: string;
  /** How long a control call may take before it is abandoned. */
  controlTimeoutMs?: number;
}

/** OpenCode over its V2 HTTP API. The engine owns the session; the caller's id stays this layer's
 * identity for the conversation, and the engine's own id is the resume cursor. */
export class OpenCodeAdapter implements AgentAdapter {
  readonly agentId = "openCode" as const;
  readonly transport = "http" as const;
  readonly capabilities: AgentCapabilities;
  private readonly descriptor: AgentDescriptor;
  private readonly options: OpenCodeAdapterOptions;

  constructor(options: OpenCodeAdapterOptions) {
    this.options = options;
    this.descriptor = agentDescriptor("openCode");
    this.capabilities = this.descriptor.capabilities;
  }

  async create(input: SessionCreateInput): Promise<AgentSession> {
    return new OpenCodeSession(this.descriptor, this.options, input).start();
  }
}

class OpenCodeSession implements AgentSession {
  readonly agentId = "openCode" as const;
  readonly sessionId: string;
  private readonly descriptor: AgentDescriptor;
  private readonly options: OpenCodeAdapterOptions;
  private readonly input: SessionCreateInput;
  private readonly emit = eventFactory();
  private readonly queue = new EventQueue();
  private nativeId: string | null = null;
  private settled = false;
  private abort: AbortController | null = null;
  /** Resolves once the global stream is attached, so no prompt races the subscription. */
  private subscribed: Promise<void> | null = null;

  constructor(descriptor: AgentDescriptor, options: OpenCodeAdapterOptions, input: SessionCreateInput) {
    this.descriptor = descriptor;
    this.options = options;
    this.input = input;
    this.sessionId = input.sessionId;
  }

  get nativeSessionId(): string | null {
    return this.nativeId;
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  async start(): Promise<this> {
    if (this.input.images?.length && !this.descriptor.capabilities.images) {
      // The V2 prompt body carries text and file references, not inline image blocks.
      throw new AgentTransportError(this.agentId, "the V2 prompt body takes text and file references, not attached images");
    }
    this.nativeId = this.input.resumeCursor ?? null;
    if (!this.nativeId) {
      const created = createSessionRequest(this.options.baseUrl, this.input.model
        ? { providerId: this.input.model.providerId, modelId: this.input.model.modelId, ...(this.input.model.variant ? { variant: this.input.model.variant } : {}) }
        : undefined);
      const answer = await this.request(created.url, { method: "POST", body: JSON.stringify(created.body) });
      const id = (answer.body as { data?: { id?: unknown } } | null)?.data?.id;
      if (typeof id !== "string" || !id) throw new AgentTransportError(this.agentId, "OpenCode did not return a session id");
      this.nativeId = id;
      this.queue.push(this.emit(this.sessionId, null, {
        type: "session.started", nativeSessionId: id, model: this.input.model ?? null,
      }));
    } else {
      this.queue.push(this.emit(this.sessionId, null, { type: "session.resumed", nativeSessionId: this.nativeId }));
    }

    // Subscribe before the prompt: the stream is volatile by contract, so an event emitted before
    // the subscription lands would be lost with no way to ask for it again.
    await this.subscribe();
    try {
      await this.sendPrompt(this.input.system ? `${this.input.system}\n\n${this.input.prompt}` : this.input.prompt, undefined);
    } catch (error) {
      // A prompt the server refused must not leave the subscription open with no turn behind it.
      this.fail((error as Error).message);
      throw error;
    }
    return this;
  }

  /** The global stream, filtered to this session: the spec has no per-session event route. */
  private subscribe(): Promise<void> {
    if (this.subscribed) return this.subscribed;
    const controller = new AbortController();
    this.abort = controller;
    this.subscribed = new Promise<void>((resolve) => {
      void this.options.fetch(eventsUrl(this.options.baseUrl), {
        headers: this.headers(),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new AgentHttpError(this.agentId, "GET", "/api/event", response.status, null, "");
          // The response arriving means the subscription exists; the body is read on from here.
          resolve();
          await readSse(response, (message) => {
            const frame = sseJson(message);
            if (!frame) return;
            const event = openCodeEvent(frame, message.event);
            if (!event) return;
            // Every session on this server shares the stream; another session's events are not ours.
            if (eventSessionId(event) !== this.nativeId) return;
            this.onEvent(event);
          }, controller.signal);
          if (!this.settled) this.fail("the event stream ended before the execution finished");
        })
        .catch((error: Error) => {
          resolve();
          if (controller.signal.aborted || this.settled) return;
          this.fail(error.message);
        });
    });
    return this.subscribed;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
    };
  }

  private async request(
    url: string,
    init: { method: string; body?: string },
    timeoutMs = this.options.controlTimeoutMs ?? 30_000,
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.options.fetch(url, {
        method: init.method,
        headers: this.headers(),
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        throw new AgentHttpError(
          this.agentId,
          init.method,
          url.replace(this.options.baseUrl, ""),
          response.status,
          readErrorCode(text),
          text.slice(0, 500),
        );
      }
      return { status: response.status, body: response.status === 204 || !text.trim() ? null : parseJson(text) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendPrompt(text: string, delivery: "steer" | "queue" | undefined): Promise<unknown> {
    const request = promptRequest(this.options.baseUrl, this.nativeId!, { text, ...(delivery ? { delivery } : {}) });
    return this.request(request.url, { method: "POST", body: JSON.stringify(request.body) });
  }

  private onEvent(event: OpenCodeEvent): void {
    const data = event.data;
    switch (event.type) {
      case OPENCODE_EVENT_TYPES.textDelta: {
        const delta = typeof data.delta === "string" ? data.delta : "";
        if (delta) this.queue.push(this.emit(this.sessionId, null, { type: "text.delta", text: delta }));
        return;
      }
      case OPENCODE_EVENT_TYPES.reasoningDelta: {
        const delta = typeof data.delta === "string" ? data.delta : "";
        if (delta) this.queue.push(this.emit(this.sessionId, null, { type: "reasoning.delta", text: delta }));
        return;
      }
      case OPENCODE_EVENT_TYPES.toolCalled: {
        this.queue.push(this.emit(this.sessionId, null, {
          type: "tool.started",
          itemId: String(data.id ?? ""),
          title: toolTitle(data),
        }));
        return;
      }
      case OPENCODE_EVENT_TYPES.toolSuccess: {
        this.queue.push(this.emit(this.sessionId, null, {
          type: "tool.completed", itemId: String(data.id ?? ""), ok: true,
        }));
        return;
      }
      case OPENCODE_EVENT_TYPES.toolFailed: {
        this.queue.push(this.emit(this.sessionId, null, {
          type: "tool.completed", itemId: String(data.id ?? ""), ok: false,
        }));
        return;
      }
      case OPENCODE_EVENT_TYPES.usageUpdated: {
        const usage = readUsage(data.tokens);
        if (usage) this.queue.push(this.emit(this.sessionId, null, { type: "usage.updated", ...usage }));
        return;
      }
      case OPENCODE_EVENT_TYPES.stepEnded: {
        const usage = readUsage(data.tokens);
        if (usage) this.queue.push(this.emit(this.sessionId, null, { type: "usage.updated", ...usage }));
        // A step that ended with tool-calls means the loop continues; only a stop finishes it.
        const finish = typeof data.finish === "string" ? data.finish : "";
        if (finish === "tool-calls") return;
        this.finish(finish === "stop" ? "end_turn" : "failed");
        return;
      }
      case OPENCODE_EVENT_TYPES.executionSucceeded: {
        this.finish("end_turn");
        return;
      }
      case OPENCODE_EVENT_TYPES.executionFailed:
      case OPENCODE_EVENT_TYPES.stepFailed: {
        const error = data.error as { message?: unknown } | undefined;
        this.queue.push(this.emit(this.sessionId, null, {
          type: "error", message: typeof error?.message === "string" ? error.message : "the execution failed",
        }));
        this.finish("failed");
        return;
      }
      case OPENCODE_EVENT_TYPES.executionInterrupted: {
        this.finish("interrupted");
        return;
      }
      case OPENCODE_EVENT_TYPES.idle: {
        // An idle session with nothing running ends a turn that reported no explicit outcome.
        this.finish("end_turn");
        return;
      }
      case OPENCODE_EVENT_TYPES.permissionAsked: {
        const requestId = typeof data.id === "string" ? data.id : "";
        if (!requestId) return;
        const action = typeof data.action === "string" ? data.action : "permission";
        const message = typeof data.message === "string" && data.message ? data.message : action;
        this.queue.push(this.emit(this.sessionId, null, {
          type: "approval.requested",
          requestId,
          title: action,
          detail: message,
          ...(Array.isArray(data.resources)
            ? { choices: data.resources.filter((value): value is string => typeof value === "string") }
            : {}),
        }));
        return;
      }
      default:
        return;
    }
  }

  async steer(text: string): Promise<SteerOutcome> {
    if (this.settled || !this.nativeId) return "refused";
    try {
      await this.sendPrompt(text, "steer");
      return "steered";
    } catch (error) {
      // 409 means the session is not accepting a steer; anything else may have landed.
      if (error instanceof AgentHttpError) return error.isRefusal ? "refused" : "indeterminate";
      return "indeterminate";
    }
  }

  /** `resume=true` resumes pending steering input and next-in-line control items. */
  async interrupt(): Promise<void> {
    if (this.settled || !this.nativeId) return;
    try {
      await this.request(interruptUrl(this.options.baseUrl, this.nativeId, true), { method: "POST" });
    } catch (error) {
      if (!(error instanceof AgentHttpError) || !error.isRefusal) this.fail((error as Error).message);
    }
  }

  async resume(input?: ResumeInput): Promise<ResumeOutcome> {
    if (!input?.cursor) return { resumed: false, nativeSessionId: this.nativeId, rebuilt: false };
    if (!this.nativeId) this.nativeId = input.cursor;
    return { resumed: true, nativeSessionId: this.nativeId, rebuilt: false };
  }

  async cancel(): Promise<void> {
    if (this.settled) return;
    await this.interrupt();
    // The interrupt is a request; ending the turn locally means a caller never waits on a dead
    // execution whose stream already stopped.
    this.finish("cancelled");
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalOutcome> {
    if (!this.nativeId) return "unavailable";
    if (decision.behavior === "answer") {
      // The V2 permission reply is `once`/`always`/`reject`; it carries no free-text answer.
      return "unavailable";
    }
    try {
      await this.request(permissionReplyUrl(this.options.baseUrl, this.nativeId, requestId), {
        method: "POST",
        body: JSON.stringify({
          decision: permissionReply(decision.behavior, decision.always),
          ...(decision.message ? { message: decision.message } : {}),
        }),
      });
    } catch {
      return "unavailable";
    }
    this.queue.push(this.emit(this.sessionId, null, {
      type: "approval.resolved", requestId, behavior: decision.behavior,
    }));
    return decision.behavior === "allow" ? "allowed-once" : "rejected";
  }

  /** `opencode attach <url>` opens the TUI against this very server. */
  nativeTui(): NativeTuiDescriptor {
    return { command: "opencode", args: ["attach", this.options.baseUrl], env: {} };
  }

  async close(): Promise<void> {
    if (!this.settled) await this.cancel();
    this.queue.close();
    this.abort?.abort();
  }

  private finish(stopReason: string): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.push(this.emit(this.sessionId, null, {
      type: "turn.completed",
      ok: stopReason !== "failed",
      stopReason: stopReason === "interrupted" ? "cancelled" : stopReason,
    }));
    this.queue.close();
    this.abort?.abort();
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.push(this.emit(this.sessionId, null, { type: "error", message, terminal: true }));
    this.queue.push(this.emit(this.sessionId, null, { type: "turn.completed", ok: false, stopReason: "failed" }));
    this.queue.close();
    this.abort?.abort();
  }
}

/** `session.tool.called` names a natively-run tool in `native.name`. */
function toolTitle(data: Record<string, unknown>): string {
  const native = data.native as { name?: unknown } | undefined;
  if (typeof native?.name === "string" && native.name) return native.name;
  return typeof data.tool === "string" && data.tool ? data.tool : "tool";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readErrorCode(text: string): string | null {
  const parsed = parseJson(text) as { _tag?: unknown; code?: unknown } | null;
  const code = parsed?._tag ?? parsed?.code;
  return typeof code === "string" && code ? code : null;
}
