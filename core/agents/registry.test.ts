import { describe, expect, it } from "vitest";
import { AGENT_REGISTRY, agentDescriptor, parseVersionLine, tuiArgv } from "./registry.ts";
import type { AgentId } from "./contracts.ts";

const IDS: AgentId[] = ["hermes", "claudeCode", "codex", "openCode", "pi", "ohMyPi", "custom"];

describe("the one agent registry", () => {
  it("describes every agent exactly once, with an install route and a transport", () => {
    expect(Object.keys(AGENT_REGISTRY).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      const descriptor = agentDescriptor(id);
      expect(descriptor.id, id).toBe(id);
      expect(descriptor.displayName.length, id).toBeGreaterThan(0);
      expect(["stdio-jsonl", "stdio-json-rpc", "stdio-stream-json", "http"], id).toContain(descriptor.transport);
      expect(descriptor.install.docsUrl, id).toMatch(/^https:\/\//);
      expect(descriptor.capabilities, id).toBeTruthy();
    }
  });

  it("produces a fixed argv for each engine and never a shell one-liner", () => {
    for (const id of IDS) {
      for (const arg of tuiArgv(id)) {
        expect(arg, id).not.toMatch(/[|;&><`$]/);
      }
    }
    expect(tuiArgv("claudeCode")).toEqual(["claude"]);
    expect(tuiArgv("codex")).toEqual(["codex"]);
    expect(tuiArgv("openCode")).toEqual(["opencode"]);
    expect(tuiArgv("pi")).toEqual(["pi"]);
    expect(tuiArgv("ohMyPi")).toEqual(["omp"]);
    expect(tuiArgv("hermes")).toEqual(["hermes"]);
    expect(tuiArgv("custom")).toEqual([]);
  });

  it("keeps Pi and Oh My Pi fully independent: CLI, package, home and home variable", () => {
    const pi = agentDescriptor("pi");
    const omp = agentDescriptor("ohMyPi");
    expect(pi.cli).toBe("pi");
    expect(omp.cli).toBe("omp");
    expect(pi.install.npmPackage).toBe("@earendil-works/pi-coding-agent");
    expect(omp.install.npmPackage).toBe("@oh-my-pi/pi-coding-agent");
    expect(pi.homeDir).not.toBe(omp.homeDir);
    expect(pi.homeEnv).toBe("PI_HOME");
    expect(omp.homeEnv).toBe("OMP_HOME");
    expect(pi.homeEnv).not.toBe(omp.homeEnv);
  });

  it("does not pretend a custom ACP agent can steer", () => {
    const acp = agentDescriptor("custom");
    expect(acp.capabilities.steer.kind).toBe("none");
    expect(acp.capabilities.steer).toMatchObject({ reason: expect.any(String) });
    expect(acp.capabilities.nativeTui).toBe(false);
  });

  it("marks Hermes steering as next-boundary rather than native", () => {
    const hermes = agentDescriptor("hermes");
    expect(hermes.capabilities.steer.kind).toBe("next-boundary");
    if (hermes.capabilities.steer.kind === "next-boundary") {
      expect(hermes.capabilities.steer.note).toMatch(/boundary/);
    }
  });

  it("offers no vendor installer that this server could run itself", () => {
    // An installer is a command the person may run, never something the registry executes.
    for (const id of IDS) {
      const installer = agentDescriptor(id).install.vendorInstaller;
      if (!installer) continue;
      for (const [platform, command] of Object.entries(installer)) {
        expect(platform, id).toMatch(/darwin|linux|win32/);
        expect(typeof command).toBe("string");
      }
    }
  });

  it("reads each engine's own version line and rejects another program's", () => {
    expect(parseVersionLine("claudeCode", "2.1.291 (Claude Code)")).toBe("2.1.291");
    expect(parseVersionLine("claudeCode", "codex-cli 0.167.0")).toBeNull();
    expect(parseVersionLine("codex", "codex-cli 0.167.0")).toBe("0.167.0");
    expect(parseVersionLine("codex", "2.1.291 (Claude Code)")).toBeNull();
    expect(parseVersionLine("pi", "1.5.2")).toBe("1.5.2");
    expect(parseVersionLine("ohMyPi", "18.20.1")).toBe("18.20.1");
    expect(parseVersionLine("openCode", "1.19.5")).toBe("1.19.5");
    expect(parseVersionLine("hermes", "anything")).toBeNull();
  });

  it("declares a model catalog surface for every agent, and none where there is none", () => {
    for (const id of IDS) {
      const descriptor = agentDescriptor(id);
      expect(["native", "none"], id).toContain(descriptor.capabilities.modelCatalog);
    }
    // Claude Code's stream-json mode and a bare ACP handshake report no catalog.
    expect(agentDescriptor("claudeCode").capabilities.modelCatalog).toBe("none");
    expect(agentDescriptor("custom").capabilities.modelCatalog).toBe("none");
    expect(agentDescriptor("pi").capabilities.modelCatalog).toBe("native");
    expect(agentDescriptor("ohMyPi").capabilities.modelCatalog).toBe("native");
    expect(agentDescriptor("openCode").capabilities.modelCatalog).toBe("native");
    expect(agentDescriptor("codex").capabilities.modelCatalog).toBe("native");
    expect(agentDescriptor("hermes").capabilities.modelCatalog).toBe("native");
  });

  it("matches the image capability to what each adapter actually sends", () => {
    // Hermes' Runs body is text only, and OpenCode's V2 prompt body carries file references.
    expect(agentDescriptor("hermes").capabilities.images).toBe(false);
    expect(agentDescriptor("openCode").capabilities.images).toBe(false);
    // Claude wraps an image block, Pi and Oh My Pi send base64 in the prompt frame, and Codex
    // takes an inline data URL on turn/start.
    expect(agentDescriptor("claudeCode").capabilities.images).toBe(true);
    expect(agentDescriptor("pi").capabilities.images).toBe(true);
    expect(agentDescriptor("ohMyPi").capabilities.images).toBe(true);
    expect(agentDescriptor("codex").capabilities.images).toBe(true);
    expect(agentDescriptor("custom").capabilities.images).toBe(false);
  });

  it("gives every CLI agent a version probe except the HTTP-only ones and a configured ACP command", () => {
    for (const id of IDS) {
      const descriptor = agentDescriptor(id);
      if (descriptor.transport === "http" && id !== "openCode") {
        expect(descriptor.version, id).toBeUndefined();
        continue;
      }
      if (id === "custom") {
        // The executable is the person's own, with no agreed version line.
        expect(descriptor.version, id).toBeUndefined();
        continue;
      }
      expect(descriptor.version, id).toBeDefined();
    }
  });
});
