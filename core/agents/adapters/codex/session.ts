import { readFileSync } from "node:fs";
import type {
  AgentAdapter, AgentCapabilities, AgentEvent, AgentSession, ApprovalDecision, ApprovalOutcome, ModelRef,
  NativeTuiDescriptor, ResumeInput, ResumeOutcome, SessionCreateInput, SteerOutcome,
} from "../../contracts.ts";
import { AgentRpcError, AgentTransportError, UnsupportedCapabilityError } from "../../errors.ts";
import { eventFactory, EventQueue } from "../../events/queue.ts";
import { JsonRpcPeer } from "../../transport/rpc.ts";
import type { SpawnFn } from "../../transport/types.ts";
import { agentDescriptor, type AgentDescriptor } from "../../registry.ts";
import {
  approvalResult, codexNotification, initializeParams, isApprovalMethod, threadStartParams, tokenUsage, toolItemTitle,
  turnInterruptParams, turnStartParams, turnSteerParams,
} from "./codec.ts";

export interface CodexAdapterOptions {
  spawn: SpawnFn;
  home: string;
  cli?: string;
  clientVersion?: string;
}

/** Codex over its `app-server` JSON-RPC. One process per session; `thread/resume` carries the
 * engine's own thread id, which stays a resume cursor rather than the conversation's identity. */
export class CodexAdapter implements AgentAdapter {
  readonly agentId = "codex" as const;
  readonly transport = "stdio-json-rpc" as const;
  readonly capabilities: AgentCapabilities;
  private readonly descriptor: AgentDescriptor;
  private readonly options: CodexAdapterOptions;

  constructor(options: CodexAdapterOptions) {
    this.options = options;
    this.descriptor = agentDescriptor("codex");
    this.capabilities = this.descriptor.capabilities;
  }

  async create(input: SessionCreateInput): Promise<AgentSession> {
    return new CodexSession(this.descriptor, this.options, input).start();
  }
}

class CodexSession implements AgentSession {
  readonly agentId = "codex" as const;
  readonly sessionId: string;
  private readonly descriptor: AgentDescriptor;
  private readonly options: CodexAdapterOptions;
  private readonly input: SessionCreateInput;
  private readonly emit = eventFactory();
  private readonly queue = new EventQueue();
  private readonly approvals = new Map<string, { rpcId: unknown; method: string }>();
  private rpc: JsonRpcPeer | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private settled = false;

  constructor(descriptor: AgentDescriptor, options: CodexAdapterOptions, input: SessionCreateInput) {
    this.descriptor = descriptor;
    this.options = options;
    this.input = input;
    this.sessionId = input.sessionId;
  }

