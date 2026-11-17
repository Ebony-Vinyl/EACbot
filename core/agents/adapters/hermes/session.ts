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
  approvalBody, clarifyBody, createRunBody, deltaText, hermesErrorCode, hermesFeatures, isTerminalStatus,
  nativeSessionIdOf, runUsage, steerBody, terminalEventStatus, IDEMPOTENCY_HEADER, validIdempotencyKey,
  type HermesFeatures, type HermesRunStatusBody,
} from "./codec.ts";

export interface HermesAdapterOptions {
  /** Base URL of the Hermes API server, e.g. `http://127.0.0.1:8642`. */
  baseUrl: string;
  fetch: FetchLike;
  /** `API_SERVER_KEY` as a bearer; the server refuses every run without one. */
  token: string;
  /** How long a control call may take before it is abandoned. */
  controlTimeoutMs?: number;
}

/** Hermes over its HTTP Runs surface. A run is created, watched, steered, stopped, approved and
 * clarified by its own id; the caller's conversation id travels as `session_id`, and the native
 * session id is only ever the value Hermes echoes back on the run status. */
export class HermesAdapter implements AgentAdapter {
  readonly agentId = "hermes" as const;
  readonly transport = "http" as const;
  readonly capabilities: AgentCapabilities;
  private readonly descriptor: AgentDescriptor;
  private readonly options: HermesAdapterOptions;

  constructor(options: HermesAdapterOptions) {
    this.options = options;
    this.descriptor = agentDescriptor("hermes");
    this.capabilities = this.descriptor.capabilities;
  }

  async create(input: SessionCreateInput): Promise<AgentSession> {
    return new HermesSession(this.descriptor, this.options, input).start();
  }
}

class HermesSession implements AgentSession {
  readonly agentId = "hermes" as const;
  readonly sessionId: string;
  private readonly descriptor: AgentDescriptor;
  private readonly options: HermesAdapterOptions;
  private readonly input: SessionCreateInput;
  private readonly emit = eventFactory();
  private readonly queue = new EventQueue();
  private runId: string | null = null;
  /** Only ever a value the server reported; never the caller's own id standing in for it. */
  private nativeId: string | null = null;
  private settled = false;
  private abort: AbortController | null = null;
  /** The identity an approval or clarify answer must name. */
  private generation: number | undefined;
  private features: HermesFeatures | null = null;

  constructor(descriptor: AgentDescriptor, options: HermesAdapterOptions, input: SessionCreateInput) {
    this.descriptor = descriptor;
    this.options = options;
    this.input = input;
    this.sessionId = input.sessionId;
  }

