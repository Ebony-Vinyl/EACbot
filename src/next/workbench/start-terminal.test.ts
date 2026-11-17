import { describe, expect, it } from "vitest";

import { TERMINAL_TOOLS, isTerminalTool, startTerminal, startTerminalBody, toolForAgent } from "./start-terminal.ts";

describe("starting an agent terminal", () => {
  it("sends only the fields it was given, because the route refuses unknown ones", () => {
    expect(startTerminalBody({ environmentId: "env-1", tool: "hermes" })).toEqual({ environmentId: "env-1", tool: "hermes" });
  });

  it("carries the mission, run and size when it has them", () => {
    expect(startTerminalBody({
      environmentId: "env-1",
      tool: "claude",
      missionId: "m1",
      runId: "r1",
      cols: 100,
      rows: 30,
      name: "Hermes",
    })).toEqual({ environmentId: "env-1", tool: "claude", missionId: "m1", runId: "r1", cols: 100, rows: 30, name: "Hermes" });
  });

  it("posts to /terminals and answers the new terminal", async () => {
    const calls: Array<{ path: string; options: unknown }> = [];
    const client = {
      baseUrl: "/api/v1",
      request: async <T>(path: string, options?: unknown): Promise<T> => {
        calls.push({ path, options });
        return { terminal: { id: "t9", kind: "nativeTui", missionId: "m1", runId: "r1", createdAt: "2026-01-01T00:00:00.000Z" } } as T;
      },
    };
    const terminal = await startTerminal({ environmentId: "env-1", tool: "codex", missionId: "m1" }, client);
    expect(terminal.id).toBe("t9");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/terminals");
    expect(calls[0]?.options).toMatchObject({ method: "POST", body: { environmentId: "env-1", tool: "codex", missionId: "m1" } });
  });

  it("maps every agent kind the protocol defines to a tool the route accepts", () => {
    expect(toolForAgent("hermes")).toBe("hermes");
    expect(toolForAgent("claudeCode")).toBe("claude");
    expect(toolForAgent("codex")).toBe("codex");
    expect(toolForAgent("openCode")).toBe("opencode");
    expect(toolForAgent("pi")).toBe("pi");
    expect(toolForAgent("ohMyPi")).toBe("omp");
    expect(toolForAgent("custom")).toBeNull();
  });

  it("knows exactly the tools the route accepts", () => {
    for (const tool of TERMINAL_TOOLS) expect(isTerminalTool(tool)).toBe(true);
    expect(isTerminalTool("vim")).toBe(false);
    expect(TERMINAL_TOOLS).toHaveLength(6);
  });
});
