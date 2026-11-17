import { describe, expect, it } from "vitest";

import { Router, segments } from "./router.ts";

describe("router", () => {
  it("splits a path into non-empty segments", () => {
    expect(segments("/api/v1/missions/")).toEqual(["api", "v1", "missions"]);
    expect(segments("//api//v1")).toEqual(["api", "v1"]);
    expect(segments("/")).toEqual([]);
  });

  it("matches an exact route and captures a parameter", () => {
    const router = new Router().get("/api/v1/missions/:missionId", "readonly", () => ({ status: 200 }));
    const match = router.match("GET", "/api/v1/missions/m1");
    expect(match !== undefined && match !== "method_not_allowed" && match.params.missionId).toBe("m1");
  });

  it("does not treat a parameter as a wildcard across segments", () => {
    const router = new Router().get("/api/v1/missions/:missionId", "readonly", () => ({ status: 200 }));
    expect(router.match("GET", "/api/v1/missions/m1/extra")).toBeUndefined();
    expect(router.match("GET", "/api/v1/missions")).toBeUndefined();
  });

  it("reports a method mismatch on a path that exists", () => {
    const router = new Router().get("/api/v1/missions", "readonly", () => ({ status: 200 }));
    expect(router.match("POST", "/api/v1/missions")).toBe("method_not_allowed");
  });

  it("keeps an upgrade route off the plain request path", () => {
    const router = new Router().upgradeGet("/api/v1/terminals/:id/stream", "device", () => ({ status: 101 }));
    expect(router.match("GET", "/api/v1/terminals/t1/stream")).toBeUndefined();
    expect(router.matchUpgrade("/api/v1/terminals/t1/stream")).toBeDefined();
    expect(router.match("GET", "/api/v1/health")).toBeUndefined();
  });

  it("decodes a percent-encoded parameter", () => {
    const router = new Router().get("/api/v1/missions/:missionId", "readonly", () => ({ status: 200 }));
    const match = router.match("GET", "/api/v1/missions/a%20b");
    expect(match !== undefined && match !== "method_not_allowed" && match.params.missionId).toBe("a b");
  });
});
