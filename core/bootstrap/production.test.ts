import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CORE_CONFIG_VERSION } from "./config.ts";
import { buildProductionComposition, productionPorts, toInstanceConfig } from "./production.ts";
import type { CoreConfigAgent } from "./config.ts";
import { fakeFetch, fakeSpawn, jsonResponse } from "../agents/testing/fake-child.ts";
import { ProbedAgentCatalog } from "./agents.ts";
import { capabilitiesFor } from "../missions/capabilities.ts";

const open: Array<() => void> = [];

afterEach(() => {
  while (open.length > 0) open.pop()!();
});

interface FixtureOptions {
  readonly agents?: readonly Record<string, unknown>[];
  readonly environments?: readonly Record<string, unknown>[];
  readonly hostEnv?: Record<string, string | undefined>;
  readonly configure?: (child: ReturnType<typeof fakeSpawn>["children"][number]) => void;
  readonly respond?: (request: { url: string; method: string; headers: Record<string, string> }) => Response;
  readonly catalogTtlMs?: number;
  readonly writeConfig?: boolean;
}

const HOME = "/tmp/eac-fixture-home";

function fixture(options: FixtureOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "eac-production-"));
  const spawn = fakeSpawn((child) => {
    options.configure?.(child);
    child.onLine((line) => {
      if (line.type === "get_available_models") {
        child.send({
          type: "response",
          id: line.id,
          command: "get_available_models",
          success: true,
          data: { models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] },
        });
      }
    });
  });
  const http = fakeFetch((request) => (options.respond ? options.respond(request) : jsonResponse({ models: [] })));
  const configPath = join(dir, "core.json");
  if (options.writeConfig !== false) {
    writeFileSync(
      configPath,
      JSON.stringify({
        version: CORE_CONFIG_VERSION,
        agents: options.agents ?? [],
        environments: options.environments ?? [],
      }),
      { mode: 0o600 },
    );
  }
  const composition = buildProductionComposition({
    dataDir: dir,
    configPath,
    spawn: spawn.spawn,
    fetch: http.fetch,
    hostEnv: { PATH: "/usr/bin", HOME: "/home/host", ANTHROPIC_API_KEY: "host-key", EACBOT_TOKEN: "plane", ...options.hostEnv },
    ...(options.catalogTtlMs !== undefined ? { catalogTtlMs: options.catalogTtlMs } : {}),
    onError: () => {},
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    composition.close();
    rmSync(dir, { recursive: true, force: true });
  };
  open.push(close);
  return { dir, configPath, spawn, http, composition, close };
}

const pi = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "pi-main",
  agentId: "pi",
  home: join(HOME, "pi"),
  authMode: "subscription",
  ...overrides,
});

const hermes = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "hermes-main",
  agentId: "hermes",
  home: join(HOME, "hermes"),
  authMode: "subscription",
  baseUrl: "http://127.0.0.1:8642",
  token: { env: "HERMES_KEY" },
  ...overrides,
});

