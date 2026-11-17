import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  FingerprintMismatchError,
  HostKeyChangedError,
  HostKeyMissingError,
  InvalidEnvironmentError,
  entriesForHost,
  fingerprintOf,
  isFingerprint,
  knownHostsLine,
  md5FingerprintOf,
  normalizeFingerprint,
  parseKnownHosts,
  verifyHostKey,
  type HostKeyInput,
} from "./index.ts";

/** A real ed25519 key pair's public half, in the shape a known-hosts line has. */
function key(): HostKeyInput {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = Buffer.from(der).subarray(der.length - 32);
  const type = Buffer.from("ssh-ed25519");
  const blob = Buffer.concat([len(type.length), type, len(raw.length), raw]);
  return { keyType: "ssh-ed25519", keyBlob: blob.toString("base64") };
}

function len(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

describe("host key fingerprints", () => {
  it("computes the SHA256 form ssh prints, without base64 padding", () => {
    const value = key();
    const fingerprint = fingerprintOf(value);
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fingerprint.endsWith("=")).toBe(false);
    expect(isFingerprint(fingerprint)).toBe(true);
  });

  it("computes the MD5 form with lowercase colon-separated pairs", () => {
    const fingerprint = md5FingerprintOf(key());
    expect(fingerprint).toMatch(/^MD5:(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/);
  });

  it("rejects a pin that is not a fingerprint", () => {
    expect(() => normalizeFingerprint("not-a-fingerprint")).toThrow(InvalidEnvironmentError);
  });
});

describe("the dedicated known-hosts file", () => {
  it("parses comments, blanks and a trailing comment", () => {
    const value = key();
    const text = ["# a comment", "", `laptop.example ${value.keyType} ${value.keyBlob} a comment`].join("\n");
    const entries = parseKnownHosts(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hosts).toEqual(["laptop.example"]);
  });

  it("reports a malformed line by number rather than skipping it", () => {
    expect(() => parseKnownHosts("laptop.example ssh-ed25519")).toThrow(/line 1 has 2 fields/);
    expect(() => parseKnownHosts("laptop.example ssh-ed25519 not-base64!")).toThrow(/line 1 has a key that is not base64/);
  });

  it("matches a comma list, a wildcard and a negation", () => {
    const value = key();
    const entries = parseKnownHosts([`a.example,b.example ${value.keyType} ${value.keyBlob}`, `*.internal ${value.keyType} ${value.keyBlob}`, `!bad.example ${value.keyType} ${value.keyBlob}`].join("\n"));
    expect(entriesForHost(entries, "b.example")).toHaveLength(1);
    expect(entriesForHost(entries, "host.internal")).toHaveLength(1);
    expect(entriesForHost(entries, "bad.example")).toHaveLength(0);
    expect(entriesForHost(entries, "other.example")).toHaveLength(0);
  });

  it("matches a hashed host entry", () => {
    const value = key();
    const salt = Buffer.from("0123456789abcdef");
    const hashed = createHmac("sha1", salt).update("laptop.example").digest("base64");
    const entries = parseKnownHosts(`|1|${salt.toString("base64")}|${hashed} ${value.keyType} ${value.keyBlob}`);
    expect(entriesForHost(entries, "laptop.example")).toHaveLength(1);
  });
});

describe("verifying a presented host key", () => {
  const value = key();
  const pinned = fingerprintOf(value);
  const knownHostsText = knownHostsLine("laptop.example", value);

  it("accepts the key the record pinned", () => {
    expect(
      verifyHostKey({ host: "laptop.example", knownHostsText, expectedFingerprint: pinned, presented: value }),
    ).toEqual(value);
  });

  it("accepts a connection that presents nothing, trusting only the file", () => {
    expect(verifyHostKey({ host: "laptop.example", knownHostsText, expectedFingerprint: pinned, presented: null }).keyType).toBe("ssh-ed25519");
  });

  it("refuses a host with no entry", () => {
    expect(() =>
      verifyHostKey({ host: "other.example", knownHostsText, expectedFingerprint: pinned, presented: null }),
    ).toThrow(HostKeyMissingError);
  });

  it("refuses a file whose key is not the pinned one", () => {
    expect(() =>
      verifyHostKey({ host: "laptop.example", knownHostsText, expectedFingerprint: fingerprintOf(key()), presented: null }),
    ).toThrow(FingerprintMismatchError);
  });

  it("refuses a computer that presents a different key, and names both", () => {
    const other = key();
    const error = (() => {
      try {
        verifyHostKey({ host: "laptop.example", knownHostsText, expectedFingerprint: pinned, presented: other });
        return null;
      } catch (caught) {
        return caught as HostKeyChangedError;
      }
    })();
    expect(error).toBeInstanceOf(HostKeyChangedError);
    expect(error!.expected).toBe(pinned);
    expect(error!.presented).toBe(fingerprintOf(other));
  });

  it("compares an MD5 pin against the MD5 form of the presented key", () => {
    const md5 = md5FingerprintOf(value);
    expect(verifyHostKey({ host: "laptop.example", knownHostsText, expectedFingerprint: md5, presented: value })).toEqual(value);
    expect(() =>
      verifyHostKey({ host: "laptop.example", knownHostsText, expectedFingerprint: md5, presented: key() }),
    ).toThrow(HostKeyChangedError);
  });
});
