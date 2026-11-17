/**
 * What the computer is, and which agent CLIs it has.
 *
 * Every probe is a fixed argv run through `runRemote`, so no shell is involved
 * and no credential ever reaches a command line. A version is read through the
 * engine's own pattern, exactly as `core/agents` reads it locally: a binary
 * that answers in another program's shape is reported as that, not as a
 * version.
 */

import { agentDescriptor, type AgentDescriptor } from "../agents/registry.ts";
import type { AgentId } from "../agents/contracts.ts";
import { NotNonRootError, SshDisconnectedError } from "./errors.ts";
import { isTransportFailure, runRemote, type RemoteTarget, type SshRunner } from "./ssh.ts";
import type { EnvironmentCapabilities, InstalledTool, ToolName } from "./types.ts";

/** The probe names this layer knows, and the engine each one is. */
const TOOL_ENGINE: Readonly<Record<ToolName, AgentId>> = {
  hermes: "hermes",
  claude: "claudeCode",
  codex: "codex",
  opencode: "openCode",
  pi: "pi",
  omp: "ohMyPi",
};

/** The smallest free space an install may proceed with. */
export const MIN_FREE_BYTES = 512 * 1024 * 1024;

export interface MachineFacts {
  readonly capabilities: EnvironmentCapabilities;
  readonly errors: readonly string[];
}

/**
 * Reads the machine's own description. A step that fails is recorded in
 * `errors` and leaves its field null rather than guessing: a shell this layer
 * invented would be used to run later commands.
 */
export async function probeMachine(runner: SshRunner, target: RemoteTarget): Promise<MachineFacts> {
  const errors: string[] = [];
  const facts = {
    os: await step(runner, target, ["uname", "-s"], errors, "os"),
    arch: await step(runner, target, ["uname", "-m"], errors, "arch"),
    homeDir: await step(runner, target, ["sh", "-c", "printf %s \"$HOME\""], errors, "home"),
    user: await step(runner, target, ["id", "-un"], errors, "user"),
    shell: await step(runner, target, ["sh", "-c", "printf %s \"${SHELL:-}\""], errors, "shell"),
  };
  const diskFreeBytes = await probeDiskFree(runner, target, errors);
  const nonRoot = facts.user === null ? null : facts.user !== "root";

  return {
    capabilities: {
      os: facts.os,
      arch: facts.arch,
      shell: facts.shell === null || facts.shell === "" ? null : facts.shell,
      homeDir: facts.homeDir,
      diskFreeBytes,
      nonRoot,
    },
    errors,
  };
}

async function step(
  runner: SshRunner,
  target: RemoteTarget,
  argv: readonly string[],
  errors: string[],
  what: string,
): Promise<string | null> {
  const result = await runRemote(runner, target, argv);
  if (isTransportFailure(result)) {
    throw new SshDisconnectedError(`the connection to ${target.host} dropped while reading ${what}`);
  }
  if (result.code !== 0) {
    errors.push(`${what}: exited ${result.code}`);
    return null;
  }
  const line = result.stdout.split(/\r?\n/)[0]?.trim() ?? "";
  return line === "" ? null : line;
}

/** `df -Pk` on the home directory: POSIX output, kibibyte blocks, one line. */
async function probeDiskFree(runner: SshRunner, target: RemoteTarget, errors: string[]): Promise<number | null> {
  const result = await runRemote(runner, target, ["df", "-Pk", "."]);
  if (isTransportFailure(result)) throw new SshDisconnectedError(`the connection to ${target.host} dropped while reading disk`);
  if (result.code !== 0) {
    errors.push(`disk: exited ${result.code}`);
    return null;
  }
  return parseDfAvailableKib(result.stdout);
}

/** The `Available` column of `df -Pk`, in bytes. A header or a wrapped line is
 * not a number and yields null rather than a made-up free space. */
export function parseDfAvailableKib(text: string): number | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const fields = lines[at]!.trim().split(/\s+/);
    if (fields.length < 4) continue;
    if (fields[0] === "Filesystem") continue;
    const available = Number(fields[3]);
    if (!Number.isSafeInteger(available) || available < 0) continue;
    return available * 1024;
  }
  return null;
}

/**
 * Probes each agent CLI with its own `--version` argv. `command -v` runs as a
 * constant script that reads its argument from `$1`, so a tool name is never
 * spliced into shell text.
 *
 * `minimums` is the caller's own floor per tool. This layer does not invent one:
 * a version it declared outdated on its own would be a claim about an engine's
 * protocol that this code cannot check.
 */
export async function probeTools(
  runner: SshRunner,
  target: RemoteTarget,
  names: readonly ToolName[] = Object.keys(TOOL_ENGINE) as ToolName[],
  minimums: Partial<Record<ToolName, string>> = {},
): Promise<InstalledTool[]> {
  const tools: InstalledTool[] = [];
  for (const name of names) tools.push(await probeTool(runner, target, name, minimums[name]));
  return tools;
}

const LOCATE_SCRIPT = 'command -v -- "$1"';

export async function probeTool(
  runner: SshRunner,
  target: RemoteTarget,
  name: ToolName,
  minimum?: string,
): Promise<InstalledTool> {
  const descriptor: AgentDescriptor = agentDescriptor(TOOL_ENGINE[name]);
  const located = await runRemote(runner, target, ["sh", "-c", LOCATE_SCRIPT, "sh", name]);
  if (isTransportFailure(located)) throw new SshDisconnectedError(`the connection to ${target.host} dropped while looking for ${name}`);
  const path = located.stdout.split(/\r?\n/)[0]?.trim() ?? "";
  if (located.code !== 0 || path === "") {
    return { name, status: "missing", path: null, version: null };
  }
  if (!descriptor.version) {
    return { name, status: "installed", path, version: null, detail: "this engine has no version probe" };
  }
  const probe = await runRemote(runner, target, [path, ...descriptor.version.args]);
  if (isTransportFailure(probe)) throw new SshDisconnectedError(`the connection to ${target.host} dropped while reading ${name}'s version`);
  const line = probe.stdout.split(/\r?\n/)[0]?.trim() ?? "";
  if (probe.code !== 0) {
    return { name, status: "probeFailed", path, version: null, detail: `the version probe exited ${probe.code}` };
  }
  const match = descriptor.version.pattern.exec(line);
  if (!match?.[1]) {
    return {
      name,
      status: "notThisTool",
      path,
      version: null,
      detail: line === "" ? "no version was printed" : `answered as another program: ${line.slice(0, 120)}`,
    };
  }
  const version = match[1];
  if (minimum !== undefined && isOlderThan(version, minimum)) {
    return { name, status: "outdated", path, version, detail: `older than the ${minimum} this caller requires` };
  }
  return { name, status: "installed", path, version };
}

/** The version a record reports for one tool, or null when it is not installed. */
export function toolVersion(tools: readonly InstalledTool[], name: ToolName): string | null {
  return tools.find((tool) => tool.name === name && tool.status === "installed")?.version ?? null;
}

/** A tool that is present but reports a version older than `minimum`. */
export function isOlderThan(version: string | null, minimum: string): boolean {
  if (version === null) return false;
  const left = version.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    const a = left[at] ?? 0;
    const b = right[at] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

export function requireNonRoot(capabilities: EnvironmentCapabilities, user: string): void {
  if (capabilities.nonRoot === false || user === "root") throw new NotNonRootError(user);
}
