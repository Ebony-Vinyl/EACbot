import type {
  AgentAdapter, AgentCapabilities, AgentEvent, AgentSession, ApprovalDecision, ApprovalOutcome, NativeTuiDescriptor,
  ResumeInput, ResumeOutcome, SessionCreateInput, SteerOutcome,
} from "../../contracts.ts";
import { AgentTransportError, UnsupportedCapabilityError } from "../../errors.ts";
import { eventFactory, EventQueue } from "../../events/queue.ts";
import { JsonRpcPeer } from "../../transport/rpc.ts";
import type { SpawnFn } from "../../transport/types.ts";
import { agentDescriptor, type AgentDescriptor } from "../../registry.ts";

/** ACP's session/prompt request and the update notifications it streams back. */
export interface AcpAdapterOptions {
  spawn: SpawnFn;
  /** The agent's executable and the argv that starts its ACP server. */
  command: string;
  args: readonly string[];
  home: string;
}

/** A custom Agent Client Protocol agent. ACP has no steering method, so `steer` is a typed
 * `unsupported` here rather than an interrupt dressed up as one. */
export class CustomAcpAdapter implements AgentAdapter {
  readonly agentId = "custom" as const;
  readonly transport = "stdio-json-rpc" as const;
  readonly capabilities: AgentCapabilities;
  private readonly descriptor: AgentDescriptor;
  private readonly options: AcpAdapterOptions;

  constructor(options: AcpAdapterOptions) {
    this.options = options;
    this.descriptor = agentDescriptor("custom");
    this.capabilities = this.descriptor.capabilities;
  }

  async create(input: SessionCreateInput): Promise<AgentSession> {
    return new AcpSession(this.descriptor, this.options, input).start();
  }
}

class AcpSession implements AgentSession {
  readonly agentId = "custom" as const;
  readonly sessionId: string;
  private readonly options: AcpAdapterOptions;
  private readonly input: SessionCreateInput;
  private readonly emit = eventFactory();
  private readonly queue = new EventQueue();
  private readonly approvals = new Map<string, unknown>();
  private rpc: JsonRpcPeer | null = null;
  private nativeId: string | null = null;
  private settled = false;
  private cancelled = false;

