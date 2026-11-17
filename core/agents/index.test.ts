import { describe, expect, it } from "vitest";
import { createAdapter, instanceEnv, probeInstanceCatalog, type AgentInstanceConfig } from "./index.ts";
import { UnknownModelError, defaultOption, modelIdString, parseModelIdString, requireModel, type ModelOption } from "./models.ts";
import { fakeFetch, fakeSpawn } from "./testing/fake-child.ts";

const HOST_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/person",
  ANTHROPIC_API_KEY: "host-key",
  EACBOT_TOKEN: "control-plane",
};

const OPTIONS: ModelOption[] = [
  { ref: { providerId: "anthropic", modelId: "claude-sonnet" }, label: "Sonnet", billing: "subscription", providerId: "anthropic" },
  { ref: { providerId: "local", modelId: "qwen" }, label: "Qwen", billing: "local", providerId: "local" },
];

describe("model refs", () => {
  it("splits only on the first slash, so a model id may contain more", () => {
    expect(parseModelIdString("openrouter/qwen/qwen3")).toEqual({ providerId: "openrouter", modelId: "qwen/qwen3" });
    expect(parseModelIdString("noseparator")).toBeNull();
    expect(modelIdString({ providerId: "a", modelId: "b/c" })).toBe("a/b/c");
  });

  it("never swaps a model the person asked for", () => {
    expect(() => requireModel("pi", OPTIONS, "missing/model")).toThrow(UnknownModelError);
    expect(requireModel("pi", OPTIONS, "local/qwen").ref).toEqual({ providerId: "local", modelId: "qwen" });
  });

  it("falls back to the first option only when no configured default survives", () => {
    expect(defaultOption(OPTIONS, { providerId: "local", modelId: "qwen" })?.ref).toEqual({ providerId: "local", modelId: "qwen" });
    expect(defaultOption(OPTIONS, { providerId: "gone", modelId: "x" })?.ref).toEqual({ providerId: "anthropic", modelId: "claude-sonnet" });
    expect(defaultOption([], { providerId: "gone", modelId: "x" })).toBeNull();
  });

  it("keeps two options with one model id distinct by provider and billing", () => {
    const duplicate: ModelOption[] = [
      ...OPTIONS,
      { ref: { providerId: "anthropic", modelId: "claude-sonnet" }, label: "Sonnet (API key)", billing: "api-key", providerId: "anthropic" },
    ];
    const matches = duplicate.filter((option) => modelIdString(option.ref) === "anthropic/claude-sonnet");
    expect(matches.map((option) => option.billing)).toEqual(["subscription", "api-key"]);
  });
});

