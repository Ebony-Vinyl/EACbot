import type { ChildLike, ReadableLike, SpawnFn, SpawnOptions, WritableLike } from "../transport/types.ts";

type Listener<T extends unknown[]> = (...args: T) => void;

class FakeReadable implements ReadableLike {
  private readonly data: Array<Listener<[string | Buffer]>> = [];
  private readonly closeListeners: Array<Listener<[]>> = [];
  encoding: string | null = null;

  setEncoding(encoding: string): void {
    this.encoding = encoding;
  }

  on(_event: "data", listener: Listener<[string | Buffer]>): void {
    this.data.push(listener);
  }

  push(text: string): void {
    for (const listener of this.data) listener(text);
  }

  close(): void {
    for (const listener of this.closeListeners) listener();
  }
}

/** One scripted child process. Writes to stdin are recorded as parsed JSON lines, and the test
 * decides what the engine answers, so no adapter's protocol handling is taken on faith. */
export class FakeChild implements ChildLike {
  readonly stdin: WritableLike & { closed: boolean };
  readonly stdout: FakeReadable;
  readonly stderr: FakeReadable;
  exitCode: number | null = null;
  killed = false;
  readonly lines: Array<Record<string, unknown>> = [];
  readonly raw: string[] = [];
  private readonly exitListeners: Array<Listener<[number | null, string | null]>> = [];
  private readonly errorListeners: Array<Listener<[Error]>> = [];
  private readonly lineHandlers: Array<(line: Record<string, unknown>) => void> = [];
  private stdinErrorListener: ((error: Error) => void) | null = null;

  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;

  constructor(command: string, args: readonly string[], options: SpawnOptions) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.stdout = new FakeReadable();
    this.stderr = new FakeReadable();
    this.stdin = {
      closed: false,
      write: (chunk: string, callback?: (error?: Error | null) => void): boolean => {
        if (this.stdin.closed) {
          callback?.(new Error("stdin is closed"));
          return false;
        }
        this.raw.push(chunk);
        for (const piece of chunk.split("\n")) {
          if (!piece.trim()) continue;
          try {
            const frame = JSON.parse(piece) as Record<string, unknown>;
            this.lines.push(frame);
            for (const handler of this.lineHandlers) handler(frame);
          } catch {
            // A non-JSON write is still recorded in `raw`; the engine's own refusal is the point.
          }
        }
        callback?.(null);
        return true;
      },
      end: (): void => {
        this.stdin.closed = true;
      },
      on: (_event: "error", listener: (error: Error) => void): void => {
        this.stdinErrorListener = listener;
      },
    };
  }

  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error" | "exit" | "close", listener: ((error: Error) => void) | ((code: number | null, signal: string | null) => void)): void {
    if (event === "error") this.errorListeners.push(listener as (error: Error) => void);
    else this.exitListeners.push(listener as (code: number | null, signal: string | null) => void);
  }

  kill(_signal?: string): boolean {
    this.killed = true;
    this.emitExit(0);
    return true;
  }

  /** The engine writes one frame. */
  send(frame: Record<string, unknown>): void {
    this.stdout.push(`${JSON.stringify(frame)}\n`);
  }

  /** The engine writes raw bytes, so framing bugs can be exercised. */
  sendRaw(text: string): void {
    this.stdout.push(text);
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  emitExit(code: number | null, signal: string | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    for (const listener of this.exitListeners) listener(code, signal);
  }

  /** Called for every JSON line the adapter writes to this process. */
  onLine(handler: (line: Record<string, unknown>) => void): void {
    this.lineHandlers.push(handler);
  }

  emitStdinError(error: Error): void {
    this.stdinErrorListener?.(error);
  }

  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.lines.filter((line) => line.type === type);
  }

  callsOfMethod(method: string): Array<Record<string, unknown>> {
    return this.lines.filter((line) => line.method === method);
  }
}

export interface FakeSpawn {
  spawn: SpawnFn;
  children: FakeChild[];
  calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>;
}

/** A spawn that records every launch and hands the test each child it produced. */
export function fakeSpawn(configure?: (child: FakeChild) => void): FakeSpawn {
  const children: FakeChild[] = [];
  const calls: FakeSpawn["calls"] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild(command, args, options);
    children.push(child);
    configure?.(child);
    return child;
  };
  return { spawn, children, calls };
}

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface FakeFetch {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  requests: RecordedRequest[];
}

export type FetchResponder = (request: RecordedRequest) => Response | Promise<Response>;

/** A fetch that records every request and answers from a test-supplied responder. */
export function fakeFetch(responder: FetchResponder): FakeFetch {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const request: RecordedRequest = { url: input, method: init?.method ?? "GET", body, headers };
    requests.push(request);
    return responder(request);
  };
  return { fetch, requests };
}

/** An SSE response whose body the test writes to. */
export function sseResponse(): { response: Response; send: (event: string, data: unknown) => void; end: () => void } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const write = (text: string) => controller?.enqueue(encoder.encode(text));
  return {
    response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    send(event: string, data: unknown) {
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      controller?.close();
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

/** Collects events until `until` matches, or rejects after a bound so a hung adapter fails a test
 * rather than hanging the run. */
export async function collectUntil(
  events: AsyncIterable<{ type: string }>,
  until: (event: { type: string }) => boolean,
  timeoutMs = 4_000,
): Promise<Array<{ type: string }>> {
  const collected: Array<{ type: string }> = [];
  const iterator = events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out after ${collected.map((event) => event.type).join(", ")}`);
    const next = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining).unref?.(),
      ),
    ]);
    if (next.done) {
      if (until({ type: "__closed" })) return collected;
      throw new Error(`stream closed after ${collected.map((event) => event.type).join(", ")}`);
    }
    collected.push(next.value as { type: string });
    if (until(next.value as { type: string })) return collected;
  }
}