describe("the production composition", () => {
  it("is empty, with no invented agent, when there is no config file", () => {
    const f = fixture({ writeConfig: false });
    expect(f.composition.config.present).toBe(false);
    expect(f.composition.agents.list()).toEqual([]);
    expect(f.composition.agents.get("hermes")).toBeUndefined();
    expect(f.composition.agents.models("hermes")).toBeUndefined();
    expect(f.composition.instanceFor("hermes")).toBeUndefined();
    expect(f.composition.skipped).toEqual([]);
  });

  it("is empty when the data directory does not exist yet", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "eac-production-missing-")), "absent");
    const spawn = fakeSpawn();
    const composition = buildProductionComposition({
      dataDir: dir,
      spawn: spawn.spawn,
      fetch: fakeFetch(() => jsonResponse({})).fetch,
      hostEnv: {},
    });
    open.push(() => {
      composition.close();
      rmSync(dir, { recursive: true, force: true });
    });
    expect(composition.config.present).toBe(false);
    expect(composition.agents.list()).toEqual([]);
    expect(spawn.calls).toEqual([]);
  });

  it("builds a real adapter for a configured CLI instance and registers it for its kind", () => {
    const f = fixture({ agents: [pi()] });
    expect(f.composition.agents.list().map((descriptor) => descriptor.kind)).toEqual(["pi"]);
    expect(f.composition.instanceFor("pi")).toBe("pi-main");
    expect(f.composition.skipped).toEqual([]);
  });

  it("describes an agent from the registry, never with an instance's home or token", () => {
    const f = fixture({ agents: [hermes()], hostEnv: { HERMES_KEY: "super-secret-bearer" } });
    const descriptor = f.composition.agents.get("hermes");
    expect(descriptor).toMatchObject({ kind: "hermes", label: "Hermes" });
    const text = JSON.stringify(f.composition.agents.list());
    expect(text).not.toContain("super-secret-bearer");
    expect(text).not.toContain(HOME);
  });

  it("carries a probe's real model catalog and its billing", async () => {
    const f = fixture({ agents: [pi({ authMode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: { env: "PI_KEY" } } })], hostEnv: { PI_KEY: "k" } });
    await f.composition.refreshCatalogs();
    expect(f.composition.agents.models("pi")).toEqual([
      { ref: { agent: "pi", model: "openai/gpt-5", label: "GPT-5" } },
    ]);
    expect(f.spawn.calls[0]!.command).toBe("pi");
    expect(f.spawn.calls[0]!.options.env.OPENAI_API_KEY).toBe("k");
    expect(f.spawn.calls[0]!.options.env.PI_HOME).toBe(join(HOME, "pi"));
  });

  it("reports an unreadable catalog as unknown, with a reason and no models", async () => {
    const f = fixture({
      agents: [pi()],
      configure: (child) => {
        child.onLine((line) => {
          if (line.type === "get_available_models") child.send({ type: "response", id: line.id, command: "get_available_models", success: false });
        });
      },
    });
    await f.composition.refreshCatalogs();
    expect(f.composition.agents.models("pi")).toBeUndefined();
    expect(f.composition.agents.reading("pi")).toMatchObject({ state: "unknown", agentId: "pi" });
    expect(f.composition.agents.reading("pi")?.state === "unknown" ? f.composition.agents.reading("pi") : null).toMatchObject({
      reason: expect.stringMatching(/refused get_available_models/u),
    });
  });

  it("reports an engine that cannot be started as unknown rather than as a model list", async () => {
    const f = fixture({
      agents: [pi()],
      configure: (child) => {
        child.onLine(() => child.emitError(new Error("spawn pi ENOENT")));
      },
    });
    await f.composition.refreshCatalogs();
    expect(f.composition.agents.models("pi")).toBeUndefined();
    const reading = f.composition.agents.reading("pi");
    expect(reading).toMatchObject({ state: "unknown" });
    expect(JSON.stringify(reading)).toContain("ENOENT");
  });

  it("says a Claude instance has no catalog surface instead of listing nothing", async () => {
    const f = fixture({
      agents: [{ id: "claude-main", agentId: "claudeCode", home: join(HOME, "claude"), authMode: "subscription" }],
    });
    await f.composition.refreshCatalogs();
    expect(f.composition.agents.models("claudeCode")).toBeUndefined();
    expect(f.composition.agents.reading("claudeCode")).toMatchObject({ state: "unknown", agentId: "claudeCode" });
  });

  it("reads an HTTP agent's catalog with its bearer, and never returns the bearer", async () => {
    const f = fixture({
      agents: [hermes()],
      hostEnv: { HERMES_KEY: "bearer-value" },
      respond: () => jsonResponse({ data: [{ provider: "anthropic", id: "sonnet", label: "Sonnet" }] }),
    });
    await f.composition.refreshCatalogs();
    expect(f.composition.agents.models("hermes")).toEqual([
      { ref: { agent: "hermes", model: "anthropic/sonnet", label: "Sonnet" } },
    ]);
    expect(f.http.requests[0]!.headers.authorization).toBe("Bearer bearer-value");
    expect(JSON.stringify(f.composition.agents.list())).not.toContain("bearer-value");
  });

  it("shares one probe between concurrent callers", async () => {
    const f = fixture({ agents: [pi()] });
    const [first, second] = await Promise.all([
      f.composition.agents.refresh("pi"),
      f.composition.agents.refresh("pi"),
    ]);
    expect(first).toEqual(second);
    expect(f.spawn.calls).toHaveLength(1);
  });

  it("reuses a reading until the TTL passes", async () => {
    let now = 1_000;
    let probes = 0;
    const catalog = new ProbedAgentCatalog({
      kinds: ["pi"],
      describe: (kind) => ({ kind, label: kind, authModes: ["subscription"], capabilities: capabilitiesFor(kind), models: [] }),
      probe: () => {
        probes += 1;
        return Promise.resolve({
          state: "reported",
          agentId: "pi",
          options: [{ ref: { providerId: "p", modelId: "m" }, label: "m", billing: "subscription", providerId: "p" }],
          defaultId: "p/m",
        });
      },
      now: () => now,
      ttlMs: 100,
    });

    await catalog.refresh("pi");
    await catalog.refresh("pi");
    expect(probes).toBe(1);

    now += 500;
    await catalog.refresh("pi");
    expect(probes).toBe(2);
  });

  it("keeps two instances of one agent, and chooses the first enabled one", () => {
    const f = fixture({
      agents: [
        pi({ id: "pi-a", home: join(HOME, "pi-a") }),
        pi({ id: "pi-b", home: join(HOME, "pi-b") }),
      ],
    });
    expect(f.composition.instanceFor("pi")).toBe("pi-a");
    expect(f.composition.agents.list().map((descriptor) => descriptor.kind)).toEqual(["pi"]);
    expect(f.composition.skipped.map((entry) => entry.instanceId)).toEqual(["pi-b"]);
    expect(f.composition.skipped[0]!.reason).toMatch(/a task command names only an agent kind/u);
  });

  it("chooses the first enabled instance when an earlier one is disabled", () => {
    const f = fixture({
      agents: [
        pi({ id: "pi-a", home: join(HOME, "pi-a"), enabled: false }),
        pi({ id: "pi-b", home: join(HOME, "pi-b") }),
      ],
    });
    expect(f.composition.instanceFor("pi")).toBe("pi-b");
    expect(f.composition.skipped).toEqual([]);
  });

  it("skips an instance whose secret variable is unset, naming the variable and not a value", () => {
    const f = fixture({ agents: [hermes()], hostEnv: {} });
    expect(f.composition.instanceFor("hermes")).toBeUndefined();
    expect(f.composition.agents.list()).toEqual([]);
    expect(f.composition.skipped).toHaveLength(1);
    expect(f.composition.skipped[0]!.reason).toContain("HERMES_KEY");
    expect(f.composition.skipped[0]!.reason).toContain("token is not set");
  });

  it("skips one broken instance without taking a working one down", () => {
    const f = fixture({ agents: [hermes(), pi()] });
    expect(f.composition.skipped.map((entry) => entry.agentId)).toEqual(["hermes"]);
    expect(f.composition.agents.list().map((descriptor) => descriptor.kind)).toEqual(["pi"]);
  });

  it("seeds the configured computers without trusting them", () => {
    const f = fixture({
      environments: [
        { id: "box", label: "office box", kind: "ssh", host: "box.example", user: "person", authMode: "subscription" },
        {
          id: "laptop",
          label: "laptop",
          kind: "ssh",
          host: "laptop.example",
          user: "person",
          authMode: "apiKey",
          credentialRef: "cred-laptop",
        },
      ],
    });
    expect(f.composition.environments.list().map((environment) => environment.id)).toEqual(["box", "laptop"]);
    expect(f.composition.environments.lastTest("box")).toBeUndefined();
  });

  it("reports a check as not reachable when no transport opened a connection", async () => {
    const f = fixture({
      environments: [{ id: "box", label: "office box", kind: "ssh", host: "box.example", user: "person", authMode: "subscription" }],
    });
    const result = await f.composition.environments.check("box");
    expect(result.reachable).toBe(false);
    expect(result.detail).toMatch(/no transport/u);
  });

  it("leaves the terminal ports inert", () => {
    const f = fixture({ agents: [pi()] });
    expect(f.composition.terminals.list()).toEqual([]);
    expect(() => f.composition.terminalStreams.open({ terminalId: "t", sessionId: "s", scope: "owner", socket: fakeSocket() })).toThrow(
      /not configured/u,
    );
  });

  it("exposes the ports startServer takes", () => {
    const f = fixture({ agents: [pi()] });
    const ports = productionPorts(f.composition);
    expect(ports.agents).toBe(f.composition.agents);
    expect(ports.environments).toBe(f.composition.environments);
    expect(ports.terminals).toBe(f.composition.terminals);
    expect(ports.terminalStreams).toBe(f.composition.terminalStreams);
  });

  it("starts no mission, opens no socket and spawns nothing until asked", () => {
    const f = fixture({ agents: [pi(), hermes()] });
    expect(f.spawn.calls).toEqual([]);
    expect(f.http.requests).toEqual([]);
    expect(f.composition.runtime.store.listMissions()).toEqual([]);
  });

  it("writes no token to the missions database", async () => {
    const f = fixture({ agents: [pi({ authMode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: "instance-key-value" } })] });
    await f.composition.refreshCatalogs();
    f.composition.close();
    for (const name of ["missions.db", "missions.db-wal", "missions.db-shm"]) {
      let text = "";
      try {
        text = readFileSync(join(f.dir, name)).toString("latin1");
      } catch {
        continue;
      }
      expect(text).not.toContain("instance-key-value");
    }
  });
});

