import { AgentRpcError, AgentTransportError } from "../errors.ts";
import type { ChildLike, SpawnFn } from "./types.ts";
import { readJsonl, type Frame } from "./jsonl.ts";

export interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
}

export interface PeerOptions {
  agentId: string;
  /** Default per-request timeout; a wedged engine must not hang the caller forever. */
  timeoutMs?: number;
  onFrame?: (frame: Frame) => void;
  /** A server-to-client request: the engine asking the client for something. */
  onRequest?: (frame: Frame) => void;
  onNotification?: (frame: Frame) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  onStderr?: (text: string) => void;
}

/** A JSON-RPC 2.0 peer over a child's stdio, with newline framing. Request ids are local
 * integers; the peer never reuses one while its call is outstanding. */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private closed = false;
  private exit: { code: number | null; signal: string | null } | null = null;

  private readonly agentId: string;
  private readonly child: ChildLike;
  private readonly options: PeerOptions;

  constructor(agentId: string, child: ChildLike, options: PeerOptions = { agentId }) {
    this.agentId = agentId;
    this.child = child;
    this.options = options;
    readJsonl(child.stdout, (frame) => this.receive(frame));
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.options.onStderr?.(text);
    });
    child.on("exit", (code, signal) => {
      this.exit = { code, signal };
      this.options.onExit?.(code, signal);
      this.failPending(new AgentTransportError(this.agentId, `process exited ${code ?? signal ?? "unknown"}`));
    });
    child.on("error", (error) => {
      this.failPending(new AgentTransportError(this.agentId, error.message, undefined, { cause: error }));
    });
  }

  get exited(): boolean {
    return this.exit !== null;
  }

  /** Send a request and wait for its result. */
  call(method: string, params: unknown, timeoutMs = this.options.timeoutMs ?? 20_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new AgentTransportError(this.agentId, "peer is closed"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs > 0 && timeoutMs !== Number.POSITIVE_INFINITY
        ? setTimeout(() => {
            if (this.pending.delete(id)) {
              reject(new AgentTransportError(this.agentId, `${method} timed out after ${timeoutMs}ms`));
            }
          }, timeoutMs)
        : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.settle(id, () => reject(error as Error));
      }
    });
  }

  /** Send a notification (no reply expected). */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Answer a server-to-client request. */
  respond(id: unknown, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: unknown, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  write(payload: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin) throw new AgentTransportError(this.agentId, "process has no stdin");
    stdin.write(`${JSON.stringify(payload)}\n`);
  }

  close(reason: string): void {
    this.closed = true;
    this.failPending(new AgentTransportError(this.agentId, reason));
  }

  /** Close and terminate the child. A peer whose turn ended must not leave a process running. */
  dispose(reason: string): void {
    this.close(reason);
    try {
      this.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private settle(id: number, run: (call: PendingCall) => void): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    if (call.timer) clearTimeout(call.timer);
    run(call);
  }

  private failPending(error: Error): void {
    for (const [id, call] of this.pending) {
      if (call.timer) clearTimeout(call.timer);
      this.pending.delete(id);
      call.reject(error);
    }
  }

  private receive(frame: Frame): void {
    this.options.onFrame?.(frame);
    if (typeof frame.id === "number" && this.pending.has(frame.id)) {
      if (frame.error && typeof frame.error === "object") {
        const error = frame.error as { code?: unknown; message?: unknown };
        const code = typeof error.code === "number" ? error.code : -32603;
        const message = typeof error.message === "string" ? error.message : "unknown error";
        const method = this.pending.get(frame.id)?.method ?? "request";
        this.settle(frame.id, (call) => call.reject(new AgentRpcError(method, code, message)));
        return;
      }
      this.settle(frame.id, (call) => call.resolve(frame.result));
      return;
    }
    if (typeof frame.method === "string") {
      if (frame.id !== undefined && frame.id !== null) this.options.onRequest?.(frame);
      else this.options.onNotification?.(frame);
    }
  }
}

/** Starts a child and wraps its stdio in a peer. */
export function spawnPeer(
  spawn: SpawnFn,
  agentId: string,
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd?: string },
  peer: Omit<PeerOptions, "agentId"> = {},
): { child: ChildLike; rpc: JsonRpcPeer } {
  const child = spawn(command, args, { env: options.env, cwd: options.cwd });
  return { child, rpc: new JsonRpcPeer(agentId, child, { agentId, ...peer }) };
}