  constructor(_descriptor: AgentDescriptor, options: AcpAdapterOptions, input: SessionCreateInput) {
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
    const child = this.options.spawn(this.options.command, [...this.options.args], {
      env: { ...this.input.env, HOME: this.options.home },
      ...(this.input.cwd ? { cwd: this.input.cwd } : {}),
    });
    const rpc = new JsonRpcPeer(this.agentId, child, {
      agentId: this.agentId,
      onNotification: (frame) => this.notification(frame),
      onRequest: (frame) => this.serverRequest(frame),
      onExit: (code, signal) => {
        if (!this.settled) this.fail(`agent exited ${code ?? signal ?? "unknown"}`);
      },
    });
    this.rpc = rpc;

    try {
      await rpc.call("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      const created = await rpc.call("session/new", {
        cwd: this.input.cwd ?? process.cwd(),
        mcpServers: [],
      });
      const sessionId = (created as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId !== "string" || !sessionId) throw new AgentTransportError(this.agentId, "agent returned no session id");
      this.nativeId = sessionId;
    } catch (error) {
      // A handshake that failed after the process started must not leave it running.
      this.fail((error as Error).message);
      throw error;
    }
    this.queue.push(this.emit(this.sessionId, null, {
      type: "session.started", nativeSessionId: this.nativeId, model: this.input.model ?? null,
    }));
    this.queue.push(this.emit(this.sessionId, null, { type: "turn.started" }));
    void rpc.call("session/prompt", {
      sessionId: this.nativeId,
      prompt: [{ type: "text", text: this.promptText() }],
    }, 0).then(
      (result) => {
        const stopReason = (result as { stopReason?: unknown } | null)?.stopReason;
        this.finish(!this.cancelled, typeof stopReason === "string" ? stopReason : "end_turn");
      },
      (error: Error) => {
        if (this.settled) return;
        this.fail(error.message);
      },
    );
    return this;
  }

  private promptText(): string {
    return this.input.system ? `${this.input.system}\n\n${this.input.prompt}` : this.input.prompt;
  }

  private notification(frame: Record<string, unknown>): void {
    if (frame.method !== "session/update") return;
    const params = (frame.params ?? {}) as { update?: Record<string, unknown> };
    const update = params.update ?? {};
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          this.queue.push(this.emit(this.sessionId, null, { type: "text.delta", text: content.text }));
        }
        return;
      }
      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          this.queue.push(this.emit(this.sessionId, null, { type: "reasoning.delta", text: content.text }));
        }
        return;
      }
      case "tool_call": {
        this.queue.push(this.emit(this.sessionId, null, {
          type: "tool.started",
          itemId: String(update.toolCallId ?? ""),
          title: String(update.title ?? "tool"),
        }));
        return;
      }
      case "tool_call_update": {
        if (update.status !== "completed" && update.status !== "failed") return;
        this.queue.push(this.emit(this.sessionId, null, {
          type: "tool.completed",
          itemId: String(update.toolCallId ?? ""),
          ok: update.status === "completed",
        }));
        return;
      }
      default:
        return;
    }
  }

  private serverRequest(frame: Record<string, unknown>): void {
    if (frame.method !== "session/request_permission") {
      // Fail closed: an ACP request this adapter does not implement is never auto-approved.
      this.rpc?.respondError(frame.id, -32601, `unsupported request: ${String(frame.method)}`);
      return;
    }
    const params = (frame.params ?? {}) as { toolCall?: { title?: unknown }; options?: Array<{ optionId?: unknown; kind?: unknown }> };
    const requestId = `acp-${String(frame.id)}`;
    this.approvals.set(requestId, frame.id);
    this.queue.push(this.emit(this.sessionId, null, {
      type: "approval.requested",
      requestId,
      title: String(params.toolCall?.title ?? "permission"),
      ...(Array.isArray(params.options)
        ? { choices: params.options.map((option) => String(option.kind ?? option.optionId ?? "")) }
        : {}),
    }));
  }

  async steer(): Promise<SteerOutcome> {
    // ACP has no mid-turn input channel. Returning "refused" would tell the caller to queue the
    // words, which would be right; but a silent refusal would hide that the capability is absent.
    throw new UnsupportedCapabilityError(this.agentId, "steer", "ACP has no mid-turn input method");
  }

  async interrupt(): Promise<void> {
    if (this.settled || !this.rpc || !this.nativeId) return;
    try {
      await this.rpc.notify("session/cancel", { sessionId: this.nativeId });
    } catch {
      // The agent may already have ended the turn.
    }
  }

  async resume(input?: ResumeInput): Promise<ResumeOutcome> {
    if (!input?.cursor) return { resumed: false, nativeSessionId: this.nativeId, rebuilt: false };
    if (!this.rpc) throw new AgentTransportError(this.agentId, "agent is not running");
    const loaded = await this.rpc.call("session/load", { sessionId: input.cursor, cwd: this.input.cwd ?? process.cwd(), mcpServers: [] });
    const id = (loaded as { sessionId?: unknown } | null)?.sessionId;
    this.nativeId = typeof id === "string" && id ? id : input.cursor;
    return { resumed: true, nativeSessionId: this.nativeId, rebuilt: false };
  }

  async cancel(): Promise<void> {
    if (this.settled) return;
    this.cancelled = true;
    await this.interrupt();
    this.finish(false, "cancelled");
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalOutcome> {
    const rpcId = this.approvals.get(requestId);
    if (rpcId === undefined || !this.rpc) return "unavailable";
    this.approvals.delete(requestId);
    this.rpc.respond(rpcId, {
      outcome: decision.behavior === "allow" ? { outcome: "selected", optionId: "allow_once" } : { outcome: "cancelled" },
    });
    this.queue.push(this.emit(this.sessionId, null, {
      type: "approval.resolved", requestId, behavior: decision.behavior,
    }));
    return decision.behavior === "allow" ? "allowed-once" : "rejected";
  }

  nativeTui(): NativeTuiDescriptor {
    throw new UnsupportedCapabilityError(this.agentId, "nativeTui", "this agent was configured without a TUI command");
  }

  async close(): Promise<void> {
    if (!this.settled) await this.cancel();
    this.queue.close();
    // A session that is closed releases its agent process even when the turn had already ended.
    this.rpc?.dispose("session closed");
  }

  private finish(ok: boolean, stopReason: string): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.push(this.emit(this.sessionId, null, { type: "turn.completed", ok, stopReason }));
    this.queue.close();
    this.rpc?.dispose("turn ended");
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.push(this.emit(this.sessionId, null, { type: "error", message, terminal: true }));
    this.queue.push(this.emit(this.sessionId, null, { type: "turn.completed", ok: false, stopReason: "failed" }));
    this.queue.close();
    this.rpc?.dispose(message);
  }
}
