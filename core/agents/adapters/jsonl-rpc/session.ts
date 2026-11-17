import { readFileSync } from "node:fs";
import type {
  AgentAdapter, AgentCapabilities, AgentEvent, AgentImage, AgentSession, ModelRef,
  NativeTuiDescriptor, ResumeInput, ResumeOutcome, SessionCreateInput, SteerOutcome, ApprovalDecision,
  ApprovalOutcome,
} from "../../contracts.ts";
import { AgentTransportError, UnsupportedCapabilityError } from "../../errors.ts";
import { eventFactory, EventQueue } from "../../events/queue.ts";
import { readJsonl, type Frame } from "../../transport/jsonl.ts";
import type { ChildLike, SpawnFn } from "../../transport/types.ts";
import { agentDescriptor, type AgentDescriptor } from "../../registry.ts";
import {
  assistantDelta, extensionRequest, modelPair, parseModelId, stopReasonContinues, TurnTracker,
  type RpcResponse,
} from "./codec.ts";

/** How long the session frame may take before the turn proceeds without one. */
const SESSION_OPEN_TIMEOUT_MS = 15_000;

export interface JsonlAgentOptions {
  spawn: SpawnFn;
  /** The engine's own executable; `pi` or `omp`. */
  cli: string;
  /** Instance home, so two engines on one host never share config or credentials. */
  home: string;
  /** Frames above this arrive chunked once protocol v2 is negotiated. */
  negotiateProtocol: boolean;
  /** Whether `agent_settled` ends a turn. Upstream pi sends it; omp may not. */
  settleOnAgentSettled: boolean;
  agentEndGraceMs?: number;
  /** How long a steer waits for the engine's acknowledgement before reporting it indeterminate. */
  steerTimeoutMs?: number;
  /** How long the session frame may take before the turn proceeds without one. */
  sessionOpenTimeoutMs?: number;
}

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** pi and Oh My Pi over their JSONL RPC mode. The two are separate instances: separate CLI,
 * separate HOME, separate version, separate capability notes. */
export class JsonlRpcAdapter implements AgentAdapter {
  readonly agentId;
  readonly transport = "stdio-jsonl" as const;
  readonly capabilities: AgentCapabilities;
  private readonly descriptor: AgentDescriptor;
  private readonly options: JsonlAgentOptions;

  constructor(descriptor: AgentDescriptor, options: JsonlAgentOptions) {
    this.descriptor = descriptor;
    this.options = options;
    this.agentId = descriptor.id;
    this.capabilities = descriptor.capabilities;
  }

  async create(input: SessionCreateInput): Promise<AgentSession> {
    return new JsonlRpcSession(this.descriptor, this.options, input).start();
  }
}

class JsonlRpcSession implements AgentSession {
  readonly agentId;
  private readonly emit: ReturnType<typeof eventFactory>;
  private readonly queue = new EventQueue();
  private readonly pending = new Map<string, PendingCommand>();
  private child: ChildLike | null = null;
  private turnId: string | null = null;
  private nativeId: string | null = null;
  private settled = false;
  private steerSeq = 0;
  private readonly approvals = new Map<string, (decision: ApprovalDecision) => void>();
  private tracker: TurnTracker | null = null;
  private readonly descriptor: AgentDescriptor;
  private readonly options: JsonlAgentOptions;
  private readonly input: SessionCreateInput;

  constructor(descriptor: AgentDescriptor, options: JsonlAgentOptions, input: SessionCreateInput) {
    this.descriptor = descriptor;
    this.options = options;
    this.input = input;
    this.agentId = descriptor.id;
    this.emit = eventFactory();
  }

  get sessionId(): string {
    return this.input.sessionId;
  }

