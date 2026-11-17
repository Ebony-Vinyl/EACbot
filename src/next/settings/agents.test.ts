import { describe, expect, it } from "vitest";

import type { AgentDescriptor, ModelCatalogEntry } from "../../../packages/agent-protocol/agents.ts";
import {
  AUTH_MODE_DETAILS, AUTH_MODE_LABELS, CANNOT_LIST_MODELS, authModesFor, capabilityRows, defaultAuthMode,
  installState, missingSelectionNotice, modelCatalogState, modelLabel, selectedStillListed,
} from "./agents.ts";

const agent = (overrides: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
  kind: "hermes",
  label: "Hermes",
  authModes: ["subscription", "apiKey", "compatibleEndpoint", "local"],
  capabilities: {
    events: true,
    steer: { kind: "next-boundary", note: "at the tool boundary" },
    interrupt: true,
    resume: true,
    cancel: true,
    approval: true,
    questions: true,
    nativeTui: true,
    modelCatalog: true,
    subagents: true,
    images: false,
    usage: true,
    fileChanges: true,
  },
  models: [],
  ...overrides,
});

const model = (id: string, label?: string): ModelCatalogEntry => ({
  ref: { agent: "hermes", model: id, ...(label !== undefined ? { label } : {}) },
});

describe("installed state, as the computer's own probe answered", () => {
  it("reports the version the executable printed", () => {
    expect(installState("hermes", [{ name: "hermes", status: "installed", path: "/usr/local/bin/hermes", version: "0.9.1" }])).toEqual({
      state: "installed", version: "0.9.1", path: "/usr/local/bin/hermes",
    });
  });

  it("reports an outdated install with its version", () => {
    expect(installState("codex", [{ name: "codex", status: "outdated", path: "/usr/bin/codex", version: "0.2.0" }])).toMatchObject({
      state: "outdated", version: "0.2.0",
    });
  });

  it("reports a missing executable", () => {
    expect(installState("pi", [{ name: "pi", status: "missing", path: null, version: null }])).toEqual({ state: "missing" });
  });

  it("reports a probe that failed, with the reason, rather than guessing", () => {
    expect(installState("ohMyPi", [{ name: "omp", status: "probeFailed", path: null, version: null, detail: "timed out" }])).toEqual({
      state: "probeFailed", detail: "timed out",
    });
  });

  it("reports that a path runs another program instead of claiming this one", () => {
    expect(installState("claudeCode", [{ name: "claude", status: "notThisTool", path: "/usr/bin/claude", version: null }])).toEqual({
      state: "notThisTool", path: "/usr/bin/claude",
    });
  });

  it("claims nothing when the computer has not been probed", () => {
    expect(installState("hermes", undefined)).toEqual({ state: "unchecked" });
    expect(installState("hermes", [])).toEqual({ state: "unchecked" });
  });

  it("claims nothing for an agent with no fixed executable", () => {
    expect(installState("custom", [{ name: "hermes", status: "installed", path: "/x", version: "1" }])).toEqual({ state: "unchecked" });
  });

  it("maps each agent to its own executable, so Pi and Oh My Pi never share a probe", () => {
    const tools = [
      { name: "pi", status: "installed" as const, path: "/bin/pi", version: "1.0.0" },
      { name: "omp", status: "missing" as const, path: null, version: null },
    ];
    expect(installState("pi", tools)).toMatchObject({ state: "installed", version: "1.0.0" });
    expect(installState("ohMyPi", tools)).toEqual({ state: "missing" });
  });
});

