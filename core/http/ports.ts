import type { AgentDescriptor, AgentKind, ModelCatalogEntry } from "../../packages/agent-protocol/agents.ts";
import type { CommandResult, MissionCommand } from "../../packages/agent-protocol/commands.ts";
import type { MissionLogEntry } from "../../packages/agent-protocol/events.ts";
import type { Mission, MissionTreeNode } from "../../packages/agent-protocol/mission.ts";
import type { TerminalRef } from "../../packages/agent-protocol/terminal.ts";
import type { EnvironmentStatus } from "../environments/types.ts";

/** What the HTTP layer needs from the mission authority. Every mutation goes
 * through `execute`, which is where command ids, revisions and durable
 * acceptance already live: this layer owns no task state of its own. */
export interface MissionPort {
  execute(command: MissionCommand): Promise<CommandResult>;
  getMission(id: string): Mission | undefined;
  listMissions(): Mission[];
  missionTree(rootMissionId: string): MissionTreeNode | undefined;
  events(missionId: string, options?: { sinceSeq?: number; limit?: number }): MissionLogEntry[];
}

export interface AgentCatalogPort {
  list(): AgentDescriptor[];
  get(kind: AgentKind): AgentDescriptor | undefined;
  models(kind: AgentKind): ModelCatalogEntry[] | undefined;
}

export interface EnvironmentTest {
  readonly reachable: boolean;
  readonly latencyMs?: number;
  readonly detail?: string;
  readonly checkedAt: string;
}

/** The connection facts of one computer and the last observation recorded for
 * it. It carries no credential handle, no key material and no path to a private
 * key or to this application's data directory.
 *
 * `status` is the last observation that was persisted; it is not a claim about
 * the connection right now. A check this process has not run has no
 * `lastTest`, which is how a restart reports an unverified computer. */
export interface EnvironmentSummary {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyFingerprint?: string;
  readonly status: EnvironmentStatus;
  readonly lastSeen?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly revision?: number;
}

/** What a caller supplies to add a computer. Connection facts only: the id and
 * the dedicated known-hosts file are this application's to generate, and a
 * password or a private key has no field here to arrive in. */
export interface NewEnvironment {
  readonly label: string;
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  /** The fingerprint the person read off their own computer, as `SHA256:…` or
   * `MD5:…`. Nothing is pinned without one. */
  readonly hostKeyFingerprint: string;
}

/** Environments are user-owned SSH computers. `create` pins a host key and
 * probes the machine before it answers; `check` opens a connection through
 * whatever runner the port was built with. Neither may claim reachability it
 * did not observe. */
export interface EnvironmentPort {
  list(): EnvironmentSummary[];
  get(id: string): EnvironmentSummary | undefined;
  create(input: NewEnvironment): Promise<EnvironmentSummary>;
  check(id: string): Promise<EnvironmentTest>;
  lastTest(id: string): EnvironmentTest | undefined;
  /** Removes this application's record only. Nothing on the computer is
   * touched, because that data is the person's. */
  remove(id: string): Promise<void>;
}

export interface TerminalPort {
  list(): TerminalRef[];
  get(id: string): TerminalRef | undefined;
  /** Starts an agent's native TUI on a user-owned computer. A terminal the
   * service cannot start is a typed refusal, never an optimistic entry. */
  start(input: {
    environmentId: string;
    tool: "hermes" | "claude" | "codex" | "opencode" | "pi" | "omp";
    missionId?: string;
    runId?: string;
    cols?: number;
    rows?: number;
    name?: string;
  }): Promise<TerminalRef>;
}

export interface DuplexLike {
  write(chunk: Uint8Array | string): boolean;
  end(): void;
  destroy(error?: Error): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface TerminalStream {
  /** A frame the browser sent: keystrokes, a resize, a credit return. */
  receive(data: Uint8Array): void;
  close(): void;
}

/** A terminal stream, once a ticket has been accepted. The HTTP layer owns
 * authentication and the ticket; what a stream does with bytes belongs to the
 * terminal layer, which this module deliberately does not import. */
export interface TerminalStreamHandler {
  /** Called once per accepted upgrade, after the 101 handshake is written. */
  open(input: { terminalId: string; sessionId: string; scope: string; socket: DuplexLike }): TerminalStream;
}