  get nativeSessionId(): string | null {
    return this.nativeId;
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  async start(): Promise<this> {
    const args = ["--mode", "rpc", "--no-session"];
    const child = this.options.spawn(this.options.cli, args, {
      env: { ...this.input.env, ...this.homeEnv() },
      ...(this.input.cwd ? { cwd: this.input.cwd } : {}),
    });
    this.child = child;
    readJsonl(child.stdout, (frame) => this.onFrame(frame));
    child.on("error", (error) => this.fail(error.message));
    child.on("exit", (code, signal) => {
      if (this.settled) return;
      this.fail(`process exited ${code ?? signal ?? "unknown"} before the turn ended`);
    });

    if (this.options.negotiateProtocol) {
      // omp chunks frames over 1 MiB only after protocol v2; vanilla pi answers an error frame,
      // which is harmless because nothing here waits for the reply.
      this.write({ id: "negotiate", type: "negotiate_protocol", protocolVersion: 2 });
    }
    try {
      await this.openSession();
      await this.setModel(this.input.model);
      this.turnId = `turn-${Date.now().toString(36)}`;
      this.queue.push(this.emit(this.sessionId, this.turnId, { type: "turn.started" }));
      await this.prompt();
    } catch (error) {
      // A start that threw must not leave the process running or the event stream open.
      this.fail((error as Error).message);
      throw error;
    }
    return this;
  }

  private homeEnv(): Record<string, string> {
    const home = this.descriptor.homeEnv;
    return home ? { [home]: this.options.home } : { HOME: this.options.home };
  }

  private async openSession(): Promise<void> {
    const cursor = this.input.resumeCursor;
    const command = cursor ? "switch_session" : "new_session";
    // Bounded: a prompt must not wait a minute on an engine that never answers the session frame.
    const reply = this.command(
      cursor ? { type: command, sessionPath: cursor } : { type: command },
      this.options.sessionOpenTimeoutMs ?? SESSION_OPEN_TIMEOUT_MS,
    );
    try {
      const data = (await reply) as { sessionFile?: unknown; sessionId?: unknown } | undefined;
      this.nativeId = typeof data?.sessionFile === "string" ? data.sessionFile
        : typeof data?.sessionId === "string" ? data.sessionId : null;
      this.queue.push(this.emit(this.sessionId, this.turnId, cursor
        ? { type: "session.resumed", nativeSessionId: this.nativeId }
        : { type: "session.started", nativeSessionId: this.nativeId, model: this.input.model ?? null }));
    } catch (error) {
      // `--no-session` accepts a prompt without an explicit session, so the turn still runs; the
      // caller is told the session frame went unanswered rather than left to infer it.
      this.nativeId = null;
      this.queue.push(this.emit(this.sessionId, this.turnId, {
        type: "notice",
        message: `the engine did not confirm a session (${(error as Error).message}); the turn runs without one`,
      }));
      this.queue.push(this.emit(this.sessionId, this.turnId, {
        type: "session.started", nativeSessionId: null, model: this.input.model ?? null,
      }));
    }
  }

  private async setModel(model: ModelRef | undefined): Promise<void> {
    if (!model) return;
    const pair = modelPair(model);
    try {
      await this.command({ type: "set_model", provider: pair.provider, modelId: pair.modelId });
    } catch (error) {
      this.queue.push(this.emit(this.sessionId, this.turnId, { type: "error", message: (error as Error).message }));
    }
  }

  private async prompt(): Promise<void> {
    const text = this.input.system ? `${this.input.system}\n\n${this.input.prompt}` : this.input.prompt;
    const images = this.readImages(this.input.images ?? []);
    const frame: Record<string, unknown> = { type: "prompt", message: text };
    if (images.length) frame.images = images;
    this.tracker = new TurnTracker(
      {
        agentEndGraceMs: this.options.agentEndGraceMs ?? 60_000,
        settleOnAgentSettled: this.options.settleOnAgentSettled,
      },
      (outcome) => this.finishTurn(outcome),
    );
    try {
      await this.command(frame, 120_000);
    } catch (error) {
      this.fail((error as Error).message);
    }
  }

  /** pi's prompt frame carries each attached image as base64. */
  private readImages(images: readonly AgentImage[]): Array<{ type: "image"; data: string; mimeType: string }> {
    if (!images.length) return [];
    if (!this.descriptor.capabilities.images) {
      // Dropping an attachment silently would let the turn answer as if it had seen the picture.
      throw new UnsupportedCapabilityError(this.agentId, "images");
    }
    return images.map((image) => ({
      type: "image" as const,
      data: readFileSync(image.path).toString("base64"),
      mimeType: image.mime,
    }));
  }

  private command(frame: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
    const id = typeof frame.id === "string" ? frame.id : `${String(frame.type)}:${++this.steerSeq}`;
    const key = id;
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs === Number.POSITIVE_INFINITY
        ? null
        : setTimeout(() => {
            if (this.pending.delete(key)) reject(new AgentTransportError(this.agentId, `${String(frame.type)} timed out`));
          }, timeoutMs);
      timer?.unref?.();
      this.pending.set(key, { resolve, reject, timer });
      try {
        this.write({ ...frame, id });
      } catch (error) {
        this.pending.delete(key);
        if (timer) clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  private write(frame: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin) throw new AgentTransportError(this.agentId, "process has no stdin");
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private onFrame(frame: Frame): void {
    if (frame.type === "response") {
      const response = frame as unknown as RpcResponse;
      const key = typeof response.id === "string" ? response.id : typeof response.command === "string" ? response.command : "";
      const pending = key ? this.pending.get(key) : undefined;
      if (pending) {
        this.pending.delete(key);
        if (pending.timer) clearTimeout(pending.timer);
        if (response.success === false) pending.reject(new AgentTransportError(this.agentId, `${key} refused`));
        else pending.resolve(response.data);
      }
      return;
    }
    const request = extensionRequest(frame);
    if (request) {
      this.approvalRequest(request);
      return;
    }
    const delta = assistantDelta(frame);
    if (delta) {
      this.tracker?.stillWorking();
      this.queue.push(this.emit(this.sessionId, this.turnId, {
        type: delta.kind === "text" ? "text.delta" : "reasoning.delta",
        text: delta.text,
      }));
      return;
    }
    switch (frame.type) {
      case "tool_execution_start": {
        this.tracker?.stillWorking();
        this.queue.push(this.emit(this.sessionId, this.turnId, {
          type: "tool.started",
          itemId: String(frame.toolCallId ?? ""),
          title: String(frame.toolName ?? "tool"),
        }));
        return;
      }
      case "tool_execution_end": {
        this.queue.push(this.emit(this.sessionId, this.turnId, {
          type: "tool.completed",
          itemId: String(frame.toolCallId ?? ""),
          ok: frame.isError !== true,
        }));
        return;
      }
      case "turn_start":
      case "agent_start":
        this.tracker?.stillWorking();
        return;
      case "turn_end":
        this.tracker?.turnEnd(frame);
        return;
      case "agent_end":
        this.tracker?.agentEnd(frame);
        return;
      case "agent_settled":
        this.tracker?.agentSettled();
        return;
      case "compaction_start":
      case "auto_compaction_start":
        this.tracker?.stillWorking();
        return;
      default:
        return;
    }
  }

  private approvalRequest(request: ReturnType<typeof extensionRequest> & object): void {
    const isQuestion = request.method === "select" || request.method === "input";
    const choices = request.options;
    this.approvals.set(request.id, (decision) => {
      if (decision.behavior === "deny") {
        this.write({ type: "extension_ui_response", id: request.id, cancelled: true });
      } else if (isQuestion) {
        this.write({ type: "extension_ui_response", id: request.id, value: decision.message ?? "" });
      } else {
        this.write({ type: "extension_ui_response", id: request.id, confirmed: true });
      }
      this.queue.push(this.emit(this.sessionId, this.turnId, {
        type: "approval.resolved", requestId: request.id, behavior: decision.behavior,
      }));
    });
    this.queue.push(this.emit(this.sessionId, this.turnId, isQuestion
      ? {
          type: "question.requested",
          requestId: request.id,
          title: String(request.title ?? "the agent has a question"),
          questions: [{ question: String(request.title ?? "Question"), options: (choices ?? []).map((label) => ({ label })) }],
        }
      : {
          type: "approval.requested",
          requestId: request.id,
          title: String(request.title ?? "the agent wants confirmation"),
          ...(choices ? { choices } : {}),
        }));
  }

  async steer(text: string): Promise<SteerOutcome> {
    if (this.settled || !this.child) return "refused";
    const id = `steer:${++this.steerSeq}`;
    try {
      const ack = this.command({ type: "steer", id, message: text }, this.options.steerTimeoutMs ?? 20_000);
      await ack;
      return "steered";
    } catch (error) {
      // A refusal is an explicit success:false; a timeout after the write may already have
      // delivered the words, so it is indeterminate rather than safe to re-queue.
      return (error as Error).message.includes("timed out") ? "indeterminate" : "refused";
    }
  }

  async interrupt(): Promise<void> {
    if (this.settled) return;
    try {
      this.write({ type: "abort" });
    } catch {
      // The process is already gone; the exit handler settles the turn.
    }
    this.tracker?.forceSettle("cancelled");
  }

  async resume(input?: ResumeInput): Promise<ResumeOutcome> {
    if (!input?.cursor) return { resumed: false, nativeSessionId: this.nativeId, rebuilt: false };
    try {
      const data = (await this.command({ type: "switch_session", sessionPath: input.cursor }, 60_000)) as
        | { sessionFile?: unknown }
        | undefined;
      this.nativeId = typeof data?.sessionFile === "string" ? data.sessionFile : input.cursor;
      return { resumed: true, nativeSessionId: this.nativeId, rebuilt: false };
    } catch {
      if (input.recoveryText === undefined) throw new AgentTransportError(this.agentId, "resume was refused");
      await this.openSession();
      return { resumed: false, nativeSessionId: this.nativeId, rebuilt: true };
    }
  }

  async cancel(): Promise<void> {
    if (this.settled) return;
    this.tracker?.forceSettle("cancelled");
    this.child?.kill("SIGTERM");
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalOutcome> {
    const answer = this.approvals.get(requestId);
    if (!answer) return "unavailable";
    this.approvals.delete(requestId);
    answer(decision);
    return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
  }

  nativeTui(): NativeTuiDescriptor {
    const tui = this.descriptor.tui;
    if (!tui.length) throw new AgentTransportError(this.agentId, "has no native TUI");
    return { command: tui[0]!, args: tui.slice(1), env: this.homeEnv() };
  }

  async close(): Promise<void> {
    if (!this.settled) await this.cancel();
    this.queue.close();
    // A closed session releases its process even when the turn had already ended.
    try {
      this.child?.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private finishTurn(outcome: { ok: boolean; stopReason: string }): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.push(this.emit(this.sessionId, this.turnId, {
      type: "turn.completed", ok: outcome.ok, stopReason: outcome.stopReason,
    }));
    this.queue.close();
    try {
      this.child?.stdin?.end();
    } catch {
      // Already closed.
    }
    this.child?.kill("SIGTERM");
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.push(this.emit(this.sessionId, this.turnId, { type: "error", message, terminal: true }));
    this.queue.push(this.emit(this.sessionId, this.turnId, { type: "turn.completed", ok: false, stopReason: "failed" }));
    this.queue.close();
    try {
      this.child?.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

export function createPiAdapter(spawn: SpawnFn, home: string): AgentAdapter {
  return new JsonlRpcAdapter(agentDescriptor("pi"), {
    spawn, cli: "pi", home, negotiateProtocol: true, settleOnAgentSettled: true,
  });
}

export function createOhMyPiAdapter(spawn: SpawnFn, home: string): AgentAdapter {
  return new JsonlRpcAdapter(agentDescriptor("ohMyPi"), {
    spawn, cli: "omp", home, negotiateProtocol: true, settleOnAgentSettled: false,
  });
}

/** Re-exported so a caller reading a model id gets the same parse the adapters use. */
export { parseModelId, stopReasonContinues };
