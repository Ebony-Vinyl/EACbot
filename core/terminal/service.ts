/**
 * The production terminal service: one herdr-core connection per user-owned
 * computer, and a durable mapping from this application's terminal reference to
 * the core's native terminal address.
 *
 * A connection opens lazily, so composing this service never reaches a real
 * computer. A dropped line keeps the core's terminals alive; the service
 * reconnects, then asks the core what is still there and reports `resync` or
 * `exit` from that answer rather than assuming either.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { TerminalRef } from "../../packages/agent-protocol/terminal.ts";
import type { IdentityResolver } from "../environments/connect.ts";
import { TOOL_NAMES, type EnvironmentRecord, type ToolName } from "../environments/types.ts";
import { AttachStream, type AttachOptions } from "./attach.ts";
import { HcClient } from "./client.ts";
import { RpcError, TransportError } from "./protocol.ts";
import { HC_PROGRAM, localConnectPlan, sshConnectPlan, type SpawnPlan, type SshConnectConfig } from "./transport.ts";
import type { EventParams, InterruptResult, SendResult, Status, Terminal } from "./types.ts";
import { FrameKind, creditPayload } from "./wire.ts";

export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;

const DEFAULT_RECONNECT_DELAYS_MS = [250, 1_000, 4_000, 15_000];

export type TerminalServiceErrorCode =
  | "unknown_environment"
  | "unknown_terminal"
  | "unsupported_tool"
  | "missing_home"
  | "invalid_path"
  | "not_controller"
  | "closed";

export class TerminalServiceError extends Error {
  readonly code: TerminalServiceErrorCode;

  constructor(code: TerminalServiceErrorCode, message: string) {
    super(message);
    this.name = "TerminalServiceError";
    this.code = code;
  }
}

/** The part of an environment record this layer reads. `EnvironmentStore`
 * satisfies it; a test supplies a map. */
export interface EnvironmentLookup {
  get(id: string): EnvironmentRecord | null;
}

/** One terminal this application started, as it is remembered across restarts. */
export interface TerminalRefRecord {
  readonly id: string;
  readonly environmentId: string;
  /** The core's own terminal address, which is what every call takes. */
  readonly nativeId: string;
  /** The core's `created_ms`, so a reused address after a core restart is not
   * mistaken for the same program. */
  readonly createdMs: number;
  readonly tool: ToolName;
  readonly missionId: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly closedAt?: string;
  /** Why it ended, in the core's own words. */
  readonly reason?: string;
  readonly exitCode?: number;
  readonly labels?: Record<string, string>;
}

export interface TerminalRefStore {
  load(): TerminalRefRecord[];
  save(records: readonly TerminalRefRecord[]): void;
}

export class MemoryTerminalRefStore implements TerminalRefStore {
  #records: TerminalRefRecord[] = [];

  load(): TerminalRefRecord[] {
    return this.#records.map((record) => ({ ...record }));
  }

  save(records: readonly TerminalRefRecord[]): void {
    this.#records = records.map((record) => ({ ...record }));
  }
}

export interface HcClientFactoryInput {
  readonly plan: SpawnPlan;
  readonly config: SshConnectConfig;
  readonly environment: EnvironmentRecord;
}

/** Builds the client a connection rides. A test substitutes one whose spawner
 * speaks the protocol in memory. */
export type HcClientFactory = (input: HcClientFactoryInput) => HcClient;

