/**
 * Adding a computer, and checking one that is already recorded.
 *
 * The order is fixed and observable: the pin is checked against the dedicated
 * known-hosts file first, then the machine's own facts are read, then the agent
 * CLIs are probed. A failure at any step is one typed error, and the record's
 * status says which kind of problem it is.
 */

import { readFileSync } from "node:fs";

import {
  ConfirmationRequiredError,
  EnvironmentError,
  FingerprintMismatchError,
  HostKeyChangedError,
  HostKeyConfirmationRequiredError,
  HostKeyMissingError,
  SshDisconnectedError,
  SshFailureError,
} from "./errors.ts";
import { fingerprintOf, knownHostsLine } from "./hostkey.ts";
import { firstContact } from "./first-contact.ts";
import { probeMachine, probeTools } from "./probe.ts";
import { preflightHostKey, runRemote, type RemoteTarget, type SshRunner } from "./ssh.ts";
import type { EnvironmentStore } from "./store.ts";
import {
  type EnvironmentCapabilities,
  type EnvironmentDraft,
  type EnvironmentRecord,
  type EnvironmentStatus,
  type HostKeyInput,
  type InstalledTool,
} from "./types.ts";

/** Resolves a record's credential reference into a key path for this call only. */
export type IdentityResolver = (ref: string) => string | null;

export interface ConnectOptions {
  readonly runner: SshRunner;
  /** Reads the dedicated known-hosts file, or null when it does not exist yet. */
  readonly readKnownHosts?: (path: string) => string | null;
  /** Reads the key the computer presents, when a caller can. */
  readonly presentedKey?: () => Promise<HostKeyInput | null>;
  readonly identity?: IdentityResolver;
  readonly now?: () => string;
}

export interface AddResult {
  readonly record: EnvironmentRecord;
  readonly capabilities: EnvironmentCapabilities;
  readonly tools: readonly InstalledTool[];
  readonly status: EnvironmentStatus;
}

/**
 * Adds a computer the person has not connected to before.
 *
 * The host key is resolved by `firstContact` first: a fingerprint the person
 * supplied is checked against a scan and pinned on a match, and with no
 * fingerprint this throws `HostKeyConfirmationRequiredError` carrying what the
 * scan saw. A scanned key is never pinned on the host's word alone.
 */
export async function addFirstEnvironment(
  store: EnvironmentStore,
  input: NewEnvironmentInput,
  options: FirstContactAddOptions,
): Promise<AddResult> {
  const contact = await firstContact(
    { host: input.host, port: input.port ?? 22, user: input.user },
    {
      runner: options.runner,
      fingerprint: input.hostKeyFingerprint ?? null,
      ...(options.confirmedKeys === undefined ? {} : { confirmedKeys: options.confirmedKeys }),
      knownHostsFile: input.knownHostsFile,
      ...(options.readKnownHosts === undefined ? {} : { readKnownHosts: options.readKnownHosts }),
      writeKnownHosts: options.writeKnownHosts,
    },
  );
  const draft: EnvironmentDraft = {
    label: input.label,
    host: input.host,
    port: input.port ?? 22,
    user: input.user,
    knownHostsFile: input.knownHostsFile,
    hostKeyFingerprint: contact.fingerprint,
    identityFileRef: input.identityFileRef ?? null,
  };
  const record = await store.add(draft, { now: options.now?.() });
  return verifyEnvironment(store, record, options);
}

export interface NewEnvironmentInput {
  readonly label: string;
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  readonly knownHostsFile: string;
  /** The fingerprint a person read off their own computer. Without one the add
   * stops at `HostKeyConfirmationRequiredError`. */
  readonly hostKeyFingerprint?: string | null;
  readonly identityFileRef?: string | null;
}

export interface FirstContactAddOptions extends ConnectOptions {
  /** Keys a person confirmed after seeing a scan. Pinned only when the scan also
   * saw them. */
  readonly confirmedKeys?: readonly HostKeyInput[];
  readonly writeKnownHosts: (path: string, text: string) => void;
}

/**
 * Adds a computer and verifies it in the same call. A verification that fails
 * still leaves the record, with the status that failure earned: the person
 * typed the details, and re-typing them to see the error again helps nobody.
 * The error is thrown as well, so a caller that must stop can.
 */
export async function addEnvironment(
  store: EnvironmentStore,
  draft: EnvironmentDraft,
  options: ConnectOptions,
): Promise<AddResult> {
  const record = await store.add(draft, { now: options.now?.() });
  return verifyEnvironment(store, record, options);
}

/** Re-checks a recorded computer: pin, machine facts, tools, then persist. */
export function verifyEnvironment(
  store: EnvironmentStore,
  record: EnvironmentRecord,
  options: ConnectOptions,
): Promise<AddResult> {
  return check(store, record, options).then((outcome) => {
    if (outcome.ok) return outcome.result;
    throw outcome.error;
  }, (error: unknown) => {
    throw error;
  });
}

/** The same check as `verifyEnvironment`, reporting a failure as a status
 * instead of throwing it. A screen wants the state; a caller that must stop
 * wants the error. */
export async function checkEnvironment(
  store: EnvironmentStore,
  record: EnvironmentRecord,
  options: ConnectOptions,
): Promise<AddResult> {
  return (await check(store, record, options)).result;
}

type CheckOutcome = { ok: true; result: AddResult } | { ok: false; result: AddResult; error: unknown };

