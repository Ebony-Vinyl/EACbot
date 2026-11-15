import type { AgentDescriptor, AgentKind, ModelCatalogEntry } from "../../../packages/agent-protocol/agents.ts";
import type { CommandResult, MissionCommand } from "../../../packages/agent-protocol/commands.ts";
import type { MissionLogEntry } from "../../../packages/agent-protocol/events.ts";
import type { Mission, MissionTreeNode } from "../../../packages/agent-protocol/mission.ts";
import type { TerminalRef } from "../../../packages/agent-protocol/terminal.ts";
import { capabilitiesFor } from "../../missions/capabilities.ts";
import type {
  AgentCatalogPort,
  EnvironmentPort,
  EnvironmentSummary,
  EnvironmentTest,
  MissionPort,
  NewEnvironment,
  TerminalPort,
  TerminalStream,
  TerminalStreamHandler,
} from "../ports.ts";

export interface FakeMissionState {
  readonly missions: Map<string, Mission>;
  readonly tree: Map<string, MissionTreeNode>;
  readonly events: Map<string, MissionLogEntry[]>;
  readonly commands: MissionCommand[];
}

export class FakeMissionPort implements MissionPort {
  readonly state: FakeMissionState = { missions: new Map(), tree: new Map(), events: new Map(), commands: [] };
  /** Every call that arrived, including replays, so a test can prove a command
   * was deduplicated rather than never sent. */
  readonly attempts: MissionCommand[] = [];
  /** A scripted result per command id, so a test can decide what the authority
   * answered without running a real runtime. */
  readonly results = new Map<string, CommandResult>();
  failWith: Error | undefined;

  async execute(command: MissionCommand): Promise<CommandResult> {
    if (this.failWith) throw this.failWith;
    this.attempts.push(command);
    const stored = this.results.get(command.commandId);
    if (stored) return { ...stored, replayed: true };
    this.state.commands.push(command);
    const result = this.defaultResult(command);
    this.results.set(command.commandId, result);
    return result;
  }

  getMission(id: string): Mission | undefined {
    return this.state.missions.get(id);
  }

  listMissions(): Mission[] {
    return [...this.state.missions.values()];
  }

  missionTree(rootMissionId: string): MissionTreeNode | undefined {
    return this.state.tree.get(rootMissionId);
  }

  events(missionId: string, options: { sinceSeq?: number; limit?: number } = {}): MissionLogEntry[] {
    const all = this.state.events.get(missionId) ?? [];
    const since = options.sinceSeq ?? 0;
    return all.filter((entry) => entry.seq > since).slice(0, options.limit ?? 500);
  }

  private defaultResult(command: MissionCommand): CommandResult {
    return {
      commandId: command.commandId,
      type: command.type,
      missionId: "missionId" in command ? command.missionId : "mission-new",
      appliedAt: "2026-01-01T00:00:01.000Z",
      missionRevision: 2,
      replayed: false,
      ...("missionId" in command ? { runId: "run-1" } : {}),
    };
  }
}

export class FakeAgentCatalog implements AgentCatalogPort {
  readonly descriptors = new Map<AgentKind, AgentDescriptor>();
  readonly catalogs = new Map<AgentKind, ModelCatalogEntry[]>();

  constructor(kinds: readonly AgentKind[] = ["hermes", "custom"]) {
    for (const kind of kinds) {
      this.descriptors.set(kind, {
        kind,
        label: kind,
        authModes: ["subscription"],
        capabilities: capabilitiesFor(kind),
        models: [],
      });
    }
    this.catalogs.set("hermes", [{ ref: { agent: "hermes", model: "fake-1" }, contextWindow: 8_000 }]);
  }

  list(): AgentDescriptor[] {
    return [...this.descriptors.values()];
  }

  get(kind: AgentKind): AgentDescriptor | undefined {
    return this.descriptors.get(kind);
  }

  models(kind: AgentKind): ModelCatalogEntry[] | undefined {
    return this.catalogs.get(kind);
  }
}

export class FakeEnvironments implements EnvironmentPort {
  readonly items = new Map<string, EnvironmentSummary>();
  readonly tests = new Map<string, EnvironmentTest>();
  /** What the next check reports. Default: reachable, as a fake transport that
   * connected would. */
  checkResult: { reachable: boolean; latencyMs?: number; detail?: string } = { reachable: true, latencyMs: 5 };
  /** What the next create does instead of answering, so a test can prove a
   * refusal leaves nothing behind. */
  createFailure: Error | undefined;
  readonly created: NewEnvironment[] = [];
  readonly removed: string[] = [];
  #next = 0;

  list(): EnvironmentSummary[] {
    return [...this.items.values()];
  }

  get(id: string): EnvironmentSummary | undefined {
    return this.items.get(id);
  }

  async create(input: NewEnvironment): Promise<EnvironmentSummary> {
    this.created.push(input);
    if (this.createFailure) throw this.createFailure;
    this.#next += 1;
    const created: EnvironmentSummary = {
      id: `env-${this.#next}`,
      label: input.label,
      host: input.host,
      port: input.port ?? 22,
      user: input.user,
      hostKeyFingerprint: input.hostKeyFingerprint,
      status: "unknown",
    };
    this.items.set(created.id, created);
    return created;
  }

  async check(id: string): Promise<EnvironmentTest> {
    const result: EnvironmentTest = { ...this.checkResult, checkedAt: "2026-01-01T00:00:00.000Z" };
    this.tests.set(id, result);
    return result;
  }

  lastTest(id: string): EnvironmentTest | undefined {
    return this.tests.get(id);
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
    this.tests.delete(id);
    this.removed.push(id);
  }
}

export class FakeTerminals implements TerminalPort {
  readonly items = new Map<string, TerminalRef>();

  constructor(ids: readonly string[] = ["term-1"]) {
    for (const id of ids) {
      this.items.set(id, { id, kind: "pty", missionId: "mission-1", runId: "run-1", createdAt: "2026-01-01T00:00:00.000Z" });
    }
  }

  list(): TerminalRef[] {
    return [...this.items.values()];
  }

  get(id: string): TerminalRef | undefined {
    return this.items.get(id);
  }

  async start(input: Parameters<TerminalPort["start"]>[0]): Promise<TerminalRef> {
    const terminal: TerminalRef = {
      id: `term-started-${this.items.size + 1}`,
      kind: "nativeTui",
      missionId: input.missionId ?? "manual",
      runId: input.runId ?? "manual",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    this.items.set(terminal.id, terminal);
    return terminal;
  }
}

export interface FakeStream {
  readonly received: Uint8Array[];
  closed: boolean;
}

export class FakeTerminalStreams implements TerminalStreamHandler {
  readonly opened: { terminalId: string; sessionId: string; scope: string }[] = [];
  readonly streams: FakeStream[] = [];

  open(input: { terminalId: string; sessionId: string; scope: string }): TerminalStream {
    const stream: FakeStream = { received: [], closed: false };
    this.opened.push({ terminalId: input.terminalId, sessionId: input.sessionId, scope: input.scope });
    this.streams.push(stream);
    return {
      receive: (data) => stream.received.push(data),
      close: () => {
        stream.closed = true;
      },
    };
  }
}