export interface TerminalServiceOptions {
  readonly environments: EnvironmentLookup;
  readonly refs?: TerminalRefStore;
  /** Resolves a record's credential reference into a key path for this call
   * only. The path is never persisted. */
  readonly identity?: IdentityResolver;
  readonly client?: HcClientFactory;
  readonly now?: () => string;
  readonly id?: () => string;
  /** Delays before each reconnect attempt, the last one repeating. */
  readonly reconnectDelaysMs?: readonly number[];
  readonly requestTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface TerminalServiceEvents {
  title: [{ terminalId: string; title: string }];
  status: [{ terminalId: string; status: Status | null }];
  /** The program ended, or the core lost it. `reason` is the core's own word. */
  exit: [{ terminalId: string; reason: string; exitCode: number | null }];
  /** The line came back and the viewer must attach again for a fresh paint. */
  resync: [{ terminalId: string; reason: string }];
}

export interface StartTerminalInput {
  readonly args?: readonly string[];
  readonly environmentId: string;
  readonly tool: ToolName;
  readonly missionId: string;
  readonly runId: string;
  readonly cols?: number;
  readonly rows?: number;
  /** Defaults to the environment's own home directory. */
  readonly cwd?: string;
  /** The instance's HOME, so two engines never share config. Defaults to the
   * environment's home directory. */
  readonly home?: string;
  readonly name?: string;
  readonly labels?: Record<string, string>;
}

export interface AttachTerminalInput {
  readonly terminalId: string;
  /** Stable per browser session and terminal; it is the control lease's holder. */
  readonly viewerId: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly observe?: boolean;
  readonly history?: number;
  /** Credit the viewer returns for bytes it consumed. When set, this process
   * never acknowledges output on the viewer's behalf: a viewer that stops
   * reading stops the core instead of growing a buffer here. */
  readonly creditViewer?: boolean;
}

export interface TerminalAttachment {
  readonly terminalId: string;
  readonly viewerId: string;
  readonly stream: AttachStream;
  readonly terminal: Terminal;
  readonly canControl: boolean;
  readonly cols: number;
  readonly rows: number;
  /** Returns consumed bytes to the core. Only meaningful with
   * `creditViewer`, where the viewer is the one that knows what it consumed. */
  credit(bytes: number): Promise<void>;
}

interface Session {
  readonly environmentId: string;
  readonly environment: EnvironmentRecord;
  client: HcClient;
  connected: boolean;
  connecting: Promise<HcClient> | null;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  /** Bumped whenever the client is replaced, so a late event from an old one
   * is ignored instead of closing the new connection's state. */
  generation: number;
  /** A session that never came up is not retried in the background: its error
   * belongs to the caller that asked for it. */
  everConnected: boolean;
}

/** The ssh settings a record implies. The identity file's path exists for this
 * call only; `sshConnectPlan` refuses anything that would stop verifying the
 * host key. */
export function sshConfigForEnvironment(record: EnvironmentRecord, identity?: IdentityResolver): SshConnectConfig {
  const resolved = record.identityFileRef !== null && identity ? identity(record.identityFileRef) : null;
  // The environment installer places the core under `~/.eacbot-env/bin`, which
  // a non-interactive SSH command does not have on PATH. The probe reported the
  // home, so the plan names that exact program instead of searching.
  const home = record.capabilities.homeDir;
  const program = home === null || home === "" ? undefined : `${home.replace(/\/+$/, "")}/.eacbot-env/bin/${HC_PROGRAM}`;
  return {
    host: record.host,
    user: record.user,
    port: record.port,
    knownHostsFile: record.knownHostsFile,
    hostKeyFingerprint: record.hostKeyFingerprint,
    identityFile: resolved,
    ...(program !== undefined ? { program } : {}),
  };
}

/** A lease holder is one viewer on one terminal, so two terminals of the same
 * browser session never share control. */
export function viewerLeaseId(viewerId: string, terminalId: string): string {
  return `${viewerId}@${terminalId}`;
}

/**
 * The viewer returns credit, not this process: batching here would acknowledge
 * bytes the browser has not drawn, and a viewer that stops reading must stall
 * the core rather than grow a buffer on this side.
 */
const VIEWER_RETURNS_CREDIT = Number.MAX_SAFE_INTEGER;

/** The error code a browser is told about. A core error keeps its own `kind`,
 * which is the stable taxonomy this layer branches on. */
export function terminalErrorCode(error: unknown): string {
  if (error instanceof RpcError) return error.kind;
  if (error instanceof TerminalServiceError) return error.code;
  if (error instanceof TransportError) return "transport";
  return "internal";
}

export class TerminalService extends EventEmitter<TerminalServiceEvents> {
  readonly #environments: EnvironmentLookup;
  readonly #refs: TerminalRefStore;
  readonly #identity: IdentityResolver | undefined;
  readonly #clientFactory: HcClientFactory;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #delays: readonly number[];
  readonly #log: (line: string) => void;
  readonly #sessions = new Map<string, Session>();
  readonly #records = new Map<string, TerminalRefRecord>();
  readonly #native = new Map<string, string>();
  readonly #attachments = new Map<string, Set<TerminalAttachment>>();
  #closed = false;

