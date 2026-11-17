import { describe, expect, it } from "vitest";

import { parsePlatformBoard, platformBoardSchema, platformSummarySchema, boardCellSchema, boardCapabilitySchema } from "./boards.ts";

const board = {
  schemaVersion: 1,
  platform: "xianyu",
  generatedAt: "2026-11-14T00:00:00.000Z",
  account: null,
  headline: [{ key: "inbound", label: "Inbound", value: "3" }],
  sections: [],
  actions: [],
  limits: [],
  capability: [],
};

describe("the platform board contract", () => {
  it("accepts a board with no account and no sections", () => {
    const parsed = parsePlatformBoard(board);
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
  });

  it("refuses a board for a platform this host does not know", () => {
    expect(platformBoardSchema.safeParse({ ...board, platform: "myspace" }).success).toBe(false);
  });

  it("refuses a field it does not declare, so a plugin cannot smuggle markup through", () => {
    const smuggled = { ...board, sections: [{ id: "s1", title: "T", kind: "list", items: [], html: "<img onerror=x>" }] };
    expect(platformBoardSchema.safeParse(smuggled).success).toBe(false);
  });

  it("names the failing field when a board does not match, instead of only failing", () => {
    const parsed = parsePlatformBoard({ ...board, generatedAt: "yesterday" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("generatedAt");
  });

  it("requires a reason from every capability that is not production", () => {
    expect(boardCapabilitySchema.safeParse({ id: "ab", label: "A", state: "production" }).success).toBe(true);
    expect(boardCapabilitySchema.safeParse({ id: "ab", label: "A", state: "experimental" }).success).toBe(false);
    expect(boardCapabilitySchema.safeParse({ id: "ab", label: "A", state: "unavailable", reason: "no upstream API" }).success).toBe(true);
  });

  it("carries a cell as text, a number, or a typed value the renderer knows how to draw", () => {
    expect(boardCellSchema.safeParse("plain").success).toBe(true);
    expect(boardCellSchema.safeParse(42).success).toBe(true);
    expect(boardCellSchema.safeParse({ kind: "status", value: "on sale", tone: "accent" }).success).toBe(true);
    expect(boardCellSchema.safeParse({ kind: "sparkline", value: "1,2,3" }).success).toBe(false);
  });

  it("reports a platform with no serving plugin as missing rather than failed", () => {
    const summary = platformSummarySchema.parse({
      platform: "douyin", label: "Douyin", installationId: null, live: false,
      account: null, headline: [], state: "missing", blocked: [], error: "No plugin serves this platform yet.",
    });
    expect(summary.state).toBe("missing");
  });

  it("requires a select field to list its options", () => {
    const withSelect = (field: Record<string, unknown>) => platformBoardSchema.safeParse({
      ...board,
      sections: [{ id: "form", title: "Form", kind: "form", submitLabel: "Save", action: "save", fields: [field] }],
    }).success;
    expect(withSelect({ key: "mode", label: "Mode", type: "select", options: [{ value: "a", label: "A" }] })).toBe(true);
    expect(withSelect({ key: "mode", label: "Mode", type: "select" })).toBe(false);
  });
});
