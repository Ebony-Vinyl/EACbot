/**
 * Composing the terminal layer for the HTTP server: the `TerminalPort` the
 * REST routes read, the `TerminalStreamHandler` a WebSocket upgrade hands its
 * socket to, and the durable map from this application's terminal id to the
 * core's own address.
 *
 * Building this composition opens no connection. A client is created per
 * environment when a call first needs one, so starting the server never
 * reaches a user's computer and a test never spawns ssh.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import type { TerminalPort, TerminalStreamHandler } from "../http/ports.ts";
import type { IdentityResolver } from "../environments/connect.ts";
import { TOOL_NAMES, type ToolName } from "../environments/types.ts";
import { TransportError } from "./protocol.ts";
import {
  TerminalService,
  type EnvironmentLookup,
  type HcClientFactory,
  type TerminalRefRecord,
  type TerminalRefStore,
} from "./service.ts";
import { DEFAULT_HISTORY_LINES, TerminalServicePort, TerminalStreams } from "./stream.ts";

const REF_FILE_VERSION = 1;

export interface TerminalComposition {
  readonly service: TerminalService;
  readonly terminals: TerminalPort;
  readonly terminalStreams: TerminalStreamHandler;
  close(): void;
}

export interface ProductionTerminalOptions {
  readonly environments: EnvironmentLookup;
  /** Where the terminal reference map lives. Absolute; this application's own
   * data directory. */
  readonly refsPath: string;
  readonly identity?: IdentityResolver;
  readonly client?: HcClientFactory;
  readonly now?: () => string;
  readonly history?: number;
  readonly requestTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

/**
 * The mapping on disk, replaced into place so a crash leaves the old file or
 * the new one. It holds a computer's id and a terminal address, never a key, a
 * password or a path outside this application's data directory.
 */
export class JsonTerminalRefStore implements TerminalRefStore {
  readonly filePath: string;

  constructor(filePath: string) {
    if (!isAbsolute(filePath)) {
      throw new TransportError(`the terminal reference file must be an absolute path, got ${JSON.stringify(filePath)}`);
    }
    this.filePath = filePath;
  }

  load(): TerminalRefRecord[] {
    if (!existsSync(this.filePath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new TransportError(`cannot read ${this.filePath}`, { cause: error });
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : isObject(parsed) && Array.isArray(parsed.terminals)
        ? parsed.terminals
        : null;
    if (entries === null) {
      throw new TransportError(`${this.filePath} is neither a terminal document nor an array`);
    }
    return entries.map((entry, index) => normalizeRecord(entry, index));
  }

  save(records: readonly TerminalRefRecord[]): void {
    const text = `${JSON.stringify({ version: REF_FILE_VERSION, terminals: records }, null, 2)}\n`;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, text, null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, this.filePath);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

/** The real thing: one core connection per environment, a durable reference
 * map, and browser streams that read the service. */
export function createProductionTerminalService(options: ProductionTerminalOptions): TerminalComposition {
  const service = new TerminalService({
    environments: options.environments,
    refs: new JsonTerminalRefStore(options.refsPath),
    ...(options.identity !== undefined ? { identity: options.identity } : {}),
    ...(options.client !== undefined ? { client: options.client } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  return {
    service,
    terminals: new TerminalServicePort(service),
    terminalStreams: new TerminalStreams({
      service,
      history: options.history ?? DEFAULT_HISTORY_LINES,
    }),
    close: () => service.close(),
  };
}

/**
 * No computer is configured. It reports no terminals and refuses a stream
 * rather than pretending one exists, which is what a server started without an
 * environment store must say.
 */
export function createUnconfiguredTerminalComposition(): TerminalComposition {
  return {
    service: new TerminalService({ environments: { get: () => null } }),
    terminals: { list: () => [], get: () => undefined, start: async () => { throw new Error("terminals are not configured"); } },
    terminalStreams: {
      open: () => {
        throw new Error("terminal transport is not configured");
      },
    },
    close: () => {},
  };
}

function normalizeRecord(entry: unknown, index: number): TerminalRefRecord {
  if (!isObject(entry)) throw new TransportError(`terminal reference ${index} is not an object`);
  const id = requireString(entry.id, "id", index);
  const environmentId = requireString(entry.environmentId, "environmentId", index);
  const nativeId = requireString(entry.nativeId, "nativeId", index);
  const tool = requireString(entry.tool, "tool", index);
  if (!(TOOL_NAMES as readonly string[]).includes(tool)) {
    throw new TransportError(`terminal reference ${index} names an unknown tool ${JSON.stringify(tool)}`);
  }
  const createdMs = entry.createdMs;
  if (typeof createdMs !== "number" || !Number.isSafeInteger(createdMs)) {
    throw new TransportError(`terminal reference ${index} has no createdMs`);
  }
  return {
    id,
    environmentId,
    nativeId,
    createdMs,
    tool: tool as ToolName,
    missionId: requireString(entry.missionId, "missionId", index),
    runId: requireString(entry.runId, "runId", index),
    createdAt: requireString(entry.createdAt, "createdAt", index),
    ...(typeof entry.closedAt === "string" ? { closedAt: entry.closedAt } : {}),
    ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
    ...(typeof entry.exitCode === "number" ? { exitCode: entry.exitCode } : {}),
    ...(isObject(entry.labels) ? { labels: entry.labels as Record<string, string> } : {}),
  };
}

function requireString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || value === "") {
    throw new TransportError(`terminal reference ${index} needs a non-empty ${field}`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
