import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";

import type { PluginInstallRecord } from "./store.ts";

export interface PluginRuntime {
  start(record: PluginInstallRecord): Promise<{ ok: true } | { ok: false; error: string }>;
  stop(record: PluginInstallRecord): Promise<void>;
  isRunning?(installationId: string): boolean;
  stopAll?(): Promise<void>;
  call?(installationId: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface StdioPluginSupervisorOptions {
  dataDir: string;
  nodePath?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  onExit?: (installationId: string, reason: string) => void;
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  stderr: string;
  nextId: number;
  pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
}

const MAX_STDERR = 4_096;
const MAX_LINE = 1_000_000;

function rejectPending(state: Running, reason: string): void {
  for (const waiter of state.pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
  }
  state.pending.clear();
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

function safeEnvironment(workDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SystemDrive", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "PATHEXT", "ComSpec"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = workDir;
  env.USERPROFILE = workDir;
  env.TMPDIR = workDir;
  env.TMP = workDir;
  env.TEMP = workDir;
  return env;
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => {
      try { child.kill(); } catch {}
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Starts an opted-in local process plugin. This is crash containment, not an OS sandbox: the child runs as the server's
 * user. A manifest that requires real isolation is refused by the registry; this class only runs `isolation: none`.
 */
export class StdioPluginSupervisor implements PluginRuntime {
  private readonly dataDir: string;
  private readonly nodePath: string;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly onExit?: (installationId: string, reason: string) => void;
  private readonly running = new Map<string, Running>();
  private readonly stopping = new Set<string>();
  private readonly killOnExit = () => {
    for (const { child } of this.running.values()) killTree(child);
  };

  constructor(options: StdioPluginSupervisorOptions) {
    this.dataDir = join(options.dataDir, "plugins", "runtime");
    this.nodePath = options.nodePath ?? process.execPath;
    this.startTimeoutMs = options.startTimeoutMs ?? 8_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 3_000;
    this.onExit = options.onExit;
    process.once("exit", this.killOnExit);
  }

  activeCount(): number {
    return this.running.size;
  }

  isRunning(installationId: string): boolean {
    return this.running.has(installationId);
  }

  async start(record: PluginInstallRecord): Promise<{ ok: true } | { ok: false; error: string }> {
    const runtime = record.manifest.runtime;
    if (runtime.mode !== "process") return { ok: false, error: "this plugin is not a process runtime" };
    if (runtime.isolation === "required") return { ok: false, error: "this host has no OS sandbox for required isolation" };
    if (!record.packageDir) return { ok: false, error: "this installation has no local package directory" };
    if (this.running.has(record.installationId)) return { ok: true };

    const entry = join(record.packageDir, runtime.entry);
    const rel = relative(record.packageDir, entry);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !existsSync(entry)) {
      return { ok: false, error: "the plugin entry is missing or outside its package" };
    }
    try {
      const stat = lstatSync(entry);
      const realEntry = realpathSync(entry);
      const realRel = relative(record.packageDir, realEntry);
      if (stat.isSymbolicLink() || !stat.isFile() || realRel.startsWith("..") || isAbsolute(realRel)) {
        return { ok: false, error: "the plugin entry changed into a link or left its package" };
      }
    } catch {
      return { ok: false, error: "the plugin entry could not be read" };
    }
    const workDir = join(this.dataDir, record.installationId);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.nodePath, [entry], {
        cwd: workDir,
        env: {
          ...safeEnvironment(workDir),
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          EAC_PLUGIN_ID: record.pluginId,
          EAC_PLUGIN_INSTALLATION_ID: record.installationId,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch {
      return { ok: false, error: "the plugin process could not start" };
    }

    const state: Running = { child, startedAt: Date.now(), stderr: "", nextId: 100, pending: new Map() };
    this.running.set(record.installationId, state);
    // A write to a pipe the plugin already closed fails asynchronously; without this the error would be unhandled and take
    // the server down.
    child.stdin.on("error", () => rejectPending(state, "the plugin closed its input"));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (state.stderr.length < MAX_STDERR) state.stderr = (state.stderr + chunk).slice(0, MAX_STDERR);
    });

    let settled = false;
    const result = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
      const finish = (value: { ok: true } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "the plugin did not finish its handshake in time" }), this.startTimeoutMs);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (text) => {
        if (text.length > MAX_LINE) {
          finish({ ok: false, error: "the plugin sent an oversized handshake line" });
          return;
        }
        let message: unknown;
        try { message = JSON.parse(text); } catch { return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) return;
        const reply = message as { id?: unknown; result?: unknown; error?: unknown };
        if (typeof reply.id === "number" && state.pending.has(reply.id)) {
          const waiter = state.pending.get(reply.id)!;
          state.pending.delete(reply.id);
          clearTimeout(waiter.timer);
          if (reply.error !== undefined) waiter.reject(new Error("the plugin returned an error"));
          else waiter.resolve(reply.result);
          return;
        }
        if (reply.id !== 1) return;
        if (reply.error !== undefined) {
          finish({ ok: false, error: "the plugin refused its handshake" });
          return;
        }
        const result = reply.result;
        if (!result || typeof result !== "object" || Array.isArray(result) || (result as { ok?: unknown }).ok !== true) {
          finish({ ok: false, error: "the plugin returned an invalid handshake result" });
          return;
        }
        finish({ ok: true });
      });
      child.once("error", (error) => finish({ ok: false, error: error.message }));
      child.once("exit", () => {
        this.running.delete(record.installationId);
        finish({ ok: false, error: "the plugin exited during its handshake" });
      });
      try {
        child.stdin.write(line({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            apiVersion: "1.0.0",
            pluginId: record.pluginId,
            installationId: record.installationId,
            manifestVersion: record.manifest.version,
          },
        }));
      } catch {
        finish({ ok: false, error: "the plugin closed its input during the handshake" });
      }
    });

    if (!result.ok) {
      await this.stop(record);
      return result;
    }
    child.once("exit", (code, signal) => {
      const intentional = this.stopping.has(record.installationId);
      this.running.delete(record.installationId);
      rejectPending(state, "the plugin exited");
      if (!intentional) this.onExit?.(record.installationId, `the plugin exited (${code ?? signal ?? "unknown"})`);
    });
    return result;
  }

  async call(installationId: string, method: string, params: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const state = this.running.get(installationId);
    if (!state) throw new Error("the plugin is not running");
    const id = state.nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error("the plugin did not answer in time"));
      }, timeoutMs);
      timer.unref?.();
      state.pending.set(id, { resolve, reject, timer });
      try {
        state.child.stdin.write(line({ jsonrpc: "2.0", id, method, params }));
      } catch {
        state.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("the plugin closed its input"));
      }
    });
  }

  private async stopById(installationId: string): Promise<void> {
    const state = this.running.get(installationId);
    if (!state) return;
    this.stopping.add(installationId);
    rejectPending(state, "the plugin is stopping");
    const { child } = state;
    try {
      try {
        child.stdin.write(line({ jsonrpc: "2.0", id: 2, method: "shutdown", params: {} }));
      } catch {
        // The process may already have closed its input; the exit wait below decides.
      }
      const exited = await waitForExit(child, this.stopTimeoutMs);
      if (!exited) {
        killTree(child);
        await waitForExit(child, 1_000);
      }
      this.running.delete(installationId);
    } finally {
      this.stopping.delete(installationId);
    }
  }

  async stop(record: PluginInstallRecord): Promise<void> {
    await this.stopById(record.installationId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((installationId) => this.stopById(installationId)));
  }

  dispose(): void {
    process.off("exit", this.killOnExit);
  }
}
