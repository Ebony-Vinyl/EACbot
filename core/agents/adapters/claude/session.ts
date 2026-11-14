import { readFileSync } from "node:fs";
import type {
  AgentAdapter, AgentCapabilities, AgentEvent, AgentImage, AgentSession, ApprovalDecision, ApprovalOutcome,
  ModelRef, NativeTuiDescriptor, ResumeInput, ResumeOutcome, SessionCreateInput, SteerOutcome,
} from "../../contracts.ts";
import { AgentTransportError, UnsupportedCapabilityError } from "../../errors.ts";
import { eventFactory, EventQueue } from "../../events/queue.ts";
import { readJsonl, type Frame } from "../../transport/jsonl.ts";
import type { ChildLike, SpawnFn } from "../../transport/types.ts";
import { agentDescriptor, type AgentDescriptor } from "../../registry.ts";
import {
  claudeArgs, controlRequest, controlResponse, initSessionId, isResult, resultUsage, streamEventDelta, userFrame,
  type ClaudeControlRequest,
} from "./codec.ts";

export interface ClaudeAdapterOptions {
  spawn: SpawnFn;
  /** Instance HOME so a subscription login belongs to this instance alone. */
  home: string;
  cli?: string;
}

/** Claude Code over stream-json. One process per session: stdin stays open for steers and the
 * next turn, and `--resume` carries the CLI's own session id as the resume cursor. */
export class ClaudeAdapter implements AgentAdapter {
  readonly agentId = "claudeCode" as const;
  readonly transport = "stdio-stream-json" as const;
  readonly capabilities: AgentCapabilities;
  private readonly descriptor: AgentDescriptor;
  private readonly options: ClaudeAdapterOptions;

  constructor(options: ClaudeAdapterOptions) {
    this.options = options;
    this.descriptor = agentDescriptor("claudeCode");
    this.capabilities = this.descriptor.capabilities;
  }

  async create(input: SessionCreateInput): Promise<AgentSession> {
    return new ClaudeSession(this.descriptor, this.options, input).start();
  }
}

class ClaudeSession implements AgentSession {
  readonly agentId = "claudeCode" as const;
  readonly sessionId: string;
  private readonly descriptor: AgentDescriptor;
  private readonly options: ClaudeAdapterOptions;
  private readonly input: SessionCreateInput;
  private readonly emit = eventFactory();
  private readonly queue = new EventQueue();
  private readonly approvals = new Map<string, ClaudeControlRequest>();
  private child: ChildLike | null = null;
  private turnId: string | null = null;
  private nativeId: string | null = null;
  private settled = false;

  constructor(descriptor: AgentDescriptor, options: ClaudeAdapterOptions, input: SessionCreateInput) {
    this.descriptor = descriptor;
    this.options = options;
    this.input = input;
    this.sessionId = input.sessionId;
    this.nativeId = input.resumeCursor ?? null;
  }

