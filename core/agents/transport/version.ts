import { agentDescriptor, parseVersionLine, type AgentDescriptor } from "../registry.ts";
import type { AgentId } from "../contracts.ts";
import type { ChildLike, SpawnFn } from "./types.ts";

export interface VersionProbeResult {
  installed: boolean;
  version: string | null;
  /** The CLI answered, but not in this engine's shape: the path runs another program. */
  notEngineCli: boolean;
  /** The failure, in the person's terms, when nothing ran. */
  reason?: string;
}

/** Runs the engine's own `--version` and reads it through that engine's pattern. A copy that
 * answers with another program's version is not this engine, and saying so is the point. */
export function probeVersion(
  spawn: SpawnFn,
  id: AgentId,
  options: { cli?: string; env: Record<string, string>; timeoutMs?: number },
): Promise<VersionProbeResult> {
  const descriptor: AgentDescriptor = agentDescriptor(id);
  const probe = descriptor.version;
  if (!probe) return Promise.resolve({ installed: false, version: null, notEngineCli: false, reason: "this agent has no version probe" });
  const cli = options.cli ?? descriptor.cli;
  if (!cli) return Promise.resolve({ installed: false, version: null, notEngineCli: false, reason: "this agent has no CLI" });

  return new Promise<VersionProbeResult>((resolve) => {
    let child: ChildLike;
    try {
      child = spawn(cli, [...probe.args], { env: options.env });
    } catch (error) {
      resolve({ installed: false, version: null, notEngineCli: false, reason: (error as Error).message });
      return;
    }
    let out = "";
    let settled = false;
    const finish = (result: VersionProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish({ installed: true, version: null, notEngineCli: false, reason: "the version probe timed out" });
    }, options.timeoutMs ?? 8_000);
    timer.unref?.();

    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      out += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ installed: false, version: null, notEngineCli: false, reason: error.message });
    });
    child.on("exit", (code) => {
      const line = out.split("\n")[0] ?? "";
      const version = parseVersionLine(id, line);
      if (version) finish({ installed: true, version, notEngineCli: false });
      else if (line.trim()) finish({ installed: true, version: null, notEngineCli: true, reason: `"${cli}" answered as another program: ${line.trim().slice(0, 120)}` });
      else finish({ installed: false, version: null, notEngineCli: false, reason: code === 0 ? "no version was printed" : `the probe exited ${code}` });
    });
  });
}

/** The install descriptor as a client may see it: a fixed argv or a command the person runs
 * themselves, never something this server executes on their behalf. */
export interface InstallPlan {
  agentId: AgentId;
  /** The npm package, when installing it is the documented route. */
  npmPackage?: string;
  /** Commands the person may run in their own terminal. Never executed here. */
  vendorInstaller?: Record<string, string>;
  docsUrl: string;
  signInCommand?: string;
  needsNode: boolean;
}

export function installPlan(id: AgentId): InstallPlan {
  const descriptor = agentDescriptor(id);
  return {
    agentId: id,
    ...(descriptor.install.npmPackage ? { npmPackage: descriptor.install.npmPackage } : {}),
    ...(descriptor.install.vendorInstaller ? { vendorInstaller: { ...descriptor.install.vendorInstaller } } : {}),
    docsUrl: descriptor.install.docsUrl,
    ...(descriptor.install.signInCommand ? { signInCommand: descriptor.install.signInCommand } : {}),
    needsNode: descriptor.install.needsNode === true,
  };
}