describe("the model list comes from the API, or says it cannot", () => {
  it("lists what the engine reported", () => {
    const state = modelCatalogState(agent(), { agent: "hermes", models: [model("hermes-4", "Hermes 4")], reported: true });
    expect(state).toEqual({ state: "listed", entries: [model("hermes-4", "Hermes 4")] });
  });

  it("says the agent cannot list models when the response says it did not report", () => {
    const state = modelCatalogState(agent({ capabilities: { ...agent().capabilities, modelCatalog: false } }), {
      agent: "claudeCode", models: [], reported: false,
    });
    expect(state).toMatchObject({ state: "unknown" });
    expect(state.state === "unknown" && state.reason).toContain(CANNOT_LIST_MODELS);
  });

  it("keeps an empty catalog distinct from an unreadable one", () => {
    expect(modelCatalogState(agent(), { agent: "hermes", models: [], reported: true })).toMatchObject({ state: "empty" });
  });

  it("shows a loading state before the answer arrives, for an agent that can list", () => {
    expect(modelCatalogState(agent(), undefined)).toEqual({ state: "loading" });
  });

  it("says it cannot list models before asking, for an agent that never can", () => {
    const state = modelCatalogState(agent({ capabilities: { ...agent().capabilities, modelCatalog: false } }), undefined);
    expect(state).toEqual({ state: "unknown", reason: CANNOT_LIST_MODELS });
  });

  it("never invents a model for an agent whose catalog is unknown", () => {
    const state = modelCatalogState(agent({ capabilities: { ...agent().capabilities, modelCatalog: false } }), {
      agent: "claudeCode", models: [], reported: false,
    });
    expect(state).not.toHaveProperty("entries");
  });

  it("prefers the engine's own label and falls back to the model id", () => {
    expect(modelLabel(model("hermes-4", "Hermes 4"))).toBe("Hermes 4");
    expect(modelLabel(model("hermes-4"))).toBe("hermes-4");
    expect(modelLabel(model("hermes-4", ""))).toBe("hermes-4");
  });

  it("reports a previously chosen model that disappeared instead of swapping it", () => {
    const state = modelCatalogState(agent(), { agent: "hermes", models: [model("hermes-4")], reported: true });
    expect(selectedStillListed("hermes-4", state)).toBe(true);
    expect(selectedStillListed("hermes-3", state)).toBe(false);
    expect(missingSelectionNotice("hermes-3", state)).toContain("hermes-3");
    expect(missingSelectionNotice("hermes-4", state)).toBeUndefined();
  });

  it("says nothing about a selection while the list is unknown or loading", () => {
    expect(missingSelectionNotice("any", { state: "loading" })).toBeUndefined();
    expect(missingSelectionNotice("any", { state: "unknown", reason: "x" })).toBeUndefined();
  });
});

describe("sign-in modes", () => {
  it("offers exactly the modes the descriptor declares", () => {
    expect(authModesFor(agent())).toEqual(["subscription", "apiKey", "compatibleEndpoint", "local"]);
    expect(authModesFor(agent({ authModes: ["subscription", "apiKey"] }))).toEqual(["subscription", "apiKey"]);
  });

  it("names and explains each mode so subscription and API key never blur together", () => {
    for (const mode of ["subscription", "apiKey", "compatibleEndpoint", "local"] as const) {
      expect(AUTH_MODE_LABELS[mode].length).toBeGreaterThan(0);
      expect(AUTH_MODE_DETAILS[mode].length).toBeGreaterThan(0);
    }
    expect(AUTH_MODE_LABELS.subscription).not.toBe(AUTH_MODE_LABELS.apiKey);
  });

  it("defaults to the subscription when the agent offers one", () => {
    expect(defaultAuthMode(agent())).toBe("subscription");
    expect(defaultAuthMode(agent({ authModes: ["apiKey", "compatibleEndpoint"] }))).toBe("apiKey");
  });

  it("has no default when the agent offers no mode at all", () => {
    expect(defaultAuthMode(agent({ authModes: [] }))).toBeUndefined();
  });
});

describe("capability rows", () => {
  it("describes each steer mode in the words a person chooses with", () => {
    const native = capabilityRows(agent({ capabilities: { ...agent().capabilities, steer: { kind: "native" } } }));
    const boundary = capabilityRows(agent());
    const none = capabilityRows(agent({ capabilities: { ...agent().capabilities, steer: { kind: "none", reason: "no channel" } } }));
    expect(native.find((row) => row.label === "追加指令")?.value).toContain("当前回合");
    expect(boundary.find((row) => row.label === "追加指令")?.value).toContain("工具边界");
    expect(none.find((row) => row.label === "追加指令")?.value).toBe("不支持");
  });

  it("says an agent cannot list models in the model-catalog row", () => {
    const rows = capabilityRows(agent({ capabilities: { ...agent().capabilities, modelCatalog: false } }));
    expect(rows.find((row) => row.label === "模型目录")?.value).toBe(CANNOT_LIST_MODELS);
  });
});
