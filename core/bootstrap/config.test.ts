import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CORE_CONFIG_VERSION,
  CoreConfigError,
  coreConfigPath,
  describeSecretRef,
  emptyCoreConfig,
  loadCoreConfig,
  parseCoreConfig,
  resolveSecret,
  saveCoreConfig,
  type CoreConfig,
} from "./config.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eac-core-config-"));
  dirs.push(dir);
  return dir;
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: CORE_CONFIG_VERSION,
    agents: [
      {
        id: "hermes-main",
        agentId: "hermes",
        home: "/home/person/.eacbot/hermes",
        authMode: "subscription",
        baseUrl: "http://127.0.0.1:8642",
        token: { env: "HERMES_API_SERVER_KEY" },
      },
    ],
    environments: [
      {
        id: "box",
        label: "office box",
        kind: "ssh",
        host: "box.example",
        user: "person",
        authMode: "subscription",
      },
    ],
    ...overrides,
  };
}

describe("core.json loading", () => {
  it("treats a missing file and a missing directory as an empty configuration", () => {
    const dir = join(tempDir(), "does-not-exist");
    const loaded = loadCoreConfig(join(dir, "core.json"));
    expect(loaded.present).toBe(false);
    expect(loaded.config).toEqual(emptyCoreConfig());
    expect(loaded.config.agents).toEqual([]);
  });

  it("resolves the default path under the data directory", () => {
    expect(coreConfigPath({ dataDir: "/var/lib/eacbot" })).toBe(join("/var/lib/eacbot", "core.json"));
  });

  it("reads a complete document", () => {
    const dir = tempDir();
    const path = join(dir, "core.json");
    writeFileSync(path, JSON.stringify(document()), { mode: 0o600 });
    const loaded = loadCoreConfig(path);
    expect(loaded.present).toBe(true);
    expect(loaded.config.agents[0]).toMatchObject({
      id: "hermes-main",
      agentId: "hermes",
      authMode: "subscription",
      baseUrl: "http://127.0.0.1:8642",
      enabled: true,
      token: { env: "HERMES_API_SERVER_KEY" },
    });
    expect(loaded.config.environments[0]).toMatchObject({ id: "box", kind: "ssh", host: "box.example", user: "person" });
    expect(loaded.config.environments[0]).not.toHaveProperty("port");
  });

  it("refuses a document that is not JSON without echoing the file", () => {
    const dir = tempDir();
    const path = join(dir, "core.json");
    writeFileSync(path, '{ "version": 1, "agents": [ "sk-secret-value"', { mode: 0o600 });
    let message = "";
    try {
      loadCoreConfig(path);
    } catch (error) {
      expect(error).toBeInstanceOf(CoreConfigError);
      message = (error as Error).message;
    }
    expect(message).toContain("not valid JSON");
    expect(message).not.toContain("sk-secret-value");
  });

  it("narrows a file other users can read before using it", () => {
    const dir = tempDir();
    const path = join(dir, "core.json");
    writeFileSync(path, JSON.stringify(document()), { mode: 0o644 });
    loadCoreConfig(path);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a version it does not understand", () => {
    expect(() => parseCoreConfig({ version: 2, agents: [] })).toThrow(/unsupported version/u);
    expect(() => parseCoreConfig({ agents: [] })).toThrow(/unsupported version/u);
  });
});