async function check(store: EnvironmentStore, record: EnvironmentRecord, options: ConnectOptions): Promise<CheckOutcome> {
  const target = targetOf(record, options.identity);
  const read = options.readKnownHosts ?? ((path: string) => readFileSync(path, "utf8"));
  let knownHostsText: string;
  try {
    knownHostsText = read(record.knownHostsFile) ?? "";
  } catch (error) {
    return { ok: false, result: await persistFailure(store, record, error), error };
  }
  try {
    preflightHostKey(target, {
      knownHostsText,
      presented: options.presentedKey ? await options.presentedKey() : null,
    });
  } catch (error) {
    return { ok: false, result: await persistFailure(store, record, error), error };
  }

  try {
    const facts = await probeMachine(options.runner, target);
    const tools = await probeTools(options.runner, target);
    const status: EnvironmentStatus = facts.capabilities.nonRoot === false ? "permissionDenied" : "online";
    const lastSeen = options.now?.() ?? new Date().toISOString();
    const updated = await store.recordProbe(record.id, { status, capabilities: facts.capabilities, tools, lastSeen });
    return { ok: true, result: { record: updated, capabilities: facts.capabilities, tools, status } };
  } catch (error) {
    return { ok: false, result: await persistFailure(store, record, error), error };
  }
}

function persistFailure(store: EnvironmentStore, record: EnvironmentRecord, error: unknown): Promise<AddResult> {
  const status = statusFor(error);
  return store
    .recordProbe(record.id, {
      status,
      capabilities: record.capabilities,
      tools: record.tools,
      lastSeen: record.lastSeen,
    })
    .then((updated) => ({ record: updated, capabilities: updated.capabilities, tools: updated.tools, status }));
}

/** The status a failure maps to, so a screen shows a state rather than a string. */
export function statusFor(error: unknown): EnvironmentStatus {
  if (error instanceof HostKeyChangedError) return "hostKeyChanged";
  if (error instanceof HostKeyMissingError) return "hostKeyChanged";
  if (error instanceof FingerprintMismatchError) return "hostKeyChanged";
  if (error instanceof HostKeyConfirmationRequiredError) return "hostKeyChanged";
  if (error instanceof SshDisconnectedError) return "unreachable";
  if (error instanceof SshFailureError) return "unreachable";
  if (error instanceof EnvironmentError && error.kind === "notNonRoot") return "permissionDenied";
  if (error instanceof EnvironmentError && error.kind === "diskLow") return "diskLow";
  if (error instanceof EnvironmentError && error.kind === "versionMismatch") return "needsUpdate";
  return "unknown";
}

/** The remote target for a record. The key path exists only for this call. */
export function targetOf(record: EnvironmentRecord, identity?: IdentityResolver): RemoteTarget {
  const identityFile = record.identityFileRef && identity ? identity(record.identityFileRef) : null;
  return {
    host: record.host,
    port: record.port,
    user: record.user,
    knownHostsFile: record.knownHostsFile,
    hostKeyFingerprint: record.hostKeyFingerprint,
    identityFile,
    // ssh looks up "[host]:port" for a non-default port. The file this layer
    // owns is keyed by the plain host, so pin the lookup to the same name.
    hostKeyAlias: record.port === 22 ? null : record.host,
  };
}

/** Confirms the computer answers at all, without changing anything. */
export async function ping(runner: SshRunner, record: EnvironmentRecord, identity?: IdentityResolver): Promise<boolean> {
  const result = await runRemote(runner, targetOf(record, identity), ["true"]);
  return result.code === 0;
}

export interface ReconfirmOptions {
  readonly confirm: boolean;
  /** What the computer presented, which the person has now seen. */
  readonly presented: HostKeyInput;
  /** Replaces the app's known-hosts file with `text`. Injected, so a test never
   * writes the real one. */
  readonly writeKnownHosts: (path: string, text: string) => void;
  readonly now?: () => string;
}

/**
 * The only way a changed pin is replaced: an explicit confirmation, the key the
 * computer presented, and a rewrite of this application's known-hosts entry.
 * Nothing else in this layer rewrites a pin, so a silent change stays refused.
 */
export async function reconfirmHostKey(
  store: EnvironmentStore,
  record: EnvironmentRecord,
  options: ReconfirmOptions,
): Promise<EnvironmentRecord> {
  if (options.confirm !== true) throw new ConfirmationRequiredError("replacing this computer's host key");
  const fingerprint = fingerprintOf(options.presented);
  const text = `${knownHostsLine(record.host, options.presented)}\n`;
  options.writeKnownHosts(record.knownHostsFile, text);
  const updated = await store.update(record.id, record.revision, {
    knownHostsFile: record.knownHostsFile,
    hostKeyFingerprint: fingerprint,
    status: "unknown",
    lastSeen: options.now?.() ?? record.lastSeen,
  });
  return updated;
}

export interface RemoveOptions {
  readonly confirm: boolean;
  readonly expectedRevision?: number;
}

export interface RemoveResult {
  readonly removed: EnvironmentRecord;
}

/**
 * Removes a computer from this application. Only the local record goes: nothing
 * under the person's home is deleted and no service is touched, because that
 * data is theirs and a delete cannot be undone. `herdr-core connect` is a stdio
 * client with no daemon to stop, so there is nothing to disable either.
 */
export async function removeEnvironment(
  store: EnvironmentStore,
  record: EnvironmentRecord,
  options: RemoveOptions,
): Promise<RemoveResult> {
  if (options.confirm !== true) throw new ConfirmationRequiredError("removing this computer");
  const removed = await store.remove(record.id, options.expectedRevision);
  return { removed };
}
