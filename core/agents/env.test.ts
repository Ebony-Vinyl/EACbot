import { describe, expect, it } from "vitest";
import { buildAgentEnv, isBillingName, isControlPlaneName, requiresCredential } from "./env.ts";

const host = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/person",
  LANG: "en_US.UTF-8",
  // A key inherited from the host shell must not reach a subscription engine.
  ANTHROPIC_API_KEY: "host-anthropic-key",
  OPENAI_API_KEY: "host-openai-key",
  // This control plane's own secrets.
  EACBOT_TOKEN: "control-plane-token",
  EAC_LICENSE_KEY: "license",
  EAC_CLOUD_AI_TOKEN: "cloud-token",
  EACBOT_ADMIN_URL: "https://admin.example",
  // Neither an allowlisted name nor a credential.
  RANDOM_THING: "value",
};

describe("agent environment", () => {
  it("passes only allowlisted names and never a host billing identity", () => {
    const env = buildAgentEnv({ host, auth: { mode: "subscription" } });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.RANDOM_THING).toBeUndefined();
  });

  it("strips control-plane secrets under every name and casing", () => {
    const env = buildAgentEnv({
      host: { ...host, eacbot_token: "lower", Eac_Cloud_Ai_Token: "mixed", OPENMAUSBOT_TOKEN: "old" },
      auth: { mode: "subscription" },
    });
    for (const name of Object.keys(env)) {
      expect(isControlPlaneName(name), name).toBe(false);
    }
    expect(env.EACBOT_TOKEN).toBeUndefined();
    expect(env.eacbot_token).toBeUndefined();
    expect(env.Eac_Cloud_Ai_Token).toBeUndefined();
    expect(env.OPENMAUSBOT_TOKEN).toBeUndefined();
  });

  it("adds exactly the credential the chosen auth mode names", () => {
    const env = buildAgentEnv({
      host,
      auth: { mode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: "instance-key" } },
    });
    expect(env.OPENAI_API_KEY).toBe("instance-key");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("keeps an apiKey instance and a subscription instance on separate billing", () => {
    const subscription = buildAgentEnv({ host, auth: { mode: "subscription" } });
    const apiKey = buildAgentEnv({ host, auth: { mode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: "k" } } });
    expect(Object.keys(subscription).some(isBillingName)).toBe(false);
    expect(Object.keys(apiKey).filter(isBillingName)).toEqual(["OPENAI_API_KEY"]);
  });

  it("refuses a credential name that is not a provider credential", () => {
    expect(() =>
      buildAgentEnv({ host, auth: { mode: "apiKey", apiKey: { name: "EACBOT_TOKEN", value: "x" } } }),
    ).toThrow(/not a provider credential name/);
  });

  it("carries the endpoint for a compatible endpoint and for a local server", () => {
    const compatible = buildAgentEnv({
      host,
      auth: {
        mode: "compatibleEndpoint",
        compatibleEndpoint: { baseUrl: "https://api.example/v1", apiKeyName: "OPENAI_API_KEY", apiKeyValue: "k" },
      },
    });
    expect(compatible.AGENT_BASE_URL).toBe("https://api.example/v1");
    expect(compatible.OPENAI_API_KEY).toBe("k");

    const local = buildAgentEnv({ host, auth: { mode: "local", local: { baseUrl: "http://127.0.0.1:11434/v1" } } });
    expect(local.AGENT_BASE_URL).toBe("http://127.0.0.1:11434/v1");
    expect(Object.keys(local).some(isBillingName)).toBe(false);
  });

  it("never lets an instance override reintroduce a control-plane name", () => {
    const env = buildAgentEnv({
      host,
      instance: { HOME: "/tmp/instance-home", EAC_CLOUD_AI_TOKEN: "smuggled", EACBOT_TOKEN: "smuggled" },
      auth: { mode: "subscription" },
    });
    expect(env.HOME).toBe("/tmp/instance-home");
    expect(env.EAC_CLOUD_AI_TOKEN).toBeUndefined();
    expect(env.EACBOT_TOKEN).toBeUndefined();
  });

  it("says which auth modes need a stored credential", () => {
    expect(requiresCredential({ mode: "subscription" })).toBe(false);
    expect(requiresCredential({ mode: "local", local: { baseUrl: "http://127.0.0.1:1" } })).toBe(false);
    expect(requiresCredential({ mode: "apiKey", apiKey: { name: "OPENAI_API_KEY", value: "k" } })).toBe(true);
    expect(requiresCredential({
      mode: "compatibleEndpoint",
      compatibleEndpoint: { baseUrl: "https://x", apiKeyName: "OPENAI_API_KEY", apiKeyValue: "k" },
    })).toBe(true);
  });
});
