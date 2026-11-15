import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentSession,
  SessionCreateInput,
  SteerOutcome,
} from "../agents/contracts.ts";
import { EventQueue, eventFactory } from "../agents/events/queue.ts";

export interface FakeCoreScript {
  /** Text the session emits before it settles. */
  readonly deltas?: readonly string[];
  /** End the turn successfully after the deltas. */
  readonly complete?: boolean;
  /** Fail the turn instead of completing it. */
  readonly failWith?: string;
  /** Raise an approval before settling. */
  readonly approval?: { requestId: string; title: string; detail?: string };
  /** Emit a usage report before settling. */
  readonly usage?: { input: number; output: number };
  /** Leave the turn running: the test settles it with `session.emit`. */
  readonly holdOpen?: boolean;
  /** Close the event stream with this error instead of settling, so a test can
   * prove a broken transport becomes a typed run failure. */
  readonly breakStream?: string;
}

export const CORE_CAPABILITIES: AgentCapabilities = {
  steer: { kind: "native" },
  interrupt: true,
  resume: true,
  cancel: true,
  approvals: true,
  questions: true,
  images: true,
  usage: true,
  modelSwitch: "in-session",
  modelCatalog: "native",
  nativeTui: true,
};

/** A core/agents adapter with no model behind it. It implements exactly the
 * real contract, so a test that drives it proves the bridge rather than a
 * parallel fake of our own invention. */
export class FakeCoreSession implements AgentSession {
  readonly sessionId: string;
  readonly agentId: AgentSession["agentId"];
  nativeSessionId: string | null;
  private readonly queue = new EventQueue();
  private readonly make = eventFactory();
  private turnId: string | null = null;
  readonly steers: string[] = [];
  readonly scripts: FakeCoreScript[] = [];
  interrupts = 0;
  cancels = 0;
  closes = 0;
  readonly cursor: string | undefined;

  constructor(input: SessionCreateInput, agentId: AgentSession["agentId"], script: FakeCoreScript, cursor?: string) {
    this.sessionId = input.sessionId;
    this.agentId = agentId;
    this.cursor = cursor;
    this.nativeSessionId = cursor ?? null;
    this.scripts.push(script);
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  async steer(text: string): Promise<SteerOutcome> {
    this.steers.push(text);
    return "steered";
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    this.turnId = null;
    this.queue.push(this.make(this.sessionId, null, { type: "session.exited", reason: "interrupted" }));
  }

  async resume(input?: { cursor?: string; recoveryText?: string }): Promise<{ resumed: boolean; nativeSessionId: string | null; rebuilt: boolean }> {
    this.nativeSessionId = input?.cursor ?? this.nativeSessionId ?? `native-${this.sessionId}`;
    this.queue.push(this.make(this.sessionId, null, { type: "session.resumed", nativeSessionId: this.nativeSessionId }));
    return { resumed: true, nativeSessionId: this.nativeSessionId, rebuilt: false };
  }

  async cancel(): Promise<void> {
    this.cancels += 1;
    this.turnId = null;
    this.queue.push(this.make(this.sessionId, null, { type: "session.exited", reason: "cancelled" }));
    this.queue.close();
  }

  async respondApproval(): Promise<"allowed-once"> {
    return "allowed-once";
  }

  nativeTui() {
    return { command: "fake", args: [], env: {} };
  }

  async close(): Promise<void> {
    this.closes += 1;
    this.queue.close();
  }

  /** Starts the scripted turn. Called by the adapter's `create`, exactly as a
   * real adapter begins its first turn. */
  begin(script: FakeCoreScript): void {
    this.turnId = `turn-${this.sessionId}`;
    this.nativeSessionId ??= `native-${this.sessionId}`;
    this.queue.push(this.make(this.sessionId, this.turnId, { type: "session.started", nativeSessionId: this.nativeSessionId, model: null }));
    this.queue.push(this.make(this.sessionId, this.turnId, { type: "turn.started" }));
    if (script.holdOpen) return;
    this.runScript(script);
  }

  /** Settles a held-open turn on demand. */
  settle(script: FakeCoreScript = {}): void {
    this.runScript(script);
  }

  emit(event: Parameters<typeof this.make>[2]): void {
    this.queue.push(this.make(this.sessionId, this.turnId, event));
  }

  private runScript(script: FakeCoreScript): void {
    if (script.breakStream !== undefined) {
      this.queue.close(new Error(script.breakStream));
      return;
    }
    for (const text of script.deltas ?? []) {
      this.queue.push(this.make(this.sessionId, this.turnId, { type: "text.delta", text }));
    }
    if (script.approval) {
      this.queue.push(
        this.make(this.sessionId, this.turnId, {
          type: "approval.requested",
          requestId: script.approval.requestId,
          title: script.approval.title,
          ...(script.approval.detail !== undefined ? { detail: script.approval.detail } : {}),
        }),
      );
    }
    if (script.usage) {
      this.queue.push(this.make(this.sessionId, this.turnId, { type: "usage.updated", input: script.usage.input, output: script.usage.output }));
    }
    if (script.failWith !== undefined) {
      this.queue.push(this.make(this.sessionId, this.turnId, { type: "turn.completed", ok: false, stopReason: script.failWith }));
      return;
    }
    this.queue.push(this.make(this.sessionId, this.turnId, { type: "turn.completed", ok: true, stopReason: "end_turn" }));
  }
}

/** One fake core adapter. `create` either returns a session or throws, so a
 * test can prove a failed start is recorded rather than swallowed. */
export class FakeCoreAdapter implements AgentAdapter {
  readonly agentId: AgentAdapter["agentId"];
  readonly transport = "stdio-jsonl" as const;
  readonly capabilities: AgentCapabilities = CORE_CAPABILITIES;
  readonly sessions: FakeCoreSession[] = [];
  readonly inputs: SessionCreateInput[] = [];
  private script: FakeCoreScript = { complete: true };
  createError: Error | undefined;

  constructor(agentId: AgentAdapter["agentId"] = "hermes") {
    this.agentId = agentId;
  }

  /** The script the next `create` runs. */
  next(script: FakeCoreScript): this {
    this.script = script;
    return this;
  }

  failCreateWith(error: Error): this {
    this.createError = error;
    return this;
  }

  async create(input: SessionCreateInput): Promise<AgentSession> {
    if (this.createError) throw this.createError;
    this.inputs.push(input);
    const session = new FakeCoreSession(input, this.agentId, this.script, input.resumeCursor);
    this.sessions.push(session);
    session.begin(this.script);
    return session;
  }

  lastSession(): FakeCoreSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error("no session was created");
    return session;
  }
}
