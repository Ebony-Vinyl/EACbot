import { describe, expect, it } from "vitest";
import { probeModelCatalog } from "./catalog.ts";
import { fakeFetch, fakeSpawn, jsonResponse, textResponse, type FakeChild } from "./testing/fake-child.ts";

const ENV = { PATH: "/usr/bin", HOME: "/tmp/home" };

describe("native model catalogs", () => {
  it("reads Pi's get_available_models as provider/id options", async () => {
    const spawn = fakeSpawn((child) => {
      child.onLine((line) => {
        if (line.type === "get_available_models") {
          child.send({
            type: "response",
            id: line.id,
            command: "get_available_models",
            success: true,
            data: { models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }] },
          });
        }
      });
    });
    const reading = await probeModelCatalog({
      agentId: "pi", spawn: spawn.spawn, env: ENV, billing: "api-key",
    });
    expect(reading).toEqual({
      state: "reported",
      agentId: "pi",
      options: [{
        ref: { providerId: "openai", modelId: "gpt-4o" },
        label: "GPT-4o",
        billing: "api-key",
        providerId: "openai",
      }],
      defaultId: "openai/gpt-4o",
    });
    expect(spawn.calls[0]!.args).toEqual(["--mode", "rpc", "--no-session"]);
  });

  it("reads Oh My Pi's catalog through its own binary", async () => {
    const spawn = fakeSpawn((child) => {
      child.onLine((line) => {
        if (line.type === "get_available_models") {
          child.send({
            type: "response", id: line.id, command: "get_available_models", success: true,
            data: { models: [{ provider: "local", id: "qwen" }] },
          });
        }
      });
    });
    const reading = await probeModelCatalog({ agentId: "ohMyPi", spawn: spawn.spawn, env: ENV, billing: "local" });
    expect(spawn.calls[0]!.command).toBe("omp");
    expect(reading).toMatchObject({ state: "reported", options: [expect.objectContaining({ label: "qwen" })] });
  });

  it("reports unknown when the engine refuses get_available_models", async () => {
    const spawn = fakeSpawn((child) => {
      child.onLine((line) => {
        if (line.type === "get_available_models") {
          child.send({ type: "response", id: line.id, command: "get_available_models", success: false });
        }
      });
    });
    const reading = await probeModelCatalog({ agentId: "pi", spawn: spawn.spawn, env: ENV, billing: "api-key" });
    expect(reading).toMatchObject({ state: "unknown", reason: expect.stringContaining("refused") });
  });

  it("reports unknown when the engine exits without answering", async () => {
    const spawn = fakeSpawn((child) => {
      child.onLine(() => {});
      queueMicrotask(() => child.emitExit(0));
    });
    const reading = await probeModelCatalog({ agentId: "pi", spawn: spawn.spawn, env: ENV, billing: "api-key" });
    expect(reading).toMatchObject({ state: "unknown" });
  });

  it("reads OpenCode's /api/model rows and drops a disabled model", async () => {
    const fetch = fakeFetch(() => jsonResponse({
      location: { directory: "/w" },
      data: [
        {
          id: "p/m", modelID: "m", providerID: "p", name: "M", enabled: true,
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [], limit: { context: 1000, output: 100 }, time: { released: 1 }, cost: [], status: "active",
        },
        {
          id: "p/off", modelID: "off", providerID: "p", name: "Off", enabled: false,
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [], limit: { context: 1000, output: 100 }, time: { released: 1 }, cost: [], status: "active",
        },
      ],
    }));
    const reading = await probeModelCatalog({
      agentId: "openCode", fetch: fetch.fetch, baseUrl: "http://127.0.0.1:4096", env: ENV, billing: "api-key",
    });
    expect(reading).toMatchObject({
      state: "reported",
      options: [{ ref: { providerId: "p", modelId: "m" }, label: "M", billing: "api-key", providerId: "p" }],
    });
  });

  it("reports unknown when OpenCode's server refuses the catalog", async () => {
    const fetch = fakeFetch(() => textResponse("no", 503));
    const reading = await probeModelCatalog({
      agentId: "openCode", fetch: fetch.fetch, baseUrl: "http://127.0.0.1:4096", env: ENV, billing: "api-key",
    });
    expect(reading).toMatchObject({ state: "unknown", reason: expect.stringContaining("503") });
  });

  it("pages Codex's model/list and skips hidden models", async () => {
    const spawn = fakeSpawn((child: FakeChild) => {
      child.onLine((line) => {
        if (line.method === "initialize") child.send({ jsonrpc: "2.0", id: line.id, result: {} });
        if (line.method === "model/list") {
          const cursor = (line.params as { cursor?: string }).cursor;
          if (cursor === "page-2") {
            child.send({ jsonrpc: "2.0", id: line.id, result: { data: [{ id: "gpt-b", displayName: "B", hidden: false }], nextCursor: null } });
          } else {
            child.send({
              jsonrpc: "2.0", id: line.id,
              result: {
                data: [{ id: "gpt-a", displayName: "A", hidden: false }, { id: "gpt-hidden", hidden: true }],
                nextCursor: "page-2",
              },
            });
          }
        }
      });
    });
    const reading = await probeModelCatalog({ agentId: "codex", spawn: spawn.spawn, env: ENV, billing: "subscription" });
    expect(reading).toMatchObject({
      state: "reported",
      options: [
        { ref: { providerId: "openai", modelId: "gpt-a" }, label: "A" },
        { ref: { providerId: "openai", modelId: "gpt-b" }, label: "B" },
      ],
    });
    expect(spawn.calls[0]!.args).toEqual(["app-server"]);
  });

  it("reads Hermes' picker rows and ignores rows without a provider", async () => {
    const fetch = fakeFetch(() => jsonResponse({
      data: [
        { provider: "openrouter", id: "qwen/qwen3", label: "Qwen 3" },
        { id: "nameless" },
      ],
    }));
    const reading = await probeModelCatalog({
      agentId: "hermes", fetch: fetch.fetch, baseUrl: "http://127.0.0.1:8642", token: "k", env: ENV, billing: "subscription",
    });
    expect(reading).toMatchObject({
      state: "reported",
      options: [{ ref: { providerId: "openrouter", modelId: "qwen/qwen3" }, label: "Qwen 3" }],
    });
  });

  it("declares Claude Code's catalog unknown rather than inventing one", async () => {
    const reading = await probeModelCatalog({ agentId: "claudeCode", env: ENV, billing: "subscription" });
    expect(reading.state).toBe("unknown");
    expect(reading).toMatchObject({ reason: expect.stringContaining("no model catalog") });
  });

  it("declares a custom ACP catalog unknown", async () => {
    const reading = await probeModelCatalog({ agentId: "custom", env: ENV, billing: "subscription" });
    expect(reading.state).toBe("unknown");
  });

  it("never throws when there is no executable to probe", async () => {
    const reading = await probeModelCatalog({ agentId: "pi", env: ENV, billing: "api-key" });
    expect(reading).toMatchObject({ state: "unknown", reason: "no executable to probe" });
  });
});