  constructor(options: TerminalServiceOptions) {
    super();
    this.#environments = options.environments;
    this.#refs = options.refs ?? new MemoryTerminalRefStore();
    this.#identity = options.identity;
    this.#clientFactory = options.client ?? defaultClientFactory(options.requestTimeoutMs);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.id ?? randomUUID;
    this.#delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.#log = options.log ?? (() => {});
    for (const record of this.#refs.load()) this.#remember(record);
  }

  list(): TerminalRef[] {
    return [...this.#records.values()].map(toTerminalRef);
  }

  get(terminalId: string): TerminalRef | undefined {
    const record = this.#records.get(terminalId);
    return record === undefined ? undefined : toTerminalRef(record);
  }

  /**
   * Starts an agent TUI. The argv is exactly the tool's own name: this layer
   * never composes a shell line, so there is nothing here a caller's text can
   * turn into a second command.
   */
  async start(input: StartTerminalInput): Promise<TerminalRef> {
    this.#assertOpen();
    if (!(TOOL_NAMES as readonly string[]).includes(input.tool)) {
      throw new TerminalServiceError("unsupported_tool", `${JSON.stringify(input.tool)} is not one of ${TOOL_NAMES.join(", ")}`);
    }
    const environment = this.#environments.get(input.environmentId);
    if (!environment) {
      throw new TerminalServiceError("unknown_environment", `no environment ${input.environmentId}`);
    }
    const home = input.home ?? environment.capabilities.homeDir;
    if (home === null || home === "") {
      throw new TerminalServiceError(
        "missing_home",
        `environment ${environment.id} has not reported its home directory; check it before starting a terminal`,
      );
    }
    assertRemotePath(home, "home directory");
    const cwd = input.cwd ?? home;
    assertRemotePath(cwd, "working directory");

    const client = await this.#connect(environment.id);
    const labels = { ...input.labels, eacbot: "terminal", environment: environment.id };
    const result = await client.run({
      argv: [environment.kind === "local" ? environment.tools.find((tool) => tool.name === input.tool && tool.status === "installed")?.path ?? input.tool : input.tool, ...(input.args ?? [])],
      cwd,
      size: { cols: input.cols ?? DEFAULT_TERMINAL_COLS, rows: input.rows ?? DEFAULT_TERMINAL_ROWS },
      // A non-interactive remote command has no login profile. The agent
      // installers put their executables under these home folders, and the
      // system binaries stay reachable as the last resort.
      env: {
        HOME: home,
        PATH: environment.kind === "local" ? process.env.PATH ?? "" : `${home.replace(/\/+$/, "")}/.local/bin:${home.replace(/\/+$/, "")}/.eacbot-env/bin:${home.replace(/\/+$/, "")}/.eacbot-env/npm/bin:/usr/local/bin:/usr/bin:/bin`,
      },
      labels,
      ...(input.name !== undefined ? { name: input.name } : {}),
    });

    const record: TerminalRefRecord = {
      id: this.#newId(),
      environmentId: environment.id,
      nativeId: result.address,
      createdMs: result.created_ms,
      tool: input.tool,
      missionId: input.missionId,
      runId: input.runId,
      createdAt: this.#now(),
      labels,
    };
    this.#remember(record);
    this.#save();
    return toTerminalRef(record);
  }

  /** Opens a viewer's stream. A second controller takes control from the
   * first, which keeps its stream and may only watch from then on. */
  async attach(input: AttachTerminalInput): Promise<TerminalAttachment> {
    const record = this.#requireRecord(input.terminalId);
    if (record.closedAt !== undefined) {
      throw new TerminalServiceError("closed", `terminal ${record.id} has ended`);
    }
    const client = await this.#connect(record.environmentId);
    const cols = input.cols ?? DEFAULT_TERMINAL_COLS;
    const rows = input.rows ?? DEFAULT_TERMINAL_ROWS;
    const leaseId = viewerLeaseId(input.viewerId, record.id);
    const options: AttachOptions = {
      terminal: record.nativeId,
      cols,
      rows,
      history: input.history ?? 0,
      observe: input.observe ?? false,
      leaseId,
      ...(input.creditViewer === true ? { creditBatch: VIEWER_RETURNS_CREDIT } : {}),
    };
    const stream = await client.attach(options);
    const terminal = stream.result?.terminal;
    if (!terminal) {
      await stream.detach();
      throw new TransportError(`the core attached ${record.nativeId} without saying what it is`);
    }
    const attachment: TerminalAttachment = {
      terminalId: record.id,
      viewerId: input.viewerId,
      stream,
      terminal,
      canControl: client.lease.canControl(leaseId),
      cols,
      rows,
      credit: async (bytes: number): Promise<void> => {
        const channel = stream.channel;
        if (channel === null || bytes <= 0) return;
        await client.connection.sendFrame(channel, FrameKind.CREDIT, creditPayload(bytes));
      },
    };
    const viewers = this.#attachments.get(record.id) ?? new Set<TerminalAttachment>();
    viewers.add(attachment);
    this.#attachments.set(record.id, viewers);
    const forget = (): void => {
      viewers.delete(attachment);
      if (viewers.size === 0) this.#attachments.delete(record.id);
    };
    stream.once("close", forget);
    stream.once("lost", forget);
    return attachment;
  }

  /** Resizes through whichever viewer holds control, which is the only size
   * the core accepts. */
  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const attachment = this.#controllerFor(terminalId);
    if (!attachment) {
      throw new TerminalServiceError("not_controller", `no viewer holds control of terminal ${terminalId}`);
    }
    await attachment.stream.resize(cols, rows);
  }

  async inspect(terminalId: string): Promise<Terminal> {
    const record = this.#requireRecord(terminalId);
    return (await this.#connect(record.environmentId)).get(record.nativeId);
  }

  async send(terminalId: string, text: string, options: { caller?: string | null; force?: boolean } = {}): Promise<SendResult> {
    const record = this.#requireRecord(terminalId);
    const client = await this.#connect(record.environmentId);
    return client.send({
      terminal: record.nativeId,
      text,
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(options.caller !== undefined ? { caller: options.caller } : {}),
    });
  }

  async interrupt(terminalId: string, timeout?: number): Promise<InterruptResult> {
    const record = this.#requireRecord(terminalId);
    const client = await this.#connect(record.environmentId);
    return client.interrupt(record.nativeId, timeout);
  }

  async kill(terminalId: string): Promise<TerminalRef> {
    const record = this.#requireRecord(terminalId);
    const client = await this.#connect(record.environmentId);
    const terminal = await client.kill(record.nativeId);
    this.#finish(record, terminal.reason ?? "killed", terminal.exit_code ?? null);
    return toTerminalRef(this.#requireRecord(terminalId));
  }

  async detach(terminalId: string, viewerId: string): Promise<void> {
    const viewers = this.#attachments.get(terminalId);
    if (!viewers) return;
    for (const attachment of Array.from(viewers)) {
      if (attachment.viewerId === viewerId) await attachment.stream.detach();
    }
  }

  /** Closes every connection. The core's own terminals are left alone, so a
   * restart of this process reattaches rather than losing them. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of this.#sessions.values()) {
      session.closed = true;
      if (session.timer !== null) clearTimeout(session.timer);
      session.timer = null;
      try {
        session.client.close();
      } catch {
        // A client that already lost its line has nothing left to close.
      }
    }
    this.#sessions.clear();
    this.#attachments.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new TerminalServiceError("closed", "the terminal service is closed");
  }

  #requireRecord(terminalId: string): TerminalRefRecord {
    const record = this.#records.get(terminalId);
    if (!record) throw new TerminalServiceError("unknown_terminal", `no terminal ${terminalId}`);
    return record;
  }

  #remember(record: TerminalRefRecord): void {
    this.#records.set(record.id, record);
    this.#native.set(nativeKey(record.environmentId, record.nativeId), record.id);
  }

  #recordFor(environmentId: string, nativeId: string): TerminalRefRecord | undefined {
    const id = this.#native.get(nativeKey(environmentId, nativeId));
    return id === undefined ? undefined : this.#records.get(id);
  }

  #save(): void {
    try {
      this.#refs.save([...this.#records.values()]);
    } catch (error) {
      this.#log(`cannot persist terminal references: ${describe(error)}`);
    }
  }

  #finish(record: TerminalRefRecord, reason: string, exitCode: number | null): void {
    if (record.closedAt !== undefined) return;
    const updated: TerminalRefRecord = {
      ...record,
      closedAt: this.#now(),
      reason,
      ...(exitCode !== null ? { exitCode } : {}),
    };
    this.#remember(updated);
    this.#save();
    this.emit("exit", { terminalId: updated.id, reason, exitCode });
  }

  #controllerFor(terminalId: string): TerminalAttachment | null {
    for (const attachment of this.#attachments.get(terminalId) ?? []) {
      if (attachment.stream.role === "control") return attachment;
    }
    return null;
  }

  #session(environmentId: string): Session {
    const existing = this.#sessions.get(environmentId);
    if (existing) return existing;
    const environment = this.#environments.get(environmentId);
    if (!environment) {
      throw new TerminalServiceError("unknown_environment", `no environment ${environmentId}`);
    }
    const session: Session = {
      environmentId,
      environment,
      client: this.#createClient(environment),
      connected: false,
      connecting: null,
      attempt: 0,
      timer: null,
      closed: false,
      generation: 0,
      everConnected: false,
    };
    this.#sessions.set(environmentId, session);
    return session;
  }

  #createClient(environment: EnvironmentRecord): HcClient {
    const config = sshConfigForEnvironment(environment, this.#identity);
    const plan = environment.kind === "local" ? localConnectPlan() : sshConnectPlan(config);
    return this.#clientFactory({ plan, config, environment });
  }

  #recreateClient(session: Session): void {
    session.generation += 1;
    try {
      session.client = this.#createClient(session.environment);
    } catch (error) {
      this.#log(`cannot prepare a new connection to ${session.environment.label}: ${describe(error)}`);
    }
  }

  async #connect(environmentId: string): Promise<HcClient> {
    this.#assertOpen();
    const session = this.#session(environmentId);
    if (session.connected) return session.client;
    if (session.connecting) return session.connecting;

    const client = session.client;
    const generation = session.generation;
    const connecting = (async (): Promise<HcClient> => {
      try {
        await client.connect({
          framed: true,
          features: ["attach", "events"],
          core: { id: "eacbot-core", name: "EACbot" },
        });
        client.on("event", (event) => {
          if (session.generation === generation) this.#onEvent(environmentId, event);
        });
        client.on("disconnected", (error) => {
          if (session.generation === generation) this.#onDisconnected(session, error);
        });
        await client.subscribe({});
      } catch (error) {
        client.close();
        if (session.generation === generation) this.#recreateClient(session);
        throw error;
      }
      session.connected = true;
      session.everConnected = true;
      session.attempt = 0;
      return client;
    })();
    session.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (session.connecting === connecting) session.connecting = null;
    }
  }

  #onDisconnected(session: Session, error: TransportError | null): void {
    if (this.#closed || session.closed) return;
    session.connected = false;
    session.connecting = null;
    this.#log(`the connection to ${session.environment.label} ended: ${error?.message ?? "closed"}`);
    const client = session.client;
    this.#recreateClient(session);
    try {
      client.close();
    } catch {
      // Already closed by the failed line.
    }
    this.#scheduleReconnect(session);
  }

  #scheduleReconnect(session: Session): void {
    // A session that never came up reports its failure to whoever asked for
    // it; retrying in the background would hide that error and reach a
    // computer nobody asked about again.
    if (this.#closed || session.closed || session.timer !== null || !session.everConnected) return;
    const at = Math.min(session.attempt, this.#delays.length - 1);
    const delay = this.#delays[at] ?? 0;
    session.attempt += 1;
    const timer = setTimeout(() => {
      session.timer = null;
      void this.#reconnect(session);
    }, delay);
    timer.unref?.();
    session.timer = timer;
  }

  async #reconnect(session: Session): Promise<void> {
    if (this.#closed || session.closed) return;
    try {
      await this.#connect(session.environmentId);
    } catch (error) {
      this.#log(`reconnecting to ${session.environment.label} failed: ${describe(error)}`);
      this.#scheduleReconnect(session);
      return;
    }
    await this.#reconcile(session);
  }

  /**
   * What the core still has, after a dropped line. A terminal that is gone is
   * reported as an exit; one that is live gets a resync so its viewers attach
   * again. Nothing is invented: a core that lost a terminal says so by not
   * listing it.
   */
  async #reconcile(session: Session): Promise<void> {
    const client = session.client;
    for (const record of Array.from(this.#records.values())) {
      if (record.environmentId !== session.environmentId || record.closedAt !== undefined) continue;
      let terminal: Terminal;
      try {
        terminal = await client.get(record.nativeId);
      } catch (error) {
        if (error instanceof RpcError && (error.kind === "not_found" || error.kind === "finished")) {
          this.#finish(record, "lost", null);
          continue;
        }
        this.#log(`cannot read ${record.nativeId} after reconnecting: ${describe(error)}`);
        this.emit("resync", { terminalId: record.id, reason: "reconnected" });
        continue;
      }
      if (terminal.created_ms !== record.createdMs) {
        this.#finish(record, "lost", null);
        continue;
      }
      if (terminal.state !== "live") {
        this.#finish(record, terminal.reason ?? "exited", terminal.exit_code ?? null);
        continue;
      }
      this.emit("resync", { terminalId: record.id, reason: "reconnected" });
    }
  }

  #onEvent(environmentId: string, event: EventParams): void {
    const address = event.terminal;
    if (address === undefined) return;
    const record = this.#recordFor(environmentId, address);
    if (!record) return;
    switch (event.type) {
      case "title": {
        const data = event.data as { title?: unknown };
        this.emit("title", { terminalId: record.id, title: String(data.title ?? "") });
        return;
      }
      case "status": {
        const data = event.data as { status?: Status | null };
        this.emit("status", { terminalId: record.id, status: data.status ?? null });
        return;
      }
      case "finished": {
        const data = event.data as { reason?: string; exit_code?: number | null };
        this.#finish(record, data.reason ?? "exited", data.exit_code ?? null);
        return;
      }
      case "lost": {
        const data = event.data as { reason?: string; exit_code?: number | null };
        this.#finish(record, data.reason ?? "lost", data.exit_code ?? null);
        return;
      }
      case "removed": {
        this.#finish(record, "removed", null);
        return;
      }
      default:
        return;
    }
  }
}

function defaultClientFactory(requestTimeoutMs?: number): HcClientFactory {
  return ({ plan, config, environment }) =>
    new HcClient({
      plan,
      transport: environment.kind === "local" ? { kind: "local" } : { kind: "ssh", ...config },
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    });
}

function toTerminalRef(record: TerminalRefRecord): TerminalRef {
  return {
    id: record.id,
    kind: "nativeTui",
    missionId: record.missionId,
    runId: record.runId,
    createdAt: record.createdAt,
    ...(record.closedAt !== undefined ? { closedAt: record.closedAt } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
  };
}

function nativeKey(environmentId: string, nativeId: string): string {
  return `${environmentId}\u0000${nativeId}`;
}

/** The remote computer is Linux, so a working directory is a POSIX path. A
 * guessed one would be acted on, so a bad one is refused here. */
function assertRemotePath(value: string, what: string): void {
  if (!value.startsWith("/")) {
    throw new TerminalServiceError("invalid_path", `the ${what} must be an absolute POSIX path, got ${JSON.stringify(value)}`);
  }
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      throw new TerminalServiceError("invalid_path", `the ${what} contains a control character`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
