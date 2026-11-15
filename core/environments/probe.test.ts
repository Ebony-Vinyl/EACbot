import { describe, expect, it } from "vitest";

import {
  MIN_FREE_BYTES,
  isOlderThan,
  parseDfAvailableKib,
  probeMachine,
  probeTool,
  probeTools,
  requireNonRoot,
  toolVersion,
  type RemoteTarget,
} from "./index.ts";
import { LOCATE_SCRIPT, FakeMachine, standardMachine } from "./testing/fake-ssh.ts";
import { remoteCommandLine } from "./ssh.ts";

const TARGET: RemoteTarget = {
  host: "laptop.example",
  port: 22,
  user: "me",
  knownHostsFile: "/var/lib/eacbot/known_hosts",
  hostKeyFingerprint: `SHA256:${"a".repeat(43)}`,
};

const CLAUDE = "/usr/local/bin/claude";
const PI = "/usr/local/bin/pi";

const MACHINE = () =>
  standardMachine({
    tools: { claude: CLAUDE, pi: PI },
    versions: {
      claude: "2.1.7 (Claude Code)",
      pi: "1.4.2",
    },
  });

describe("reading the machine", () => {
  it("reports the OS, architecture, shell and home the computer answered", async () => {
    const facts = await probeMachine(MACHINE().runner, TARGET);
    expect(facts.capabilities).toEqual({
      os: "Linux",
      arch: "x86_64",
      shell: "/bin/bash",
      homeDir: "/home/me",
      diskFreeBytes: 50_000_000 * 1024,
      nonRoot: true,
    });
    expect(facts.errors).toEqual([]);
  });

  it("leaves a field null and records why when a step fails, never guessing", async () => {
    const machine = MACHINE().answer(["uname", "-s"], { code: 1, stderr: "uname: not found" });
    const facts = await probeMachine(machine.runner, TARGET);
    expect(facts.capabilities.os).toBeNull();
    expect(facts.errors).toContain("os: exited 1");
    expect(facts.capabilities.arch).toBe("x86_64");
  });

  it("marks a root login as not non-root", async () => {
    const facts = await probeMachine(standardMachine({ user: "root" }).runner, TARGET);
    expect(facts.capabilities.nonRoot).toBe(false);
  });

  it("parses df's Available column and skips the header", () => {
    expect(parseDfAvailableKib("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 2 3000 1% /\n")).toBe(3000 * 1024);
    expect(parseDfAvailableKib("Filesystem\n")).toBeNull();
    expect(parseDfAvailableKib("")).toBeNull();
  });

  it("treats a disk answer that is not a number as unknown", async () => {
    const machine = standardMachine().answer(["df", "-Pk", "."], { code: 0, stdout: "Filesystem\n/dev/sda1 ?\n" });
    const facts = await probeMachine(machine.runner, TARGET);
    expect(facts.capabilities.diskFreeBytes).toBeNull();
  });
});

describe("probing an agent CLI", () => {
  it("reads each engine's own version through its own pattern", async () => {
    const tools = await probeTools(MACHINE().runner, TARGET, ["claude", "pi"]);
    expect(tools).toEqual([
      { name: "claude", status: "installed", path: CLAUDE, version: "2.1.7" },
      { name: "pi", status: "installed", path: PI, version: "1.4.2" },
    ]);
  });

  it("reports a tool that is not there as missing, not as an error", async () => {
    const tool = await probeTool(MACHINE().runner, TARGET, "codex");
    expect(tool).toEqual({ name: "codex", status: "missing", path: null, version: null });
  });

  it("reports a binary that answers in another program's shape", async () => {
    const machine = MACHINE().answer([CLAUDE, "--version"], { code: 0, stdout: "some other tool 9.9.9\n" });
    const tool = await probeTool(machine.runner, TARGET, "claude");
    expect(tool.status).toBe("notThisTool");
    expect(tool.version).toBeNull();
    expect(tool.detail).toContain("some other tool");
  });

  it("reports a probe that exits non-zero as a failed probe", async () => {
    const machine = MACHINE().answer([PI, "--version"], { code: 2, stderr: "broken" });
    const tool = await probeTool(machine.runner, TARGET, "pi");
    expect(tool.status).toBe("probeFailed");
    expect(tool.detail).toContain("exited 2");
  });

  it("reports a version below the caller's floor as outdated, keeping the version", async () => {
    const machine = MACHINE();
    const tool = await probeTool(machine.runner, TARGET, "pi", "2.0.0");
    expect(tool.status).toBe("outdated");
    expect(tool.version).toBe("1.4.2");
    expect(tool.detail).toContain("2.0.0");
  });

  it("leaves the floor to the caller: no minimum means no outdated verdict", async () => {
    const tool = await probeTool(MACHINE().runner, TARGET, "pi");
    expect(tool.status).toBe("installed");
  });

  it("runs the tool name as an argument, never spliced into shell text", async () => {
    const machine = MACHINE();
    await probeTool(machine.runner, TARGET, "pi");
    const lines = machine.lines();
    expect(lines[0]).toBe(remoteCommandLine(["sh", "-c", LOCATE_SCRIPT, "sh", "pi"]));
    expect(lines[0]).toContain("'pi'");
    expect(lines[1]).toBe(remoteCommandLine([PI, "--version"]));
  });

  it("puts no credential on any probe's command line", async () => {
    const machine = MACHINE();
    await probeTools(machine.runner, TARGET);
    for (const line of machine.lines()) {
      expect(line).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD|API_KEY/i);
    }
  });

  it("keeps probing the rest when one tool's probe fails", async () => {
    const machine = MACHINE().answer([CLAUDE, "--version"], { code: 0, stdout: "" });
    const tools = await probeTools(machine.runner, TARGET, ["claude", "pi"]);
    expect(tools.map((tool) => tool.status)).toEqual(["notThisTool", "installed"]);
  });
});

describe("version helpers", () => {
  it("compares dotted versions by number, not by string", () => {
    expect(isOlderThan("1.9.0", "1.10.0")).toBe(true);
    expect(isOlderThan("1.10.0", "1.9.0")).toBe(false);
    expect(isOlderThan("2.0", "2.0.0")).toBe(false);
    expect(isOlderThan(null, "2.0.0")).toBe(false);
  });

  it("reads one tool's version from a probe result", () => {
    const tools = [{ name: "pi" as const, status: "installed" as const, path: PI, version: "1.4.2" }];
    expect(toolVersion(tools, "pi")).toBe("1.4.2");
    expect(toolVersion(tools, "codex")).toBeNull();
  });

  it("refuses root, and refuses an unknown identity only when the answer says root", () => {
    expect(() => requireNonRoot({ ...emptyCapabilities(), nonRoot: false }, "me")).toThrow();
    expect(() => requireNonRoot(emptyCapabilities(), "root")).toThrow();
    expect(() => requireNonRoot(emptyCapabilities(), "me")).not.toThrow();
  });

  it("exports the minimum free space an install needs", () => {
    expect(MIN_FREE_BYTES).toBeGreaterThan(0);
  });
});

function emptyCapabilities() {
  return { os: null, arch: null, shell: null, homeDir: null, diskFreeBytes: null, nonRoot: null };
}

describe("a dropped connection during a probe", () => {
  it("surfaces as a disconnect so the caller can mark the computer unreachable", async () => {
    const machine = new FakeMachine().dropConnectionWhen(["uname", "-s"]);
    await expect(probeMachine(machine.runner, TARGET)).rejects.toMatchObject({ kind: "sshDisconnected" });
  });
});
