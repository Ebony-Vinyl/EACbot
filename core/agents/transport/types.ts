/** Structural process and HTTP shapes the adapters depend on. Tests supply fakes through these,
 * so no adapter reaches `node:child_process` or the global `fetch` directly. */

export interface WritableLike {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end(): void;
  on?(event: "error", listener: (error: Error) => void): void;
}

export interface ReadableLike {
  setEncoding?(encoding: string): void;
  on(event: "data", listener: (chunk: string | Buffer) => void): void;
}

export interface ChildLike {
  readonly pid?: number;
  readonly stdin: WritableLike | null;
  readonly stdout: ReadableLike | null;
  readonly stderr: ReadableLike | null;
  readonly exitCode?: number | null;
  readonly killed?: boolean;
  kill(signal?: string): boolean;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
}

export interface SpawnOptions {
  env: Record<string, string>;
  cwd?: string;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildLike;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
