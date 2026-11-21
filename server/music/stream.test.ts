import { describe, expect, it } from "vitest";

import { parseByteRange } from "./stream.ts";

describe("parseByteRange", () => {
  it("returns null when there is no range header", () => {
    expect(parseByteRange(undefined, 1_000)).toBeNull();
  });

  it("reads a closed range", () => {
    expect(parseByteRange("bytes=0-99", 1_000)).toEqual({ start: 0, end: 99 });
  });

  it("reads an open-ended range to the last byte", () => {
    expect(parseByteRange("bytes=500-", 1_000)).toEqual({ start: 500, end: 999 });
  });

  it("reads a suffix range as the last N bytes", () => {
    expect(parseByteRange("bytes=-100", 1_000)).toEqual({ start: 900, end: 999 });
  });

  it("clamps an end past the file to the last byte", () => {
    expect(parseByteRange("bytes=900-5000", 1_000)).toEqual({ start: 900, end: 999 });
  });

  it("refuses a start past the file", () => {
    expect(parseByteRange("bytes=1000-", 1_000)).toBe("unsatisfiable");
  });

  it("refuses an end before the start", () => {
    expect(parseByteRange("bytes=500-100", 1_000)).toBe("unsatisfiable");
  });

  it("refuses a zero-length suffix", () => {
    expect(parseByteRange("bytes=-0", 1_000)).toBe("unsatisfiable");
  });

  it("ignores a multi-range request, which this proxy does not serve", () => {
    expect(parseByteRange("bytes=0-99,200-299", 1_000)).toBeNull();
  });

  it("ignores a malformed header", () => {
    expect(parseByteRange("items=0-99", 1_000)).toBeNull();
  });
});
