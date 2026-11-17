/** The native agent adapter contract. Every agent EACbot drives implements exactly this; a
 * capability an engine does not have is reported as `unsupported`, never emulated.
 *
 * `sessionId` is always the caller's own id. Native engines keep their own ids as resume
 * cursors, but no adapter treats a CLI-private session store as the conversation's identity. */

/** The agents this layer drives, named exactly as `packages/agent-protocol`'s `AgentKind` names
 * them, so no mapping table sits between the two. A person-configured ACP agent is `custom`. */
export type AgentId =
  | "hermes"
  | "claudeCode"
  | "codex"
  | "openCode"
  | "pi"
  | "ohMyPi"
  | "custom";

export type TransportKind = "stdio-jsonl" | "stdio-json-rpc" | "stdio-stream-json" | "http";

/** How an engine takes a message into a turn already running. `native` folds it into the live
 * turn; `next-boundary` only promises delivery at the engine's next step or tool boundary. */
export type SteerCapability =
  | { kind: "native" }
  | { kind: "next-boundary"; note: string }
  | { kind: "none"; reason: string };

export interface AgentCapabilities {
  steer: SteerCapability;
  /** Interrupt keeps a resumable native session; engines without it report unsupported. */
  interrupt: boolean;
  /** Resume a native session from the caller's cursor. */
  resume: boolean;
  /** A turn can be terminated outright, distinct from interrupt. */
  cancel: boolean;
  /** The engine raises approvals the caller answers. */
  approvals: boolean;
  /** The engine raises questions the caller answers. */
  questions: boolean;
  /** The engine accepts attached images in the prompt. */
  images: boolean;
  /** The engine reports its own token usage. */
  usage: boolean;
  /** The engine accepts a mid-turn model switch without a new session. */
  modelSwitch: "in-session" | "unsupported";
  /** How this engine's model catalog can be read. `none` means the engine has no catalog surface,
   * so a caller must be given the model rather than shown a list. */
  modelCatalog: "native" | "none";
  /** A fixed argv that launches the engine's own TUI in a terminal pane. */
  nativeTui: boolean;
}

export interface AgentImage {
  /** Absolute path the adapter reads; adapters that cannot take images refuse the turn. */
  path: string;
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface SessionCreateInput {
  /** The caller's conversation id; every event carries it back. */
  sessionId: string;
  /** The turn's text. A session starts by running one turn; steering is the only later input. */
  prompt: string;
  /** Working folder for the native process or HTTP session. */
  cwd?: string;
  /** Extra environment for this instance only, already vetted by `buildAgentEnv`. */
  env?: Record<string, string>;
  /** Model this session starts on, when the caller picked one. */
  model?: ModelRef;
  /** Resume cursor from a previous session of the same agent, when resuming. */
  resumeCursor?: string;
  /** Caller-chosen system prompt; adapters deliver it the engine's own way. */
  system?: string;
  images?: readonly AgentImage[];
  /** A caller-owned command id for an engine that can make creation idempotent. Hermes durably
   * reserves it and replays the original run on an identical retry; engines without such a
   * guarantee ignore it rather than pretending. */
  idempotencyKey?: string;
}

/** A provider/model pair kept separate from the billing identity that can serve it. */
export interface ModelRef {
  providerId: string;
  modelId: string;
  /** Engine-native variant or effort label, when the engine names one. */
  variant?: string;
}

export interface AgentEventBase {
  eventId: string;
  sessionId: string;
  turnId: string | null;
  at: string;
}

export type AgentEvent = AgentEventBase &
  (
    | { type: "session.started"; nativeSessionId: string | null; model: ModelRef | null; rebuilt?: boolean }
    | { type: "session.resumed"; nativeSessionId: string | null }
    | { type: "session.exited"; reason: string }
    | { type: "turn.started" }
    | { type: "text.delta"; text: string }
    | { type: "reasoning.delta"; text: string }
    | { type: "tool.started"; itemId: string; title: string; summary?: string }
    | { type: "tool.output"; itemId: string; text: string }
    | { type: "tool.completed"; itemId: string; ok: boolean; output?: string }
    | { type: "approval.requested"; requestId: string; title: string; detail?: string; choices?: string[] }
    | { type: "question.requested"; requestId: string; title: string; questions: AgentQuestion[] }
    | { type: "approval.resolved"; requestId: string; behavior: "allow" | "deny" | "answer" }
    | { type: "usage.updated"; input: number; output: number; cachedInput?: number }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason: string;
        /** Text the engine accepted but never delivered before the turn ended. */
        pendingSteer?: string;
      }
    | { type: "notice"; message: string }
    | { type: "error"; message: string; setup?: boolean; terminal?: boolean }
  );

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  question: string;
  header?: string;
  options: AgentQuestionOption[];
  multiple?: boolean;
  freeText?: boolean;
}

/** The outcome of handing text to a turn already running. Exactly three values.
 *
 * - `steered`: the engine admitted the text into the live run.
 * - `refused`: provably not delivered; the caller may queue it.
 * - `indeterminate`: maybe delivered; the caller must not re-queue it.
 *
 * `steered` says "the engine owns these words now", not "they changed the running step". An
 * engine whose `capabilities.steer.kind` is `next-boundary` (Hermes) admits the text into the live
 * run and delivers it at its next tool boundary; the capability kind is where that difference is
 * read, so no caller has to infer it from this value. */
export type SteerOutcome = "steered" | "refused" | "indeterminate";

export type ApprovalOutcome = "allowed-once" | "rejected" | "answered" | "unavailable";

export interface ApprovalDecision {
  behavior: "allow" | "deny" | "answer";
  message?: string;
  /** "Always allow this session": the engine's own remembered approval, when it has one. */
  always?: boolean;
}

export interface ResumeInput {
  /** Native cursor recorded from a previous session; absent starts fresh. */
  cursor?: string;
  /** The turn text replayed inline when the engine refused the cursor. */
  recoveryText?: string;
}

export interface ResumeOutcome {
  resumed: boolean;
  nativeSessionId: string | null;
  /** The engine refused the cursor and this session started new. */
  rebuilt: boolean;
}

/** The engine's own TUI, as a fixed argv a terminal pane can launch. */
export interface NativeTuiDescriptor {
  command: string;
  args: readonly string[];
  /** Instance HOME and model hints the TUI needs to open the same configuration. */
  env: Readonly<Record<string, string>>;
}

export interface AgentSession {
  readonly sessionId: string;
  readonly agentId: AgentId;
  /** The engine's own id for this conversation, once known. Never used as the caller's identity. */
  readonly nativeSessionId: string | null;
  events(): AsyncIterable<AgentEvent>;
  /** Send a message into the running turn. Resolves tri-state; never guesses delivery. */
  steer(text: string): Promise<SteerOutcome>;
  /** Stop the turn but keep the native session resumable. */
  interrupt(): Promise<void>;
  /** Reattach or continue a native session from a cursor. */
  resume(input?: ResumeInput): Promise<ResumeOutcome>;
  /** Terminate the turn and the native session. */
  cancel(): Promise<void>;
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<ApprovalOutcome>;
  nativeTui(): NativeTuiDescriptor;
  close(): Promise<void>;
}

export interface AgentAdapter {
  readonly agentId: AgentId;
  readonly transport: TransportKind;
  readonly capabilities: AgentCapabilities;
  create(input: SessionCreateInput): Promise<AgentSession>;
}