describe("a mission on a configured instance", () => {
  it("runs through the real adapter and settles the mission", async () => {
    const f = fixture({
      agents: [pi()],
      configure: (child) => {
        child.onLine((line) => {
          if (line.type === "new_session") {
            child.send({ type: "response", id: line.id, command: "new_session", success: true, data: { sessionFile: "/sessions/one.jsonl" } });
          }
          if (line.type === "prompt") {
            child.send({ type: "response", id: line.id, command: "prompt", success: true, data: {} });
            child.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
            child.send({ type: "agent_settled" });
          }
        });
      },
    });

    const result = await f.composition.runtime.execute({
      type: "mission.create",
      commandId: "create-1",
      title: "demo",
      prompt: "do the thing",
      agent: "pi",
      environment: { id: "env-1", label: "box", kind: "ssh", authMode: "subscription" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const mission = f.composition.runtime.store.requireMission(result.missionId);
    expect(mission.status).toBe("succeeded");
    expect(mission.agent).toBe("pi");
    expect(f.spawn.calls[0]!.command).toBe("pi");
    expect(f.spawn.calls[0]!.options.env.PI_HOME).toBe(join(HOME, "pi"));
    expect(f.spawn.calls[0]!.options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(f.spawn.calls[0]!.options.env.EACBOT_TOKEN).toBeUndefined();

    const output = f.composition.runtime.log
      .events(mission.id)
      .filter((entry) => entry.type === "run.output")
      .map((entry) => (entry.payload as { text?: string }).text);
    expect(output).toContain("done");
  });

  it("refuses a mission for a kind no instance serves", async () => {
    const f = fixture({ agents: [pi()] });
    await expect(
      f.composition.runtime.execute({
        type: "mission.create",
        commandId: "create-2",
        title: "demo",
        prompt: "go",
        agent: "codex",
        environment: { id: "env-1", label: "box", kind: "ssh", authMode: "subscription" },
      }),
    ).rejects.toThrow(/no adapter registered for codex/u);
  });

  it("passes the instance's configured model when the caller names none", async () => {
    const f = fixture({
      agents: [pi({ model: "openai/gpt-5" })],
      configure: (child) => {
        child.onLine((line) => {
          if (line.type === "new_session") {
            child.send({ type: "response", id: line.id, command: "new_session", success: true, data: { sessionFile: "/s.jsonl" } });
          }
          if (line.type === "set_model") {
            child.send({ type: "response", id: line.id, command: "set_model", success: true, data: {} });
          }
          if (line.type === "prompt") {
            child.send({ type: "response", id: line.id, command: "prompt", success: true, data: {} });
            child.send({ type: "agent_settled" });
          }
        });
      },
    });
    await f.composition.runtime.execute({
      type: "mission.create",
      commandId: "create-3",
      title: "demo",
      prompt: "go",
      agent: "pi",
      environment: { id: "env-1", label: "box", kind: "ssh", authMode: "subscription" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const setModel = f.spawn.children[0]!.framesOfType("set_model")[0];
    expect(setModel).toMatchObject({ provider: "openai", modelId: "gpt-5" });
  });
});

describe("instance mapping", () => {
  const agent = (overrides: Partial<CoreConfigAgent> = {}): CoreConfigAgent => ({
    id: "pi-main",
    agentId: "pi",
    home: "/home/person/.eacbot/pi",
    authMode: "subscription",
    enabled: true,
    ...overrides,
  });

  it("maps a subscription instance with no credential", () => {
    expect(toInstanceConfig(agent(), {})).toEqual({
      instanceId: "pi-main",
      agentId: "pi",
      home: "/home/person/.eacbot/pi",
      auth: { mode: "subscription" },
    });
  });

  it("resolves an apiKey literal and a named variable", () => {
    const literal = toInstanceConfig(
      agent({ authMode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: "literal" } }),
      {},
    );
    expect(literal.auth).toEqual({ mode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: "literal" } });
    const named = toInstanceConfig(
      agent({ authMode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: { env: "PI_KEY" } } }),
      { PI_KEY: "from-env" },
    );
    expect(named.auth).toEqual({ mode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: "from-env" } });
  });

  it("refuses an apiKey instance whose variable is unset", () => {
    expect(() =>
      toInstanceConfig(agent({ authMode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: { env: "PI_KEY" } } }), {}),
    ).toThrow(/environment variable PI_KEY/u);
  });

  it("carries a compatible endpoint's URL and credential", () => {
    const instance = toInstanceConfig(
      agent({
        authMode: "compatibleEndpoint",
        provider: { baseUrl: "https://api.example/v1", apiKeyName: "OPENAI_API_KEY", apiKey: { env: "PI_KEY" } },
      }),
      { PI_KEY: "k" },
    );
    expect(instance.auth).toEqual({
      mode: "compatibleEndpoint",
      compatibleEndpoint: { baseUrl: "https://api.example/v1", apiKeyName: "OPENAI_API_KEY", apiKeyValue: "k" },
    });
  });

  it("carries a local endpoint with no credential", () => {
    const instance = toInstanceConfig(agent({ authMode: "local", provider: { baseUrl: "http://127.0.0.1:1234" } }), {});
    expect(instance.auth).toEqual({ mode: "local", local: { baseUrl: "http://127.0.0.1:1234" } });
  });

  it("passes a custom ACP agent its executable and argv", () => {
    const instance = toInstanceConfig(
      agent({ agentId: "custom", cli: "/opt/agent", args: ["acp", "--quiet"] }),
      {},
    );
    expect(instance).toMatchObject({ cli: "/opt/agent", command: "/opt/agent", args: ["acp", "--quiet"] });
  });

  it("resolves an HTTP instance's bearer", () => {
    const instance = toInstanceConfig(
      agent({ agentId: "hermes", baseUrl: "http://127.0.0.1:8642", token: { env: "HERMES_KEY" } }),
      { HERMES_KEY: "bearer" },
    );
    expect(instance.token).toBe("bearer");
  });
});

function fakeSocket() {
  return {
    write: () => true,
    end: () => {},
    destroy: () => {},
    on: () => undefined,
  };
}

describe("the probe cache", () => {
  it("never turns a rejected probe into a model list", async () => {
    const catalog = new ProbedAgentCatalog({
      kinds: ["pi"],
      describe: (kind) => ({ kind, label: kind, authModes: ["subscription"], capabilities: capabilitiesFor(kind), models: [] }),
      probe: () => Promise.reject(new Error("probe exploded")),
    });
    const reading = await catalog.refresh("pi");
    expect(reading).toMatchObject({ state: "unknown", reason: "probe exploded" });
    expect(catalog.models("pi")).toBeUndefined();
  });
});
