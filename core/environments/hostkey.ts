/**
 * Host-key pinning for a computer the user owns but does not physically
 * control.
 *
 * A key is trusted only when it is in this application's dedicated known-hosts
 * file *and* its fingerprint equals the one stored on the record. A key the
 * computer presents that differs is a hard stop: the pin is never rewritten
 * from a live connection, because a rewritten pin is exactly what a
 * machine-in-the-middle wants.
 */

import { createHash, createHmac } from "node:crypto";

import {
  FingerprintMismatchError,
  HostKeyChangedError,
  HostKeyMissingError,
  InvalidEnvironmentError,
} from "./errors.ts";
import type { HostKeyInput } from "./types.ts";

const KNOWN_HOSTS_TOKEN = /^[^\s]+$/;

export interface KnownHostEntry {
  /** The patterns as written, before splitting. */
  readonly hosts: readonly string[];
  readonly keyType: string;
  readonly keyBlob: string;
}

/** A `SHA256:` fingerprint is the base64 of the key blob's sha256, padding removed. */
export function fingerprintOf(key: HostKeyInput): string {
  const blob = Buffer.from(key.keyBlob, "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** The MD5 form ssh also prints: colon-separated lowercase hex pairs. */
export function md5FingerprintOf(key: HostKeyInput): string {
  const blob = Buffer.from(key.keyBlob, "base64");
  const hex = createHash("md5").update(blob).digest("hex");
  return `MD5:${hex.match(/.{2}/g)!.join(":")}`;
}

export function isFingerprint(value: string): boolean {
  return /^SHA256:[A-Za-z0-9+/]{43}$/.test(value) || /^MD5:(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/i.test(value);
}

/** Validates a pin and returns it in its own algorithm, so comparisons never
 * mix a SHA256 pin with an MD5 reading. */
export function normalizeFingerprint(value: string): string {
  const trimmed = value.trim();
  if (!isFingerprint(trimmed)) throw new InvalidEnvironmentError(`bad host key fingerprint ${JSON.stringify(trimmed)}`);
  return trimmed.startsWith("MD5:") ? `MD5:${trimmed.slice("MD5:".length).toLowerCase()}` : trimmed;
}

/** The pin recomputed in the same algorithm as `expected`, for one comparison. */
function fingerprintIn(key: HostKeyInput, expected: string): string {
  return expected.startsWith("MD5:") ? md5FingerprintOf(key) : fingerprintOf(key);
}

/**
 * Reads a known-hosts file. Comment lines, blank lines and a trailing comment
 * after the key are ignored; a line this parser cannot place is reported by
 * line number rather than silently skipped, since a skipped line is a key the
 * caller believes is pinned but is not.
 */
export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let at = 0; at < lines.length; at += 1) {
    const raw = lines[at]!.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    const fields = raw.split(/\s+/);
    if (fields.length < 3) {
      throw new InvalidEnvironmentError(`known-hosts line ${at + 1} has ${fields.length} fields, expected at least 3`);
    }
    const [hostField, keyType, keyBlob] = fields as [string, string, string];
    if (!KNOWN_HOSTS_TOKEN.test(keyBlob) || !/^[A-Za-z0-9+/]+={0,2}$/.test(keyBlob)) {
      throw new InvalidEnvironmentError(`known-hosts line ${at + 1} has a key that is not base64`);
    }
    entries.push({ hosts: hostField.split(","), keyType, keyBlob });
  }
  return entries;
}

/** The entries that apply to one host, honouring `*`, `?` and `!` patterns. */
export function entriesForHost(entries: readonly KnownHostEntry[], host: string): KnownHostEntry[] {
  const matched: KnownHostEntry[] = [];
  for (const entry of entries) {
    if (hostMatches(entry.hosts, host)) matched.push(entry);
  }
  return matched;
}

function hostMatches(patterns: readonly string[], host: string): boolean {
  let positive = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    const hit = matchPattern(body, host) || hashedMatch(body, host);
    if (!hit) continue;
    if (negated) return false;
    positive = true;
  }
  return positive;
}

function matchPattern(pattern: string, host: string): boolean {
  if (!/[*?]/.test(pattern)) return pattern.toLowerCase() === host.toLowerCase();
  const source = pattern
    .split("")
    .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`, "i").test(host);
}

/** `|1|salt|hash`, as `ssh-keygen -H` writes it: HMAC-SHA1 over the host name. */
function hashedMatch(pattern: string, host: string): boolean {
  if (!pattern.startsWith("|1|")) return false;
  const parts = pattern.split("|");
  if (parts.length !== 4) return false;
  const salt = Buffer.from(parts[2]!, "base64");
  const digest = createHmac("sha1", salt).update(host).digest("base64");
  return digest === parts[3];
}

export interface VerifyOptions {
  readonly host: string;
  readonly knownHostsText: string;
  /** The pin from the record. */
  readonly expectedFingerprint: string;
  /** What the computer presented this time, when it could be read. */
  readonly presented: HostKeyInput | null;
}

/**
 * The one gate before a connection is used. Throws `HostKeyMissingError` when
 * the file has no key for this host, `FingerprintMismatchError` when the file
 * and the pin disagree, and `HostKeyChangedError` when the computer presents a
 * key that is not the pinned one.
 */
export function verifyHostKey(options: VerifyOptions): HostKeyInput {
  const expected = normalizeFingerprint(options.expectedFingerprint);
  const entries = entriesForHost(parseKnownHosts(options.knownHostsText), options.host);
  if (entries.length === 0) throw new HostKeyMissingError(options.host);

  const pinned = entries.find((entry) => fingerprintIn(entry, expected) === expected);
  if (!pinned) {
    throw new FingerprintMismatchError(expected, fingerprintIn(entries[0]!, expected));
  }
  if (options.presented === null) return { keyType: pinned.keyType, keyBlob: pinned.keyBlob };

  if (fingerprintIn(options.presented, expected) !== expected) {
    throw new HostKeyChangedError(options.host, expected, fingerprintIn(options.presented, expected));
  }
  return options.presented;
}

/** The line to append when a person confirms a new key. Never called from a
 * failed verification: only from an explicit confirmation path. */
export function knownHostsLine(host: string, key: HostKeyInput): string {
  return `${host} ${key.keyType} ${key.keyBlob}`;
}
