import { describe, expect, it } from "vitest";

import { mergeModels, modelDescriptorSchema, requireModality } from "./models.ts";

const model = (overrides: Record<string, unknown> = {}) => modelDescriptorSchema.parse({
  key: "ofm/chat-1",
  provider: "ofm",
  model: "chat-1",
  title: "OFM Chat 1",
  modalities: { text: "verified", tools: "unverified" },
  ...overrides,
});

describe("model descriptors", () => {
  it("refuses an unverified modality unless the caller explicitly allows it", () => {
    expect(requireModality(model(), "tools")).toMatchObject({ ok: false, code: "MODALITY_UNVERIFIED" });
    expect(requireModality(model(), "tools", { allowUnverified: true })).toMatchObject({ ok: true, state: "unverified" });
    expect(requireModality(model(), "vision")).toMatchObject({ ok: false, code: "MODALITY_UNAVAILABLE" });
  });

  it("never upgrades an unavailable modality during a catalog refresh", () => {
    const old = model({ modalities: { text: "verified", vision: "unavailable" } });
    const refreshed = mergeModels([old], [model({ modalities: { text: "verified", vision: "unverified" } })]);
    expect(refreshed[0]?.modalities.vision).toBe("unavailable");
    expect(refreshed[0]?.modalities.text).toBe("verified");
  });

  it("keeps the incoming catalog's key order and drops a model the provider no longer lists", () => {
    const merged = mergeModels([model({ key: "ofm/z", model: "z" })], [model({ key: "ofm/a", model: "a" })]);
    expect(merged.map((entry) => entry.key)).toEqual(["ofm/a"]);
  });

  it("requires a provider and model in the key", () => {
    expect(() => modelDescriptorSchema.parse({
      key: "no-slash", provider: "ofm", model: "x", title: "X", modalities: { text: "verified" },
    })).toThrow();
  });
});
