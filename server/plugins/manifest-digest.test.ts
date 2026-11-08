import { describe, expect, it } from "vitest";

import { canonicalJson, manifestDigest } from "./manifest-digest.ts";

describe("manifest digest", () => {
  it("does not depend on object key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(manifestDigest({ b: 1, a: 2 })).toBe(manifestDigest({ a: 2, b: 1 }));
  });

  it("changes when a security-relevant value changes", () => {
    expect(manifestDigest({ permission: "read" })).not.toBe(manifestDigest({ permission: "send" }));
  });

  it("omits undefined object fields but preserves array slots", () => {
    expect(canonicalJson({ a: undefined, b: [1, undefined, 3] })).toBe('{"b":[1,null,3]}');
  });
});
