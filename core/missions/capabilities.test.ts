import { describe, expect, it } from "vitest";

import { AGENT_REGISTRY } from "../agents/registry.ts";
import { capabilitiesFor } from "./capabilities.ts";

const KINDS = ["hermes", "claudeCode", "codex", "openCode", "pi", "ohMyPi", "custom"] as const;

describe("the protocol's capability table", () => {
  it.each(KINDS)("projects %s from the one agent registry", (kind) => {
    const source = AGENT_REGISTRY[kind].capabilities;
    const projected = capabilitiesFor(kind);
    expect(projected.steer).toEqual(source.steer);
    expect(projected.interrupt).toBe(source.interrupt);
    expect(projected.resume).toBe(source.resume);
    expect(projected.cancel).toBe(source.cancel);
    expect(projected.approval).toBe(source.approvals);
    expect(projected.questions).toBe(source.questions);
    expect(projected.nativeTui).toBe(source.nativeTui);
    expect(projected.images).toBe(source.images);
    expect(projected.usage).toBe(source.usage);
    expect(projected.modelCatalog).toBe(source.modelCatalog === "native");
  });

  it("claims no event stream it cannot deliver", () => {
    for (const kind of KINDS) {
      expect(capabilitiesFor(kind).subagents).toBe(false);
      expect(capabilitiesFor(kind).fileChanges).toBe(false);
    }
  });
});
