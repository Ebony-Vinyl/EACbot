import { describe, expect, it } from "vitest";
import { installPlan, probeVersion } from "./version.ts";
import { fakeSpawn } from "../testing/fake-child.ts";

const ENV = { PATH: "/usr/bin", HOME: "/tmp/home" };

function childAnswering(line: string | null, exitCode = 0) {
  return fakeSpawn((child) => {
    child.onLine(() => {});
    queueMicrotask(() => {
      if (line !== null) child.stdout.push(`${line}\n`);
      child.emitExit(exitCode);
    });
  });
}

describe("version probing", () => {
  it("reads a matching engine version", async () => {
    const fake = childAnswering("2.1.291 (Claude Code)");
    const result = await probeVersion(fake.spawn, "claudeCode", { env: ENV });
    expect(result).toEqual({ installed: true, version: "2.1.291", notEngineCli: false });
    expect(fake.calls[0]!.args).toEqual(["--version"]);
    expect(fake.calls[0]!.options.env).toBe(ENV);
  });

  it("says so when the path runs another program", async () => {
    const fake = childAnswering("2.1.291 (Claude Code)");
    const result = await probeVersion(fake.spawn, "codex", { env: ENV });
    expect(result).toMatchObject({ installed: true, version: null, notEngineCli: true });
    expect(result.reason).toMatch(/another program/);
  });

  it("reports a missing CLI rather than a version", async () => {
    const fake = fakeSpawn((child) => {
      queueMicrotask(() => child.emitError(new Error("spawn pi ENOENT")));
    });
    const result = await probeVersion(fake.spawn, "pi", { env: ENV });
    expect(result).toMatchObject({ installed: false, version: null, reason: "spawn pi ENOENT" });
  });

  it("reports a spawn that throws synchronously", async () => {
    const result = await probeVersion(() => {
      throw new Error("EACCES");
    }, "codex", { env: ENV });
    expect(result).toMatchObject({ installed: false, reason: "EACCES" });
  });

  it("reports an engine that answered nothing", async () => {
    const fake = childAnswering(null, 0);
    const result = await probeVersion(fake.spawn, "pi", { env: ENV });
    expect(result).toMatchObject({ installed: false, version: null, reason: "no version was printed" });
  });

  it("does not probe an agent with no version line", async () => {
    const fake = fakeSpawn();
    const result = await probeVersion(fake.spawn, "hermes", { env: ENV });
    expect(result.installed).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("install plans", () => {
  it("names the official package and never returns an executable one-liner", () => {
    const plan = installPlan("claudeCode");
    expect(plan.npmPackage).toBe("@anthropic-ai/claude-code");
    expect(plan.needsNode).toBe(true);
    expect(plan.docsUrl).toMatch(/^https:\/\//);
  });

  it("keeps a vendor installer as text for the person to run themselves", () => {
    const plan = installPlan("hermes");
    expect(plan.vendorInstaller?.linux).toContain("install.sh");
    expect(plan.npmPackage).toBeUndefined();
  });

  it("keeps Pi and Oh My Pi on different packages", () => {
    expect(installPlan("pi").npmPackage).toBe("@earendil-works/pi-coding-agent");
    expect(installPlan("ohMyPi").npmPackage).toBe("@oh-my-pi/pi-coding-agent");
  });
});