describe("core.json schema", () => {
  it("rejects an unknown field at every level", () => {
    expect(() => parseCoreConfig({ ...document(), extra: true })).toThrow(/unknown field extra/u);
    const agents = document().agents as Record<string, unknown>[];
    expect(() => parseCoreConfig({ ...document(), agents: [{ ...agents[0], tokens: "x" }] })).toThrow(
      /unknown field tokens/u,
    );
    const environments = document().environments as Record<string, unknown>[];
    expect(() =>
      parseCoreConfig({ ...document(), environments: [{ ...environments[0], password: "x" }] }),
    ).toThrow(/unknown field password/u);
  });

  it("rejects two agents with one id, and two environments with one id", () => {
    const agents = document().agents as Record<string, unknown>[];
    expect(() => parseCoreConfig({ ...document(), agents: [agents[0], agents[0]] })).toThrow(/two entries with id/u);
    const environments = document().environments as Record<string, unknown>[];
    expect(() =>
      parseCoreConfig({ ...document(), environments: [environments[0], environments[0]] }),
    ).toThrow(/two entries with id/u);
  });

  it("requires an absolute instance home", () => {
    const agents = document().agents as Record<string, unknown>[];
    expect(() => parseCoreConfig({ ...document(), agents: [{ ...agents[0], home: "./hermes" }] })).toThrow(
      /home: must be an absolute path/u,
    );
  });

  it("requires Hermes to name a server and a bearer, and refuses a CLI on an HTTP agent", () => {
    const base = (document().agents as Record<string, unknown>[])[0]!;
    expect(() => parseCoreConfig({ ...document(), agents: [{ ...base, token: undefined }] })).toThrow(
      /token: hermes needs a bearer token/u,
    );
    expect(() => parseCoreConfig({ ...document(), agents: [{ ...base, baseUrl: undefined }] })).toThrow(
      /baseUrl: hermes needs the server's base URL/u,
    );
    expect(() => parseCoreConfig({ ...document(), agents: [{ ...base, cli: "hermes" }] })).toThrow(
      /cli: is not used by an HTTP agent/u,
    );
  });

  it("lets a spawned agent name a CLI and no base URL", () => {
    const parsed = parseCoreConfig({
      ...document(),
      agents: [
        { id: "pi-main", agentId: "pi", home: "/home/person/.eacbot/pi", authMode: "subscription", cli: "/usr/local/bin/pi" },
      ],
    });
    expect(parsed.agents[0]).toMatchObject({ agentId: "pi", cli: "/usr/local/bin/pi" });
  });

  it("keeps a spawned agent's extra environment inside the allowlist", () => {
    const agent = { id: "pi-main", agentId: "pi", home: "/home/person/.eacbot/pi", authMode: "subscription" };
    expect(() =>
      parseCoreConfig({ ...document(), agents: [{ ...agent, env: { ANTHROPIC_API_KEY: "k" } }] }),
    ).toThrow(/names a provider credential/u);
    expect(() =>
      parseCoreConfig({ ...document(), agents: [{ ...agent, env: { EACBOT_TOKEN: "k" } }] }),
    ).toThrow(/control-plane secret/u);
    expect(() => parseCoreConfig({ ...document(), agents: [{ ...agent, env: { NODE_OPTIONS: "--x" } }] })).toThrow(
      /not in the agent environment allowlist/u,
    );
    expect(() => parseCoreConfig({ ...document(), agents: [{ ...agent, env: { HOME: "/elsewhere" } }] })).toThrow(
      /is set from this instance's home field/u,
    );
    expect(parseCoreConfig({ ...document(), agents: [{ ...agent, env: { LANG: "en_US.UTF-8" } }] }).agents[0]?.env).toEqual({
      LANG: "en_US.UTF-8",
    });
  });

  it("ties each credential to exactly one auth mode", () => {
    const agent = { id: "pi-main", agentId: "pi", home: "/home/person/.eacbot/pi" };
    expect(() =>
      parseCoreConfig({ ...document(), agents: [{ ...agent, authMode: "apiKey" }] }),
    ).toThrow(/apiKey: is required/u);
    expect(() =>
      parseCoreConfig({
        ...document(),
        agents: [{ ...agent, authMode: "subscription", apiKey: { name: "OPENAI_API_KEY", value: "k" } }],
      }),
    ).toThrow(/carries no apiKey or provider/u);
    expect(() =>
      parseCoreConfig({ ...document(), agents: [{ ...agent, authMode: "compatibleEndpoint" }] }),
    ).toThrow(/provider: is required/u);
    expect(() =>
      parseCoreConfig({
        ...document(),
        agents: [
          {
            ...agent,
            authMode: "compatibleEndpoint",
            provider: { baseUrl: "https://api.example", apiKeyName: "NOT_A_PROVIDER_KEY", apiKey: "k" },
          },
        ],
      }),
    ).toThrow(/not a provider credential name/u);
    expect(() =>
      parseCoreConfig({
        ...document(),
        agents: [{ ...agent, authMode: "local", provider: { baseUrl: "http://127.0.0.1:1234", apiKeyName: "OPENAI_API_KEY", apiKey: "k" } }],
      }),
    ).toThrow(/a local endpoint carries no credential/u);
  });

  it("reads a model selection as a string or an object", () => {
    const agent = { id: "pi-main", agentId: "pi", home: "/home/person/.eacbot/pi", authMode: "subscription" };
    expect(parseCoreConfig({ ...document(), agents: [{ ...agent, model: "openai/gpt-5" }] }).agents[0]?.model).toEqual({
      providerId: "openai",
      modelId: "gpt-5",
    });
    expect(
      parseCoreConfig({ ...document(), agents: [{ ...agent, model: { providerId: "a", modelId: "b", variant: "high" } }] }).agents[0]
        ?.model,
    ).toEqual({ providerId: "a", modelId: "b", variant: "high" });
    expect(() => parseCoreConfig({ ...document(), agents: [{ ...agent, model: "noseparator" }] })).toThrow(
      /provider\/model/u,
    );
  });

  it("requires a custom ACP agent's executable and allows only it an argv", () => {
    const agent = { id: "mine", agentId: "custom", home: "/home/person/.eacbot/mine", authMode: "subscription" };
    expect(() => parseCoreConfig({ ...document(), agents: [agent] })).toThrow(/cli: a custom ACP agent needs its executable/u);
    expect(
      parseCoreConfig({ ...document(), agents: [{ ...agent, cli: "/opt/agent", args: ["acp"] }] }).agents[0]?.args,
    ).toEqual(["acp"]);
    expect(() =>
      parseCoreConfig({
        ...document(),
        agents: [{ id: "pi-main", agentId: "pi", home: "/home/person/.eacbot/pi", authMode: "subscription", args: ["x"] }],
      }),
    ).toThrow(/args: is only for a custom ACP agent/u);
  });

  it("requires a host and a user for an ssh computer, and an address for a local one", () => {
    const environment = { id: "box", label: "box", kind: "ssh", authMode: "subscription" };
    expect(() => parseCoreConfig({ ...document(), environments: [environment] })).toThrow(/needs a host and a user/u);
    expect(() =>
      parseCoreConfig({ ...document(), environments: [{ id: "here", label: "here", kind: "local", authMode: "local" }] }),
    ).toThrow(/baseUrl: a local computer needs the address/u);
    expect(() =>
      parseCoreConfig({
        ...document(),
        environments: [{ id: "box", label: "box", kind: "ssh", host: "h", user: "u", authMode: "apiKey" }],
      }),
    ).toThrow(/credentialRef: is required/u);
  });

  it("accepts an environment with no environments key", () => {
    const { environments: _dropped, ...rest } = document();
    expect(parseCoreConfig(rest).environments).toEqual([]);
  });

  it("never repeats a secret value in a refusal", () => {
    const agents = document().agents as Record<string, unknown>[];
    let message = "";
    try {
      parseCoreConfig({ ...document(), agents: [{ ...agents[0], home: "relative", token: "sk-live-abc123" }] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("home");
    expect(message).not.toContain("sk-live-abc123");
  });
});

describe("core.json writing", () => {
  it("writes owner-only permissions and reads back the same document", () => {
    const dir = tempDir();
    const path = join(dir, "core.json");
    const config: CoreConfig = parseCoreConfig(document());
    saveCoreConfig(path, config);

    const file = statSync(path);
    if (process.platform !== "win32") {
      expect(file.mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(loadCoreConfig(path).config).toEqual(config);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  it("creates a missing directory with owner-only permissions", () => {
    const dir = join(tempDir(), "nested", "data");
    const path = join(dir, "core.json");
    saveCoreConfig(path, emptyCoreConfig());
    expect(statSync(path).isFile()).toBe(true);
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses to write a document it would refuse to read", () => {
    const dir = tempDir();
    const path = join(dir, "core.json");
    const bad = { version: CORE_CONFIG_VERSION, agents: [{ id: "x" }], environments: [] } as unknown as CoreConfig;
    expect(() => saveCoreConfig(path, bad)).toThrow(CoreConfigError);
  });
});

describe("secret references", () => {
  it("resolves a literal and a named variable, and reports an unset one as absent", () => {
    expect(resolveSecret("literal", {})).toBe("literal");
    expect(resolveSecret({ env: "HERMES_KEY" }, { HERMES_KEY: "value" })).toBe("value");
    expect(resolveSecret({ env: "HERMES_KEY" }, { HERMES_KEY: "" })).toBeUndefined();
    expect(resolveSecret({ env: "HERMES_KEY" }, {})).toBeUndefined();
    expect(resolveSecret("", {})).toBeUndefined();
  });

  it("describes where a secret lives without repeating it", () => {
    expect(describeSecretRef({ env: "HERMES_KEY" })).toBe("environment variable HERMES_KEY");
    expect(describeSecretRef("sk-live-abc123")).toBe("the literal in core.json");
  });
});