describe("the adapter facade", () => {
  function instance(overrides: Partial<AgentInstanceConfig> = {}): AgentInstanceConfig {
    return {
      instanceId: "inst-1",
      agentId: "pi",
      home: "/tmp/inst-1-home",
      auth: { mode: "subscription" },
      ...overrides,
    };
  }

  it("builds the agent's own adapter and gives it the vetted environment", async () => {
    const spawn = fakeSpawn((child) => {
      child.onLine((line) => {
        if (line.type === "new_session") child.send({ type: "response", id: line.id, success: true, data: { sessionFile: "/s.jsonl" } });
        if (line.type === "prompt") child.send({ type: "response", id: line.id, success: true, data: {} });
      });
    });
    const adapter = createAdapter(instance(), {
      spawn: spawn.spawn,
      fetch: fakeFetch(() => new Response(null, { status: 204 })).fetch,
      hostEnv: HOST_ENV,
    });
    expect(adapter.agentId).toBe("pi");
    await adapter.create({ sessionId: "conv-1", prompt: "hi" });
    const env = spawn.calls[0]!.options.env;
    expect(env.PI_HOME).toBe("/tmp/inst-1-home");
    expect(env.HOME).toBe("/tmp/inst-1-home");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.EACBOT_TOKEN).toBeUndefined();
  });

  it("carries an apiKey instance's own key, and only that one", async () => {
    const spawn = fakeSpawn((child) => {
      child.onLine((line) => {
        if (line.type === "new_session") child.send({ type: "response", id: line.id, success: true, data: {} });
        if (line.type === "prompt") child.send({ type: "response", id: line.id, success: true, data: {} });
      });
    });
    const adapter = createAdapter(instance({
      auth: { mode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: "instance-key" } },
    }), {
      spawn: spawn.spawn,
      fetch: fakeFetch(() => new Response(null, { status: 204 })).fetch,
      hostEnv: HOST_ENV,
    });
    await adapter.create({ sessionId: "conv-2", prompt: "hi" });
    const env = spawn.calls[0]!.options.env;
    expect(env.OPENAI_API_KEY).toBe("instance-key");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("refuses an HTTP agent with no server URL instead of guessing one", () => {
    expect(() =>
      createAdapter(instance({ agentId: "openCode" }), {
        spawn: fakeSpawn().spawn,
        fetch: fakeFetch(() => new Response(null, { status: 204 })).fetch,
        hostEnv: HOST_ENV,
      }),
    ).toThrow(/base URL/);
  });

  it("refuses Hermes with no bearer, because the server refuses every run without one", () => {
    expect(() =>
      createAdapter(instance({ agentId: "hermes", baseUrl: "http://127.0.0.1:8000" }), {
        spawn: fakeSpawn().spawn,
        fetch: fakeFetch(() => new Response(null, { status: 204 })).fetch,
        hostEnv: HOST_ENV,
      }),
    ).toThrow(/bearer/);
  });

  it("keeps two instances of one agent independent in home and env", () => {
    const first = instanceEnv(instance({ instanceId: "a", home: "/tmp/a" }), HOST_ENV);
    const second = instanceEnv(instance({ instanceId: "b", home: "/tmp/b" }), HOST_ENV);
    expect(first.PI_HOME).toBe("/tmp/a");
    expect(second.PI_HOME).toBe("/tmp/b");
    expect(first.HOME).not.toBe(second.HOME);
  });

  it("reads a native catalog with the instance's own home and billing", async () => {
    const spawn = fakeSpawn((child) => {
      child.onLine((line) => {
        if (line.type === "get_available_models") {
          child.send({
            type: "response", id: line.id, command: "get_available_models", success: true,
            data: { models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }] },
          });
        }
      });
    });
    const reading = await probeInstanceCatalog(instance({
      auth: { mode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: "k" } },
    }), {
      spawn: spawn.spawn,
      fetch: fakeFetch(() => new Response(null, { status: 204 })).fetch,
      hostEnv: HOST_ENV,
    });
    expect(reading).toMatchObject({
      state: "reported",
      options: [{ ref: { providerId: "openai", modelId: "gpt-4o" }, billing: "api-key" }],
    });
    // The probe uses the instance's own home, never the host's.
    expect(spawn.calls[0]!.options.env.PI_HOME).toBe("/tmp/inst-1-home");
    expect(spawn.calls[0]!.options.env.OPENAI_API_KEY).toBe("k");
    expect(spawn.calls[0]!.options.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("says a Claude instance has no catalog surface instead of listing nothing", async () => {
    const reading = await probeInstanceCatalog(instance({ agentId: "claudeCode" }), {
      spawn: fakeSpawn().spawn,
      fetch: fakeFetch(() => new Response(null, { status: 204 })).fetch,
      hostEnv: HOST_ENV,
    });
    expect(reading).toMatchObject({ state: "unknown", agentId: "claudeCode" });
  });

  it("gives Oh My Pi a different home variable from Pi", () => {
    const pi = instanceEnv(instance({ agentId: "pi", home: "/tmp/x" }), HOST_ENV);
    const omp = instanceEnv(instance({ agentId: "ohMyPi", home: "/tmp/x" }), HOST_ENV);
    // The adapter picks the engine's own variable; HOME is the shared fallback for the rest.
    expect(pi.HOME).toBe("/tmp/x");
    expect(omp.HOME).toBe("/tmp/x");
  });
});
