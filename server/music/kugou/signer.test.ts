import { describe, expect, it } from "vitest";

import {
  liteSignature,
  loginKey,
  md5,
  midFromDfid,
  officialSignature,
  randomDfid,
  uuidFromDfid,
  v5Signature,
  webSignature,
  LITE_APP_ID,
  LITE_CLIENT_VER,
  LITE_SALT,
  OFFICIAL_SALT,
  V5_KEY_SALT,
  WEB_SIGNATURE_SALT,
} from "./signer.ts";

/**
 * These vectors are computed from the salts and the documented construction, not
 * copied from a live request: they pin the shape (which string is hashed, in what
 * order) so a refactor that reorders the pairs fails here instead of at Kugou.
 */
describe("liteSignature", () => {
  it("hashes salt + ordinal-sorted pairs + body + salt", () => {
    const params = { b: "2", a: "1" };
    const expected = md5(`${LITE_SALT}a=1b=2${LITE_SALT}`);
    expect(liteSignature(params)).toBe(expected);
  });

  it("includes the raw body between the pairs and the closing salt", () => {
    const expected = md5(`${LITE_SALT}a=1b=2{"x":1}${LITE_SALT}`);
    expect(liteSignature({ b: "2", a: "1" }, '{"x":1}')).toBe(expected);
  });

  it("sorts ordinally, not by locale: an uppercase key comes before a lowercase one", () => {
    // Ordinal order puts "Z" (0x5a) before "a" (0x61); a locale sort would not.
    const expected = md5(`${LITE_SALT}Z=1a=2${LITE_SALT}`);
    expect(liteSignature({ a: "2", Z: "1" })).toBe(expected);
  });

  it("is stable for an empty request", () => {
    expect(liteSignature({})).toBe(md5(`${LITE_SALT}${LITE_SALT}`));
  });
});

describe("webSignature", () => {
  it("wraps the sorted pairs in the web salt", () => {
    const expected = md5(`${WEB_SIGNATURE_SALT}a=1b=2${WEB_SIGNATURE_SALT}`);
    expect(webSignature({ b: "2", a: "1" })).toBe(expected);
  });
});

describe("v5Signature", () => {
  it("hashes hash + key salt + appid + mid + userid", () => {
    const expected = md5(`abc123${V5_KEY_SALT}${LITE_APP_ID}MID42`);
    expect(v5Signature("ABC123", "MID", "42")).toBe(expected);
  });

  it("lowercases the hash before hashing", () => {
    expect(v5Signature("ABC123", "MID", "42")).toBe(v5Signature("abc123", "MID", "42"));
  });

  it("uses 0 for a signed-out account", () => {
    expect(v5Signature("abc", "MID", "0")).toBe(md5(`abc${V5_KEY_SALT}${LITE_APP_ID}MID0`));
  });
});

describe("officialSignature", () => {
  it("wraps the sorted pairs in the official salt", () => {
    expect(officialSignature({ b: "2", a: "1" })).toBe(md5(`${OFFICIAL_SALT}a=1b=2${OFFICIAL_SALT}`));
  });
});

describe("loginKey", () => {
  it("hashes appid + salt + client version + the client time", () => {
    expect(loginKey(1_700_000_000_000)).toBe(md5(`${LITE_APP_ID}${LITE_SALT}${LITE_CLIENT_VER}1700000000000`));
  });
});

describe("device ids", () => {
  it("derives a stable mid and uuid from a dfid", () => {
    const mid = midFromDfid("0123456789abcdef01234567");
    expect(mid).toBe(md5("0123456789abcdef01234567").toUpperCase());
    expect(uuidFromDfid("0123456789abcdef01234567", mid)).toBe(md5(`0123456789abcdef01234567${mid}`).toUpperCase());
  });

  it("generates a 24-character hex dfid", () => {
    const dfid = randomDfid();
    expect(dfid).toMatch(/^[0-9a-f]{24}$/);
    expect(randomDfid(() => 0)).toBe("000000000000000000000000");
    expect(randomDfid(() => 0.999_999)).toBe("ffffffffffffffffffffffff");
  });
});