  /** The engine's own session id for this conversation, once it has reported one. */
  get nativeSessionId(): string | null {
    return this.nativeId;
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  async start(): Promise<this> {
    if (this.input.images?.length && !this.descriptor.capabilities.images) {
      this.queue.push(this.emit(this.sessionId, null, {
        type: "error", message: "Hermes' runs API takes text only; the attached images were not sent", setup: true,
      }));
      this.queue.close();
      return this;
    }
    const key = this.input.idempotencyKey;
    if (key !== undefined && !validIdempotencyKey(key)) {
      // The header's own rule (1–255 visible ASCII); a bad key is a caller bug, not a retry.
      throw new AgentTransportError(this.agentId, "idempotencyKey must be 1–255 visible ASCII characters");
    }
    this.features = await this.readFeatures();

    const created = await this.request("/v1/runs", {
      method: "POST",
      body: JSON.stringify(createRunBody({
        prompt: this.input.prompt,
        sessionId: this.input.sessionId,
        ...(this.input.model ? { model: this.input.model } : {}),
        ...(this.input.system ? { system: this.input.system } : {}),
      })),
      ...(key === undefined ? {} : { headers: { [IDEMPOTENCY_HEADER]: key } }),
    });
    const createdBody = created.body as (HermesRunStatusBody & { run_id?: unknown }) | null;
    const runId = createdBody?.run_id;
    if (typeof runId !== "string" || !runId) {
      throw new AgentTransportError(this.agentId, "Hermes did not return a run id");
    }
    this.runId = runId;
    if (created.replayed) {
      // Idempotency-Key replay: the engine returned the run it already owns for this command.
      this.queue.push(this.emit(this.sessionId, runId, {
        type: "notice", message: "Hermes replayed the run already created for this command id",
      }));
    }

    // The create response carries no session id; the run status does. Reading it is what makes
    // `nativeSessionId` a fact rather than an echo of the caller's own id.
    await this.reconcileStatus();
    this.queue.push(this.emit(this.sessionId, runId, this.input.resumeCursor
      ? { type: "session.resumed", nativeSessionId: this.nativeId }
      : { type: "session.started", nativeSessionId: this.nativeId, model: this.input.model ?? null }));
    this.queue.push(this.emit(this.sessionId, runId, { type: "turn.started" }));
    this.listen();
    return this;
  }

  /** A bounded probe: a server that never answers it must not stall a conversation. */
  private async readFeatures(): Promise<HermesFeatures | null> {
    try {
      const answer = await this.request("/v1/capabilities", { method: "GET" }, 5_000);
      return hermesFeatures(answer.body);
    } catch {
      // An older server without the document; the Runs surface still works, and no optional
      // control is assumed.
      return null;
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.options.token}`, ...extra };
  }

  /** One control call. A non-2xx answer becomes an `AgentHttpError` carrying the engine's own
   * status and error code, so a 409 refusal is never mistaken for a flaky connection. */
  private async request(
    path: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
    timeoutMs = this.options.controlTimeoutMs ?? 30_000,
  ): Promise<{ status: number; body: unknown; replayed: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.options.fetch(`${this.options.baseUrl}${path}`, {
        method: init.method,
        headers: this.headers(init.headers),
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        const parsed = parseJson(text);
        throw new AgentHttpError(this.agentId, init.method, path, response.status, hermesErrorCode(parsed), text.slice(0, 500));
      }
      return {
        status: response.status,
        body: response.status === 204 || !text.trim() ? null : parseJson(text),
        replayed: response.headers.get("idempotency-replayed") === "true",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private listen(): void {
    const controller = new AbortController();
    this.abort = controller;
    void this.options.fetch(`${this.options.baseUrl}/v1/runs/${encodeURIComponent(this.runId!)}/events`, {
      headers: this.headers(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new AgentHttpError(this.agentId, "GET", "/v1/runs/{id}/events", response.status, null, "");
        await readSse(response, (message) => {
          const payload = sseJson(message) ?? {};
          this.onEvent(message.event, payload);
        }, controller.signal);
        if (!this.settled) await this.reconcileStatus();
      })
      .catch((error: Error) => {
        if (controller.signal.aborted || this.settled) return;
        this.fail(error.message);
      });
  }

  /** Reads the run status once: the session id, the control identity and the outcome all live
   * there, and the stream alone cannot be trusted to have carried them. */
  private async reconcileStatus(): Promise<void> {
    let status: HermesRunStatusBody | null;
    try {
      status = (await this.request(`/v1/runs/${encodeURIComponent(this.runId!)}`, { method: "GET" })).body as
        | HermesRunStatusBody
        | null;
    } catch (error) {
      this.fail((error as Error).message);
      return;
    }
    this.nativeId = nativeSessionIdOf(status) ?? this.nativeId;
    this.generation = status?.pending_controls?.execution_generation ?? status?.execution_generation ?? this.generation;
    if (this.settled) return;
    const value = typeof status?.status === "string" ? status.status : "";
    if (!value) return;
    if (value === "unknown") {
      // Documented as not terminal: the run waits for resolve-unknown, and the caller must know.
      this.queue.push(this.emit(this.sessionId, this.runId, {
        type: "notice",
        message: "Hermes reported this run as unknown; it waits for resolve-unknown before the session continues",
      }));
      return;
    }
    if (!isTerminalStatus(value)) return;
    const usage = runUsage(status);
    if (usage) this.queue.push(this.emit(this.sessionId, this.runId, { type: "usage.updated", ...usage }));
    if (status?.output) this.queue.push(this.emit(this.sessionId, this.runId, { type: "text.delta", text: status.output }));
    if (status?.error) this.queue.push(this.emit(this.sessionId, this.runId, { type: "error", message: status.error }));
    this.finish(value, status?.pending_steer);
  }

  private onEvent(event: string, payload: Record<string, unknown>): void {
    const status = terminalEventStatus(event);
    if (status) {
      const usage = runUsage(payload as HermesRunStatusBody);
      if (usage) this.queue.push(this.emit(this.sessionId, this.runId, { type: "usage.updated", ...usage }));
      const output = typeof payload.output === "string" ? payload.output : "";
      if (output) this.queue.push(this.emit(this.sessionId, this.runId, { type: "text.delta", text: output }));
      const pendingSteer = typeof payload.pending_steer === "string" && payload.pending_steer ? payload.pending_steer : undefined;
      const error = typeof payload.error === "string" && payload.error ? payload.error : undefined;
      if (error) this.queue.push(this.emit(this.sessionId, this.runId, { type: "error", message: error }));
      this.finish(status, pendingSteer);
      return;
    }
    switch (event) {
      case "message.delta": {
        const text = deltaText(payload);
        if (text) this.queue.push(this.emit(this.sessionId, this.runId, { type: "text.delta", text }));
        return;
      }
      case "message.interim": {
        // Mid-turn commentary. `already_streamed` means it also went out as message.delta.
        if (payload.already_streamed === true) return;
        const text = deltaText(payload);
        if (text) this.queue.push(this.emit(this.sessionId, this.runId, { type: "text.delta", text }));
        return;
      }
      case "tool.started": {
        this.queue.push(this.emit(this.sessionId, this.runId, {
          type: "tool.started",
          itemId: String(payload.tool ?? ""),
          title: String(payload.tool ?? "tool"),
        }));
        return;
      }
      case "tool.completed": {
        this.queue.push(this.emit(this.sessionId, this.runId, {
          type: "tool.completed",
          itemId: String(payload.tool ?? ""),
          ok: payload.error === undefined || payload.error === null || payload.error === false,
        }));
        return;
      }
      case "approval.request": {
        const requestId = typeof payload.request_id === "string" ? payload.request_id
          : typeof payload.prompt_id === "string" ? payload.prompt_id : "";
        if (!requestId) return;
        if (typeof payload.execution_generation === "number") this.generation = payload.execution_generation;
        this.queue.push(this.emit(this.sessionId, this.runId, {
          type: "approval.requested",
          requestId,
          title: typeof payload.command === "string" ? payload.command
            : typeof payload.description === "string" ? payload.description : "approval requested",
        }));
        return;
      }
      case "clarify.request": {
        // Same canonical control surface as an approval; the answer goes to /clarify.
        if (this.features && !this.features.clarify) return;
        const requestId = typeof payload.request_id === "string" ? payload.request_id
          : typeof payload.prompt_id === "string" ? payload.prompt_id : "";
        if (!requestId) return;
        if (typeof payload.execution_generation === "number") this.generation = payload.execution_generation;
        const question = typeof payload.question === "string" ? payload.question
          : typeof payload.prompt === "string" ? payload.prompt : "the agent has a question";
        const options = Array.isArray(payload.choices)
          ? payload.choices.filter((choice): choice is string => typeof choice === "string")
          : [];
        this.queue.push(this.emit(this.sessionId, this.runId, {
          type: "question.requested",
          requestId,
          title: question,
          questions: [{ question, options: options.map((label) => ({ label })) }],
        }));
        return;
      }
      case "run.steered": {
        this.queue.push(this.emit(this.sessionId, this.runId, {
          type: "notice", message: "Hermes queued the steering text for its next tool boundary",
        }));
        return;
      }
      default:
        return;
    }
  }

  async steer(text: string): Promise<SteerOutcome> {
    if (this.settled || !this.runId) return "refused";
    try {
      await this.request(`/v1/runs/${encodeURIComponent(this.runId)}/steer`, {
        method: "POST",
        body: JSON.stringify(steerBody(text)),
      });
      // 200 means the text was queued for the next tool boundary. The engine owns it now, so it
      // is `steered`; `capabilities.steer.kind === "next-boundary"` is where the difference from a
      // native fold is read.
      return "steered";
    } catch (error) {
      // 409 run_not_accepting_steer is a provable refusal; anything else may have been delivered.
      if (error instanceof AgentHttpError) return error.isRefusal ? "refused" : "indeterminate";
      return "indeterminate";
    }
  }

  async interrupt(): Promise<void> {
    if (this.settled || !this.runId) return;
    try {
      await this.request(`/v1/runs/${encodeURIComponent(this.runId)}/stop`, { method: "POST" });
    } catch (error) {
      // A run that already ended refuses the stop; the status read settles it.
      if (!(error instanceof AgentHttpError) || !error.isRefusal) this.fail((error as Error).message);
    }
  }

  async resume(input?: ResumeInput): Promise<ResumeOutcome> {
    // Hermes continues a transcript from the caller's session id in a new run; nothing private is
    // consulted. The native id stays whatever the server last reported.
    return {
      resumed: Boolean(input?.cursor ?? this.input.sessionId),
      nativeSessionId: this.nativeId,
      rebuilt: false,
    };
  }

  async cancel(): Promise<void> {
    if (this.settled) return;
    await this.interrupt();
    // The stop is cooperative and settles the run as cancelled; if it never answers, this turn
    // still ends locally so a caller is never left waiting on a dead run.
    this.finish("cancelled");
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalOutcome> {
    if (!this.runId) return "unavailable";
    if (this.features && decision.behavior === "answer" && !this.features.clarify) return "unavailable";
    if (this.features && decision.behavior !== "answer" && !this.features.approval) return "unavailable";
    try {
      if (decision.behavior === "answer") {
        await this.request(`/v1/runs/${encodeURIComponent(this.runId)}/clarify`, {
          method: "POST",
          body: JSON.stringify(clarifyBody({
            requestId,
            ...(this.generation === undefined ? {} : { executionGeneration: this.generation }),
            answer: decision.message ?? "",
          })),
        });
      } else {
        await this.request(`/v1/runs/${encodeURIComponent(this.runId)}/approval`, {
          method: "POST",
          body: JSON.stringify(approvalBody({
            requestId,
            ...(this.generation === undefined ? {} : { executionGeneration: this.generation }),
            allow: decision.behavior === "allow",
          })),
        });
      }
    } catch (error) {
      // A stale generation or a foreign request id is a 409 the engine decided; nobody can answer
      // this request now, which is what `unavailable` means.
      if (error instanceof AgentHttpError && error.isRefusal) return "unavailable";
      return "unavailable";
    }
    this.queue.push(this.emit(this.sessionId, this.runId, {
      type: "approval.resolved", requestId, behavior: decision.behavior,
    }));
    return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
  }

  nativeTui(): NativeTuiDescriptor {
    return { command: "hermes", args: [], env: {} };
  }

  async close(): Promise<void> {
    if (!this.settled) await this.cancel();
    this.queue.close();
  }

  private finish(stopReason: string, pendingSteer?: string): void {
    if (this.settled) return;
    this.settled = true;
    // A stop the person asked for is a clean end; only a run that failed is a failure.
    const ok = stopReason === "completed" || stopReason === "cancelled" || stopReason === "interrupted";
    this.queue.push(this.emit(this.sessionId, this.runId, {
      type: "turn.completed",
      ok,
      stopReason: stopReason === "completed" ? "completed" : ok ? "cancelled" : "failed",
      ...(pendingSteer ? { pendingSteer } : {}),
    }));
    this.queue.close();
    this.abort?.abort();
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.push(this.emit(this.sessionId, this.runId, { type: "error", message, terminal: true }));
    this.queue.push(this.emit(this.sessionId, this.runId, { type: "turn.completed", ok: false, stopReason: "failed" }));
    this.queue.close();
    this.abort?.abort();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