  get nativeSessionId(): string | null {
    return this.threadId;
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  async start(): Promise<this> {
    const child = this.options.spawn(this.options.cli ?? "codex", ["app-server"], {
      env: { ...this.input.env, HOME: this.options.home },
      ...(this.input.cwd ? { cwd: this.input.cwd } : {}),
    });
    const rpc = new JsonRpcPeer(this.agentId, child, {
      agentId: this.agentId,
      onRequest: (frame) => this.serverRequest(frame),
      onNotification: (frame) => this.notification(frame),
      onExit: (code, signal) => {
        if (!this.settled) this.fail(`app-server exited ${code ?? signal ?? "unknown"} before turn/completed`);
      },
    });
    this.rpc = rpc;

    try {
      return await this.handshake(rpc);
    } catch (error) {
      // A handshake that failed after the process started must not leave it running, nor leave
      // the event stream open with no turn behind it.
      this.fail((error as Error).message);
      throw error;
    }
  }

  private async handshake(rpc: JsonRpcPeer): Promise<this> {
    await rpc.call("initialize", initializeParams(this.options.clientVersion ?? "0.0.0"));
    rpc.notify("initialized", {});

    const start = this.input.resumeCursor
      ? await rpc.call("thread/resume", { threadId: this.input.resumeCursor })
      : await rpc.call("thread/start", threadStartParams({
          cwd: this.input.cwd ?? process.cwd(),
          ...(this.input.model ? { model: this.input.model.modelId } : {}),
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          ...(this.input.system ? { instructions: this.input.system } : {}),
        }));
    this.threadId = readThreadId(start) ?? this.input.resumeCursor ?? null;
    if (!this.threadId) throw new AgentTransportError(this.agentId, "Codex did not return a thread id");
    this.queue.push(this.emit(this.sessionId, null, this.input.resumeCursor
      ? { type: "session.resumed", nativeSessionId: this.threadId }
      : { type: "session.started", nativeSessionId: this.threadId, model: this.input.model ?? null }));

    const turn = await rpc.call("turn/start", turnStartParams({
      threadId: this.threadId,
      text: this.promptText(),
      images: this.readImages(),
    }));
    this.turnId = readTurnId(turn);
    if (!this.turnId) throw new AgentTransportError(this.agentId, "Codex did not return a turn id");
    this.queue.push(this.emit(this.sessionId, this.turnId, { type: "turn.started" }));
    return this;
  }

  /** Codex takes an inline data URL per image; a host path would be unreadable to the sandboxed
   * run, and an engine without the capability gets a typed refusal instead. */
  private readImages(): string[] {
    const images = this.input.images ?? [];
    if (!images.length) return [];
    if (!this.descriptor.capabilities.images) {
      throw new UnsupportedCapabilityError(this.agentId, "images");
    }
    return images.map((image) => `data:${image.mime};base64,${readFileSync(image.path).toString("base64")}`);
  }

  private promptText(): string {
    return this.input.system ? `${this.input.system}\n\n${this.input.prompt}` : this.input.prompt;
  }

  private serverRequest(frame: Record<string, unknown>): void {
    const method = String(frame.method);
    if (!isApprovalMethod(method)) {
      // Unknown server requests fail closed: an unhandled request must never become consent.
      this.rpc?.respondError(frame.id, -32601, `unsupported server request: ${method}`);
      return;
    }
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const requestId = `codex-${String(frame.id)}`;
    const isQuestion = method === "item/tool/requestUserInput";
    this.approvals.set(requestId, { rpcId: frame.id, method });
    const summary = typeof params.command === "string" ? params.command
      : typeof params.message === "string" ? params.message
      : typeof params.serverName === "string" ? `MCP server ${params.serverName}`
      : method;
    this.queue.push(this.emit(this.sessionId, this.turnId, isQuestion
      ? {
          type: "question.requested",
          requestId,
          title: summary,
          questions: [{ question: summary, options: [] }],
        }
      : { type: "approval.requested", requestId, title: summary }));
  }

  private notification(frame: Record<string, unknown>): void {
    const note = codexNotification(frame);
    if (!note) return;
    switch (note.method) {
      case "item/agentMessage/delta": {
        const delta = typeof note.params.delta === "string" ? note.params.delta : "";
        if (delta) this.queue.push(this.emit(this.sessionId, this.turnId, { type: "text.delta", text: delta }));
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = typeof note.params.delta === "string" ? note.params.delta : "";
        if (delta) this.queue.push(this.emit(this.sessionId, this.turnId, { type: "reasoning.delta", text: delta }));
        return;
      }
      case "item/started": {
        const item = (note.params.item ?? {}) as Record<string, unknown>;
        const title = toolItemTitle(item);
        if (!title) return;
        this.queue.push(this.emit(this.sessionId, this.turnId, {
          type: "tool.started", itemId: String(item.id ?? title), title,
        }));
        return;
      }
      case "item/completed": {
        const item = (note.params.item ?? {}) as Record<string, unknown>;
        const title = toolItemTitle(item);
        if (!title) return;
        this.queue.push(this.emit(this.sessionId, this.turnId, {
          type: "tool.completed", itemId: String(item.id ?? title), ok: item.status !== "failed",
        }));
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = tokenUsage(note.params);
        if (usage) this.queue.push(this.emit(this.sessionId, this.turnId, { type: "usage.updated", ...usage }));
        return;
      }
      case "error": {
        const message = typeof note.params.message === "string" ? note.params.message : "Codex reported an error";
        this.queue.push(this.emit(this.sessionId, this.turnId, { type: "error", message }));
        return;
      }
      case "turn/completed": {
        const turn = (note.params.turn ?? {}) as Record<string, unknown>;
        // The turn's own status decides: an `error` notification can be a recoverable warning,
        // and calling a completed turn failed would hide the answer it produced.
        const failed = turn.status === "failed";
        this.finish(!failed, failed ? "failed" : "end_turn");
        return;
      }
      case "turn/aborted":
        this.finish(true, "interrupted");
        return;
      default:
        return;
    }
  }

  async steer(text: string): Promise<SteerOutcome> {
    if (this.settled || !this.rpc || !this.threadId || !this.turnId) return "refused";
    try {
      await this.rpc.call("turn/steer", turnSteerParams({ threadId: this.threadId, turnId: this.turnId, text }), 10_000);
      return "steered";
    } catch (error) {
      // A timeout after the write may already have delivered the words.
      if (error instanceof AgentRpcError) return "refused";
      return "indeterminate";
    }
  }

  async interrupt(): Promise<void> {
    if (this.settled || !this.rpc || !this.threadId || !this.turnId) return;
    try {
      await this.rpc.call("turn/interrupt", turnInterruptParams({ threadId: this.threadId, turnId: this.turnId }), 5_000);
    } catch {
      // The engine may already have ended the turn; the notification still settles it.
    }
  }

  async resume(input?: ResumeInput): Promise<ResumeOutcome> {
    if (!input?.cursor) return { resumed: false, nativeSessionId: this.threadId, rebuilt: false };
    if (!this.rpc) throw new AgentTransportError(this.agentId, "app-server is not running");
    try {
      const result = await this.rpc.call("thread/resume", { threadId: input.cursor });
      this.threadId = readThreadId(result) ?? input.cursor;
      return { resumed: true, nativeSessionId: this.threadId, rebuilt: false };
    } catch {
      if (input.recoveryText === undefined) throw new AgentTransportError(this.agentId, "resume was refused");
      const start = await this.rpc.call("thread/start", threadStartParams({
        cwd: this.input.cwd ?? process.cwd(),
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      }));
      this.threadId = readThreadId(start);
      return { resumed: false, nativeSessionId: this.threadId, rebuilt: true };
    }
  }

  async cancel(): Promise<void> {
    if (this.settled) return;
    this.finish(false, "cancelled");
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalOutcome> {
    const ask = this.approvals.get(requestId);
    if (!ask || !this.rpc) return "unavailable";
    this.approvals.delete(requestId);
    if (ask.method === "item/tool/requestUserInput") {
      this.rpc.respond(ask.rpcId, { answers: decision.message ? { answer: decision.message } : {} });
    } else {
      this.rpc.respond(ask.rpcId, approvalResult(ask.method, decision.behavior === "allow"));
    }
    this.queue.push(this.emit(this.sessionId, this.turnId, {
      type: "approval.resolved", requestId, behavior: decision.behavior,
    }));
    return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
  }

  nativeTui(): NativeTuiDescriptor {
    return { command: "codex", args: [], env: { HOME: this.options.home } };
  }

  async close(): Promise<void> {
    if (!this.settled) await this.cancel();
    this.queue.close();
    // A closed session releases its process even when the turn had already ended.
    this.rpc?.dispose("session closed");
  }

  private finish(ok: boolean, stopReason: string): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.push(this.emit(this.sessionId, this.turnId, { type: "turn.completed", ok, stopReason }));
    this.queue.close();
    this.rpc?.dispose("turn ended");
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.push(this.emit(this.sessionId, this.turnId, { type: "error", message, terminal: true }));
    this.queue.push(this.emit(this.sessionId, this.turnId, { type: "turn.completed", ok: false, stopReason: "failed" }));
    this.queue.close();
    this.rpc?.dispose(message);
  }
}

function readThreadId(result: unknown): string | null {
  const thread = (result as { thread?: { id?: unknown } } | null)?.thread;
  return typeof thread?.id === "string" && thread.id ? thread.id : null;
}

function readTurnId(result: unknown): string | null {
  const turn = (result as { turn?: { id?: unknown } } | null)?.turn;
  return typeof turn?.id === "string" && turn.id ? turn.id : null;
}

/** A model picked for this session, kept as a ref so the billing identity stays separate. */
export function codexModel(model: ModelRef | undefined): string | undefined {
  return model?.modelId;
}
