import { describe, expect, it } from "vitest";

import { compareSemVer, parseSemVer, satisfiesSemVer, validSemVerRange } from "./semver.ts";

describe("plugin SemVer subset", () => {
  it("parses exact versions and rejects ranges", () => {
    expect(parseSemVer("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemVer("01.2.3")).toBeNull();
    expect(parseSemVer("^1.2.3")).toBeNull();
  });

  it("orders release and prerelease versions", () => {
    expect(compareSemVer(parseSemVer("1.2.3")!, parseSemVer("1.2.4")!)).toBe(-1);
    expect(compareSemVer(parseSemVer("1.2.3")!, parseSemVer("1.2.3")!)).toBe(0);
    expect(compareSemVer(parseSemVer("1.2.3-rc.1")!, parseSemVer("1.2.3")!)).toBe(-1);
    expect(compareSemVer(parseSemVer("1.2.3-rc.2")!, parseSemVer("1.2.3-rc.10")!)).toBe(-1);
  });

  it("accepts the ranges manifests use", () => {
    for (const range of ["*", "^1.0.0", "~1.2.3", ">=1.0.0 <2.0.0", "1.2.3", "^0.1.0 || ^1.0.0"]) {
      expect(validSemVerRange(range), range).toBe(true);
    }
    expect(validSemVerRange("latest")).toBe(false);
    expect(validSemVerRange(">=1.0.0 banana")).toBe(false);
  });

  it("matches caret, tilde and comparator ranges", () => {
    expect(satisfiesSemVer("1.4.0", "^1.0.0")).toBe(true);
    expect(satisfiesSemVer("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesSemVer("0.2.9", "^0.2.0")).toBe(true);
    expect(satisfiesSemVer("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfiesSemVer("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfiesSemVer("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfiesSemVer("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesSemVer("1.0.0-rc.1", "^1.0.0")).toBe(false);
    expect(satisfiesSemVer("1.0.0-rc.2", ">=1.0.0-rc.1 <1.0.0")).toBe(true);
    expect(satisfiesSemVer("1.0.0", "0.9.0 || 1.0.0")).toBe(true);
  });
});
