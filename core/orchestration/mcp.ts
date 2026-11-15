import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { ToolErrorCode } from "./errors.ts";
import type { ToolService } from "./tool-service.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** The framing a stdio MCP server reads. One JSON-RPC message per line
 * (MCP 2025-06-18, stdio transport). */
export interface McpMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export const MCP_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface McpTransport {
  /** Reads one message; `null` ends the session. */
  read(): Promise<McpMessage | null>;
  write(message: McpMessage): void;
  close(): void;
}

export interface McpServerOptions {
  /** Verifies the transport token and runs the call; the token never reaches a
   * tool's arguments. */
  readonly tools: ToolService;
  readonly serverName?: string;
  readonly serverVersion?: string;
}

/** How a client presents its scoped token. It is a transport credential, so it
 * arrives with the request, never inside `arguments`. */
function tokenFrom(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const meta = (params as Record<string, unknown>)._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>).token;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The stdio MCP adapter: initialize, tools/list, tools/call. It speaks JSON-RPC
 * itself, so no external SDK is involved and a test can inject a transport. */
export class McpServer {
  readonly #tools: ToolService;
  readonly #serverName: string;
  readonly #serverVersion: string;
  #initialized = false;

  constructor(options: McpServerOptions) {
    this.#tools = options.tools;
    this.#serverName = options.serverName ?? "eacbot-orchestration";
    this.#serverVersion = options.serverVersion ?? "1.0.0";
  }

  /** Handles one message and returns the reply, or `null` for a notification
   * that takes no answer. */
  async handle(message: McpMessage): Promise<McpMessage | null> {
    if (message.jsonrpc !== "2.0") return failure(message.id ?? null, MCP_ERROR.INVALID_REQUEST, "jsonrpc must be 2.0");
    const method = message.method;
    if (typeof method !== "string") {
      if ("result" in message || "error" in message) return null;
      return failure(message.id ?? null, MCP_ERROR.INVALID_REQUEST, "method is required");
    }
    const isNotification = message.id === undefined;
    try {
      switch (method) {
        case "initialize":
          return success(message.id ?? null, this.#initialize());
        case "notifications/initialized":
          this.#initialized = true;
          return null;
        case "ping":
          return success(message.id ?? null, {});
        case "tools/list":
          this.#requireInitialized();
          return success(message.id ?? null, { tools: this.#tools.listTools().map(toMcpTool) });
        case "tools/call":
          this.#requireInitialized();
          return await this.#callTool(message);
        default:
          if (isNotification) return null;
          return failure(message.id ?? null, MCP_ERROR.METHOD_NOT_FOUND, `no method ${method}`);
      }
    } catch (error) {
      if (error instanceof McpRefusal) {
        return isNotification ? null : failure(message.id ?? null, error.rpcCode, error.message, error.data);
      }
      return isNotification
        ? null
        : failure(message.id ?? null, MCP_ERROR.INTERNAL_ERROR, error instanceof Error ? error.message : "internal error");
    }
  }

  /** Reads until the transport ends, writing one reply per request. */
  async serve(transport: McpTransport): Promise<void> {
    try {
      for (;;) {
        const message = await transport.read();
        if (message === null) return;
        const reply = await this.handle(message);
        if (reply !== null) transport.write(reply);
      }
    } finally {
      transport.close();
    }
  }

  #initialize(): Record<string, unknown> {
    this.#initialized = true;
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.#serverName, version: this.#serverVersion },
    };
  }

  #requireInitialized(): void {
    if (!this.#initialized) throw new McpRefusal(MCP_ERROR.INVALID_REQUEST, "initialize must arrive first");
  }

  async #callTool(message: McpMessage): Promise<McpMessage> {
    const params = message.params;
    if (typeof params !== "object" || params === null) {
      return failure(message.id ?? null, MCP_ERROR.INVALID_PARAMS, "tools/call needs params");
    }
    const record = params as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== "string" || name.length === 0) {
      return failure(message.id ?? null, MCP_ERROR.INVALID_PARAMS, "tools/call needs a tool name");
    }
    const args = record.arguments;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return failure(message.id ?? null, MCP_ERROR.INVALID_PARAMS, "tools/call arguments must be an object");
    }

    const token = tokenFrom(params);
    if (token === undefined) {
      return success(message.id ?? null, toolRefusal("unauthenticated", "this server needs a scoped token in params._meta.token"));
    }

    const outcome = await this.#tools.callWithToken(name, args ?? {}, token);
    return success(message.id ?? null, {
      content: [{ type: "text", text: JSON.stringify(outcome) }],
      structuredContent: outcome,
      isError: !outcome.ok,
    });
  }
}

class McpRefusal extends Error {
  readonly rpcCode: number;
  readonly data: unknown;

  constructor(rpcCode: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpRefusal";
    this.rpcCode = rpcCode;
    this.data = data;
  }
}

function toolRefusal(code: ToolErrorCode, message: string): Record<string, unknown> {
  const outcome = { ok: false, tool: "list_agents", error: { code, message, retryable: false } };
  return { content: [{ type: "text", text: JSON.stringify(outcome) }], structuredContent: outcome, isError: true };
}

function toMcpTool(schema: { readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> }): Record<string, unknown> {
  return { name: schema.name, description: schema.description, inputSchema: schema.inputSchema };
}

function success(id: number | string | null, result: unknown): McpMessage {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: number | string | null, code: number, message: string, data?: unknown): McpMessage {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** Line-delimited JSON over a pair of streams. A line that is not JSON becomes
 * a parse error on the reply stream, never a crash. */
export function lineTransport(input: Readable, output: Writable): McpTransport {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const buffered: McpMessage[] = [];
  const waiting: ((value: McpMessage | null) => void)[] = [];
  let ended = false;

  const push = (message: McpMessage | null): void => {
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else if (message !== null) buffered.push(message);
  };

  lines.on("line", (line: string) => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(failure(null, MCP_ERROR.PARSE_ERROR, "the line is not JSON"))}
`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      output.write(`${JSON.stringify(failure(null, MCP_ERROR.INVALID_REQUEST, "a message must be an object"))}
`);
      return;
    }
    push(parsed as McpMessage);
  });

  lines.on("close", () => {
    ended = true;
    while (waiting.length > 0) waiting.shift()!(null);
  });

  return {
    read(): Promise<McpMessage | null> {
      const next = buffered.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (ended) return Promise.resolve(null);
      return new Promise<McpMessage | null>((resolve) => waiting.push(resolve));
    },
    write(message: McpMessage): void {
      output.write(`${JSON.stringify(message)}\n`);
    },
    close(): void {
      lines.close();
    },
  };
}

/** An in-memory transport a test drives without touching a process. */
export class MemoryTransport implements McpTransport {
  readonly written: McpMessage[] = [];
  readonly #inbound: McpMessage[] = [];
  #closed = false;

  push(message: McpMessage): void {
    this.#inbound.push(message);
  }

  read(): Promise<McpMessage | null> {
    const next = this.#inbound.shift();
    if (next !== undefined) return Promise.resolve(next);
    return Promise.resolve(null);
  }

  write(message: McpMessage): void {
    this.written.push(message);
  }

  close(): void {
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }
}
