import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { catalogRevocation, catalogArtifact, verifyCatalog, type CatalogKey } from "./catalog.ts";
import { canonicalJson } from "./manifest-digest.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const keys: Record<string, CatalogKey> = { "eac-community": { publicKey: pem, trust: "community" } };
const now = new Date("2026-11-08T00:00:00.000Z");

function payload(patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sourceId: "eac-community",
    sequence: 3,
    issuedAt: "2026-11-07T23:00:00.000Z",
    expiresAt: "2026-11-09T00:00:00.000Z",
    entries: [{
      pluginId: "eac.test",
      version: "1.0.0",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      sourceRevision: "b".repeat(40),
      title: "Test plugin",
      artifacts: [{ platform: "win32-x64", url: "https://example.com/eac-test.zip", sha256: "c".repeat(64), size: 100 }],
      review: { tier: "community", checkedAt: "2026-11-07T23:00:00.000Z" },
    }],
    revoked: [],
    ...patch,
  };
}

function envelope(body: unknown = payload(), keyId = "eac-community") {
  const signature = sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url");
  return { schemaVersion: 1, keyId, algorithm: "ed25519", payload: body, signature };
}

describe("signed plugin catalog", () => {
  it("accepts a valid catalog and reports the key's trust", () => {
    expect(verifyCatalog(envelope(), { keys, now })).toMatchObject({ ok: true, keyId: "eac-community", trust: "community" });
  });

  it("rejects a tampered payload, an unknown key and a malformed envelope", () => {
    const tampered = envelope();
    (tampered.payload as ReturnType<typeof payload>).entries[0]!.title = "Tampered";
    expect(verifyCatalog(tampered, { keys, now })).toMatchObject({ ok: false, code: "bad-signature" });
    expect(verifyCatalog(envelope(), { keys: {}, now })).toMatchObject({ ok: false, code: "unknown-key" });
    expect(verifyCatalog({ ...envelope(), signature: "!" }, { keys, now })).toMatchObject({ ok: false, code: "invalid-envelope" });
  });

  it("rejects a key publishing above its trust tier", () => {
    const body = payload();
    body.entries[0]!.review.tier = "official";
    expect(verifyCatalog(envelope(body), { keys, now })).toMatchObject({ ok: false, code: "trust-escalation" });
  });

  it("rejects an expired, future or too-long catalog", () => {
    expect(verifyCatalog(envelope(), { keys, now: new Date("2026-11-10T00:00:00.000Z") })).toMatchObject({ ok: false, code: "expired" });
    expect(verifyCatalog(envelope(payload({ issuedAt: "2026-11-08T00:10:00.000Z" })), { keys, now })).toMatchObject({ ok: false, code: "not-yet-valid" });
    expect(verifyCatalog(envelope(payload({ expiresAt: "2027-03-01T00:00:00.000Z" })), { keys, now })).toMatchObject({ ok: false, code: "range-too-long" });
  });

  it("rejects a sequence older than the accepted one", () => {
    expect(verifyCatalog(envelope(), { keys, now, minimumSequence: 4 })).toMatchObject({ ok: false, code: "stale-sequence" });
  });

  it("rejects invalid payloads only after verifying their signature", () => {
    const bad = payload();
    bad.entries[0]!.manifestDigest = "sha256:not-a-digest";
    expect(verifyCatalog(envelope(bad), { keys, now })).toMatchObject({ ok: false, code: "invalid-payload" });
    const duplicate = payload();
    duplicate.entries.push({ ...duplicate.entries[0]! });
    expect(verifyCatalog(envelope(duplicate), { keys, now })).toMatchObject({ ok: false, code: "invalid-payload" });
  });

  it("finds a matching revocation and artifact", () => {
    const body = payload({ revoked: [{ pluginId: "eac.test", version: "1.0.0", reason: "withdrawn", revokedAt: "2026-11-07T23:30:00.000Z" }] });
    const verified = verifyCatalog(envelope(body), { keys, now });
    if (!verified.ok) throw new Error(verified.error);
    expect(catalogRevocation(verified.payload, { pluginId: "eac.test", version: "1.0.0" })?.reason).toBe("withdrawn");
    expect(catalogRevocation(verified.payload, { pluginId: "eac.test", version: "2.0.0" })).toBeNull();
    expect(catalogArtifact(verified.payload, "eac.test", "1.0.0", "win32-x64")).toMatchObject({ sha256: "c".repeat(64) });
    expect(catalogArtifact(verified.payload, "eac.test", "1.0.0", "linux-x64")).toBeNull();
  });
});
