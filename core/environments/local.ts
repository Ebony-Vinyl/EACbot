import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { arch, platform, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { AGENT_REGISTRY } from "../agents/registry.ts";
import type { CoreConfigAgent } from "../bootstrap/config.ts";
import { TOOL_NAMES, type EnvironmentRecord, type InstalledTool } from "./types.ts";

const run = promisify(execFile);

export async function discoverLocalComputer(env: NodeJS.ProcessEnv): Promise<EnvironmentRecord> {
  const user = userInfo();
  const home = env.HOME ?? user.homedir;
  const tools = await Promise.all(TOOL_NAMES.map(async (name): Promise<InstalledTool> => {
    const descriptor = Object.values(AGENT_REGISTRY).find((agent) => agent.tui[0] === name)!;
    let path: string | null = null;
    for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(directory, name);
      try { accessSync(candidate, constants.X_OK); path = candidate; break; } catch { continue; }
    }
    if (!path) return { name, status: "missing", path: null, version: null };
    if (!descriptor.version) return { name, status: "installed", path, version: null };
    try {
      const { stdout } = await run(path, [...descriptor.version.args], { env, timeout: 10000, maxBuffer: 65536 });
      const version = descriptor.version.pattern.exec(stdout.trim())?.[1] ?? null;
      return { name, status: version ? "installed" : "notThisTool", path, version };
    } catch {
      return { name, status: "probeFailed", path, version: null, detail: "本机版本探测未成功" };
    }
  }));
  const now = new Date().toISOString();
  return {
    id: "local", kind: "local", label: "这台电脑", host: "", port: 0, user: user.username,
    knownHostsFile: "", hostKeyFingerprint: "", identityFileRef: null,
    status: "online", lastSeen: now, createdAt: now, updatedAt: now, revision: 1,
    capabilities: { os: platform(), arch: arch(), shell: env.SHELL ?? null, homeDir: home, diskFreeBytes: null, nonRoot: user.uid !== 0 },
    tools,
  };
}

export function localAgents(computer: EnvironmentRecord): CoreConfigAgent[] {
  return computer.tools.flatMap((tool) => {
    const descriptor = Object.values(AGENT_REGISTRY).find((agent) => agent.tui[0] === tool.name)!;
    if (tool.status !== "installed" || !tool.path || descriptor.transport === "http") return [];
    return [{ id: `local-${descriptor.id}`, agentId: descriptor.id, home: computer.capabilities.homeDir!, cli: tool.path, enabled: true, authMode: "subscription" as const }];
  });
}
