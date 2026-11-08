import { describe, expect, it } from "vitest";

import { OfmConfigError, modelsFromOfmListing, ofmChatBody, parseOfmEndpoint } from "./ofm.ts";
import { requireModality } from "../../shared/plugins/models.ts";

const endpoint = (overrides: Record<string, unknown> = {}) => parseOfmEndpoint({
  endpointId: "ofm",
  baseUrl: "https://ofm.example.com/v1",
  api: "openai-compatible",
  ...overrides,
});

describe("OFM endpoints", () => {
  it("accepts a plain https base URL and a loopback development server", () => {
    expect(endpoint().baseUrl).toBe("https://ofm.example.com/v1");
    expect(endpoint({ baseUrl: "http://127.0.0.1:8000/v1" }).baseUrl).toBe("http://127.0.0.1:8000/v1");
  });

  it("refuses credentials in the URL and plain http off loopback", () => {
    expect(() => endpoint({ baseUrl: "https://user:secret@ofm.example.com/v1" })).toThrow(OfmConfigError);
    expect(() => endpoint({ baseUrl: "http://ofm.example.com/v1" })).toThrow(/https/);
  });

  it("keeps every listed modality unverified until a real request proves it", () => {
    const models = modelsFromOfmListing(endpoint({ declares: { "chat-1": { vision: true, tools: true } }, free: true }), {
      data: [{ id: "chat-1" }, { id: "" }, { id: 42 }],
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ key: "ofm/chat-1", free: true, pricing: { state: "free" } });
    expect(models[0]!.modalities).toMatchObject({ text: "unverified", vision: "unverified", tools: "unverified" });
    expect(requireModality(models[0]!, "vision")).toMatchObject({ ok: false, code: "MODALITY_UNVERIFIED" });
  });

  it("marks an unpriced endpoint as unknown cost, not free", () => {
    const [model] = modelsFromOfmListing(endpoint(), { data: [{ id: "chat-1" }] });
    expect(model?.pricing).toMatchObject({ state: "unknown" });
  });

  it("builds an OpenAI-compatible body and refuses an unavailable streaming mode", () => {
    const [model] = modelsFromOfmListing(endpoint({ declares: { "chat-1": { streaming: false } } }), { data: [{ id: "chat-1" }] });
    expect(ofmChatBody(model!, { model: "chat-1", messages: [{ role: "user", content: "hi" }], stream: false }))
      .toMatchObject({ model: "chat-1", stream: false });
    expect(() => ofmChatBody(model!, { model: "chat-1", messages: [], stream: true }))
      .toThrow(/streaming/);
  });
});
