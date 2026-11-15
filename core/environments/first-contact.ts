/**
 * The first connection to a computer, before anything is trusted.
 *
 * The order is deliberate and has no shortcut:
 * 1. A fingerprint the person supplied is the only thing that can pin a key.
 * 2. A scan (`ssh-keyscan`) may *discover* keys, but a scanned key is not
 *    trusted: it is shown to the person, and their confirmation is what pins it.
 * 3. With neither, the call refuses with `hostKeyConfirmationRequired` and
 *    carries what the scan saw, so a screen can ask.
 *
 * A known-hosts file is written only from a key whose fingerprint a person
 * supplied or confirmed. Nothing here ever pins a key because a host offered it.
 */

import {
  ConfirmationRequiredError,
  FingerprintMismatchError,
  HostKeyConfirmationRequiredError,
  InvalidEnvironmentError,
  SshDisconnectedError,
} from "./errors.ts";
import { fingerprintOf, knownHostsLine, normalizeFingerprint } from "./hostkey.ts";
import { discoverHostKeys, type DiscoveredHostKeys, type SshRunner } from "./ssh.ts";
import type { HostKeyInput } from "./types.ts";

export interface HostIdentity {
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

export interface FirstContactOptions {
  readonly runner: SshRunner;
  /** The fingerprint the person read off their own computer. */
  readonly fingerprint?: string | null;
  /** The keys the person confirmed after seeing a scan's output. */
  readonly confirmedKeys?: readonly HostKeyInput[];
  /** Reads the dedicated known-hosts file, if one already exists. */
  readonly readKnownHosts?: (path: string) => string | null;
  /** Replaces the dedicated known-hosts file. Injected, so a test never writes
   * the real one. */
  readonly writeKnownHosts?: (path: string, text: string) => void;
  readonly knownHostsFile: string;
}

export interface FirstContactResult {
  /** The key now pinned in this application's known-hosts file. */
  readonly key: HostKeyInput;
  readonly fingerprint: string;
  /** What the scan offered, whether or not it was trusted. */
  readonly discovered: DiscoveredHostKeys;
}

/**
 * Resolves the one key this application will pin.
 *
 * - A supplied fingerprint is checked against the scan and pinned on a match.
 * - Confirmed keys are pinned only when the scan also saw them.
 * - Neither means `HostKeyConfirmationRequiredError`, carrying what was seen.
 */
export async function firstContact(identity: HostIdentity, options: FirstContactOptions): Promise<FirstContactResult> {
  assertHostIdentity(identity);
  const supplied = options.fingerprint ?? null;
  const confirmed = options.confirmedKeys ?? [];

  if (supplied !== null) {
    const wanted = normalizeFingerprint(supplied);
    if (confirmed.length > 0) {
      const match = confirmed.find((key) => fingerprintOf(key) === wanted);
      if (!match) throw new FingerprintMismatchError(wanted, confirmed.map(fingerprintOf).join(", "));
      pin(identity, match, options);
      return { key: match, fingerprint: wanted, discovered: { keys: confirmed, fingerprints: confirmed.map(fingerprintOf) } };
    }

    const discovered = await scanOrFail(identity, options.runner);
    const match = discovered.keys.find((key) => fingerprintOf(key) === wanted);
    if (!match) throw new FingerprintMismatchError(wanted, discovered.fingerprints.join(", "));
    pin(identity, match, options);
    return { key: match, fingerprint: wanted, discovered };
  }

  if (confirmed.length === 0) {
    const discovered = await discoverHostKeys(options.runner, identity);
    throw new HostKeyConfirmationRequiredError(identity.host, discovered.fingerprints);
  }

  const discovered = await scanOrFail(identity, options.runner);
  for (const key of confirmed) {
    if (!discovered.keys.some((seen) => fingerprintOf(seen) === fingerprintOf(key))) {
      throw new FingerprintMismatchError(fingerprintOf(key), discovered.fingerprints.join(", "));
    }
  }
  const key = confirmed[0]!;
  pin(identity, key, options);
  return { key, fingerprint: fingerprintOf(key), discovered };
}

/** The line a known-hosts file gets, which is the only thing a pin writes. */
export function knownHostsFor(identity: HostIdentity, key: HostKeyInput): string {
  return `${knownHostsLine(identity.host, key)}\n`;
}

async function scanOrFail(identity: HostIdentity, runner: SshRunner): Promise<DiscoveredHostKeys> {
  const discovered = await discoverHostKeys(runner, identity);
  if (discovered.keys.length === 0) {
    throw new SshDisconnectedError(`the scan of ${identity.host} found no host key`);
  }
  return discovered;
}

function pin(identity: HostIdentity, key: HostKeyInput, options: FirstContactOptions): void {
  if (!options.writeKnownHosts) {
    throw new ConfirmationRequiredError("pinning a host key needs a place to write it");
  }
  const existing = options.readKnownHosts?.(options.knownHostsFile) ?? "";
  const line = knownHostsFor(identity, key).trim();
  if (existing.split(/\r?\n/).some((candidate) => candidate.trim() === line)) return;
  const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  options.writeKnownHosts(options.knownHostsFile, `${prefix}${line}\n`);
}

/** Guards the identity a first contact is made against. */
export function assertHostIdentity(identity: HostIdentity): void {
  if (identity.host === "") throw new InvalidEnvironmentError("a first contact needs a host");
  if (!Number.isInteger(identity.port) || identity.port < 1 || identity.port > 65_535) {
    throw new InvalidEnvironmentError(`bad port ${identity.port}`);
  }
  if (identity.user === "") throw new InvalidEnvironmentError("a first contact needs a user");
}