  get nativeSessionId(): string | null {
    return this.nativeId;
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  async start(): Promise<this> {
    if (this.input.images?.length && !this.descriptor.capabilities.images) {
      throw new UnsupportedCapabilityError(this.agentId, "images");
    }
    const args = claudeArgs({
      ...(this.input.resumeCursor ? { resume: this.input.resumeCursor } : {}),
      ...(this.input.model ? { model: this.modelArg(this.input.model) } : {}),
      permissionMode: "default",
      ...(this.input.system ? { systemPrompt: this.input.system } : {}),
    });
    const child = this.options.spawn(this.options.cli ?? "claude", args, {
      env: { ...this.input.env, HOME: this.options.home },
      ...(this.input.cwd ? { cwd: this.input.cwd } : {}),
    });
    this.child = child;
    readJsonl(child.stdout, (frame) => this.onFrame(frame));
    child.on("error", (error) => this.fail(error.message));
    child.on("exit", (code, signal) => {
      if (!this.settled) this.fail(`process exited ${code ?? signal ?? "unknown"} before the result`);
    });

    this.turnId = `turn-${Date.now().toString(36)}`;
    this.queue.push(this.emit(this.sessionId, this.turnId, { type: "turn.started" }));
    try {
      this.write(userFrame(this.promptText(), this.readImages()));
    } catch (error) {
      // A prompt that never left the host must not leave a process behind holding the session.
      this.fail((error as Error).message);
      throw error;
    }
    return this;
  }

  private promptText(): string {
    return this.input.prompt;
  }

  private modelArg(model: ModelRef): string {
    return model.variant ? `${model.modelId}` : model.modelId;
  }

  private readImages(): Array<{ mime: string; base64: string }> {
    return (this.input.images ?? []).map((image: AgentImage) => ({
      mime: image.mime,
      base64: readFileSync(image.path).toString("base64"),
    }));
  }

  private write(frame: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin) throw new AgentTransportError(this.agentId, "process has no stdin");
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private onFrame(frame: Frame): void {
    const session = initSessionId(frame);
    if (session) {
      const resumed = this.nativeId !== null;
      this.nativeId = session;
      if (!resumed) {
        this.queue.push(this.emit(this.sessionId, this.turnId, {
          type: "session.started", nativeSessionId: session, model: this.input.model ?? null,
        }));
      }
      return;
    }
    const delta = streamEventDelta(frame);
    if (delta) {
      this.queue.push(this.emit(this.sessionId, this.turnId, {
        type: delta.kind === "text" ? "text.delta" : "reasoning.delta",
        text: delta.text,
      }));
      return;
    }
    const control = controlRequest(frame);
    if (control) {
      this.approvals.set(control.requestId, control);
      this.queue.push(this.emit(this.sessionId, this.turnId, control.kind === "question"
        ? {
            type: "question.requested",
            requestId: control.requestId,
            title: control.title,
            questions: [{ question: control.detail ?? control.title, options: [] }],
          }
        : {
            type: "approval.requested",
            requestId: control.requestId,
            title: control.title,
            ...(control.detail ? { detail: control.detail } : {}),
          }));
      return;
    }
    if (isResult(frame)) {
      const usage = resultUsage(frame);
      if (usage) {
        this.queue.push(this.emit(this.sessionId, this.turnId, { type: "usage.updated", ...usage }));
      }
      const ok = frame.is_error !== true && frame.subtype !== "error";
      // The CLI's own subtype is not a stop reason the caller can act on; a failed result is
      // reported as a failed turn, and a clean one keeps its native subtype.
      this.finish(ok, ok ? (typeof frame.subtype === "string" ? frame.subtype : "end_turn") : "failed");
      return;
    }
    if (frame.type === "assistant") {
      const message = frame.message as { content?: Array<{ type?: string; text?: string; name?: string; id?: string }> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          this.queue.push(this.emit(this.sessionId, this.turnId, { type: "text.delta", text: block.text }));
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          this.queue.push(this.emit(this.sessionId, this.turnId, {
            type: "tool.started", itemId: String(block.id ?? block.name), title: block.name,
          }));
        }
      }
    }
  }

  async steer(text: string): Promise<SteerOutcome> {
    if (this.settled || !this.child) return "refused";
    try {
      // A fresh uuid marks the words, so a `result` read while they are in flight can hold for them.
      this.write(userFrame(text, [], crypto.randomUUID()));
      return "steered";
    } catch {
      return "refused";
    }
  }

  async interrupt(): Promise<void> {
    if (this.settled) return;
    // Closing stdin ends the turn but keeps the session resumable through the native id.
    try {
      this.child?.stdin?.end();
    } catch {
      // Already closed.
    }
    this.finish(true, "interrupted");
  }

  async resume(input?: ResumeInput): Promise<ResumeOutcome> {
    if (!input?.cursor) return { resumed: false, nativeSessionId: this.nativeId, rebuilt: false };
    this.nativeId = input.cursor;
    return { resumed: true, nativeSessionId: input.cursor, rebuilt: false };
  }

  async cancel(): Promise<void> {
    if (this.settled) return;
    this.finish(false, "cancelled");
    this.child?.kill("SIGTERM");
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalOutcome> {
    const request = this.approvals.get(requestId);
    if (!request) return "unavailable";
    this.approvals.delete(requestId);
    const response = decision.behavior === "allow"
      ? { behavior: "allow", ...(decision.always ? { always: true } : {}) }
      : decision.behavior === "answer"
        ? { behavior: "allow", answer: decision.message ?? "" }
        : { behavior: "deny", message: decision.message ?? "Denied by the person" };
    this.write(controlResponse(requestId, response));
    this.queue.push(this.emit(this.sessionId, this.turnId, {
      type: "approval.resolved", requestId, behavior: decision.behavior,
    }));
    return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
  }

  nativeTui(): NativeTuiDescriptor {
    return { command: "claude", args: [], env: { HOME: this.options.home } };
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

  private finish(ok: boolean, stopReason: string): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.push(this.emit(this.sessionId, this.turnId, { type: "turn.completed", ok, stopReason }));
    this.queue.close();
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
