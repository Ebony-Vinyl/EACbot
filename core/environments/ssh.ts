/**
 * Runs commands on the user's own computer.
 *
 * Every argv this module builds goes through `sshConnectDescriptor` and
 * `assertSecureSshArgs` from `core/terminal/transport.ts`, so host-key
 * verification and batch mode are not this module's opinion: they are the
 * terminal layer's. Nothing here composes a shell string from user input; a
 * remote word is single-quoted and a script is a constant in this source.
 *
 * The runner is injected. Tests supply one that answers from memory, so no
 * test reaches a real computer.
 */

import { spawn } from "node:child_process";

import { assertSecureSshArgs, sshConnectDescriptor, type SpawnPlan, type SshConnectConfig } from "../terminal/transport.ts";
import {
  InvalidEnvironmentError,
  SshDisconnectedError,
  SshFailureError,
  UnsafeSshArgumentsError,
} from "./errors.ts";
import { fingerprintOf, verifyHostKey } from "./hostkey.ts";
import type { HostKeyInput } from "./types.ts";

const CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_TIMEOUT_MS = 20_000;

/** How much of one stream this layer keeps. A probe answers in a line or two;
 * anything past this is a runaway that must not become a memory problem. */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

/** A scan is a discovery, not a trust decision: it prints a host's key so a
 * person can compare it with a fingerprint they already have. */
const KEYSCAN_TIMEOUT_MS = 15_000;

/** What a remote run needs. `identityFile` is resolved from the record's
 * credential reference at call time and never persisted. */
export interface RemoteTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly knownHostsFile: string;
  readonly hostKeyFingerprint: string;
  readonly identityFile?: string | null;
  readonly hostKeyAlias?: string | null;
  readonly ssh?: string;
}

export interface SshCall {
  readonly plan: SpawnPlan;
  readonly timeoutMs: number;
  /** Text for the remote command's stdin, for a step that writes a file. */
  readonly stdin?: string;
  /** The identity file's path, when a plan used one, so a runner can keep it out
   * of anything it reports. */
  readonly identityFile?: string | null;
}

export interface SshResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SshRunner = (call: SshCall) => Promise<SshResult>;

/** ssh's own exit status for a failure that never reached the remote command. */
export const SSH_TRANSPORT_FAILURE = 255;

/** `true` when ssh itself failed, so the computer was never reached. */
export function isTransportFailure(result: SshResult): boolean {
  return result.code === SSH_TRANSPORT_FAILURE;
}

/**
 * A single-quoted POSIX word. Single quotes are inert in every shell ssh would
 * hand the line to, so a word can never become a second command.
 */
export function quoteRemoteWord(word: string): string {
  if (word === "") throw new InvalidEnvironmentError("an empty remote argument");
  for (const char of word) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) throw new InvalidEnvironmentError("a remote argument contains a control character");
  }
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The one string ssh receives as the remote command, built from an argv. */
export function remoteCommandLine(argv: readonly string[]): string {
  if (argv.length === 0) throw new InvalidEnvironmentError("a remote command needs at least one argument");
  return argv.map(quoteRemoteWord).join(" ");
}

/**
 * An ssh plan for one remote argv. The descriptor and the safety assertions are
 * the terminal layer's, so a plan this module produces cannot differ from one
 * `sshConnectPlan` produces in how it treats the host key.
 */
export function sshCommandPlan(target: RemoteTarget, argv: readonly string[]): SpawnPlan {
  const config: SshConnectConfig = {
    host: target.host,
    user: target.user,
    port: target.port,
    knownHostsFile: target.knownHostsFile,
    hostKeyFingerprint: target.hostKeyFingerprint,
    identityFile: target.identityFile ?? null,
    hostKeyAlias: target.hostKeyAlias ?? null,
    ...(target.ssh === undefined ? {} : { ssh: target.ssh }),
  };
  const descriptor = describeConnection(config);
  const options = [
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    `UserKnownHostsFile=${descriptor.knownHostsFile}`,
    `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
  ];
  if (descriptor.hostKeyAlias !== null) options.push(`HostKeyAlias=${descriptor.hostKeyAlias}`);
  if (descriptor.identitiesOnly) options.push("IdentitiesOnly=yes");

  const args = ["-T"];
  for (const option of options) args.push("-o", option);
  if (descriptor.usesIdentityFile) args.push("-i", config.identityFile!);
  if (descriptor.port !== null) args.push("-p", String(descriptor.port));
  if (descriptor.user !== null) args.push("-l", descriptor.user);
  args.push(descriptor.host, remoteCommandLine(argv));
  try {
    assertSecureSshArgs(args);
  } catch (error) {
    throw new UnsafeSshArgumentsError((error as Error).message);
  }
  return { command: config.ssh ?? "ssh", args, connect: descriptor };
}

/** The terminal layer's descriptor, with its refusal turned into this layer's
 * type. Every field it rejects is an argument ssh must not receive. */
function describeConnection(config: SshConnectConfig) {
  try {
    return sshConnectDescriptor(config);
  } catch (error) {
    throw new UnsafeSshArgumentsError((error as Error).message);
  }
}

/**
 * Runs one plan with the real `ssh`.
 *
 * stdin is closed (or fed the caller's text), a timeout kills the child, and
 * each stream is capped at `MAX_OUTPUT_BYTES` so a runaway remote program cannot
 * exhaust memory. The identity file's path is replaced in every message this
 * function produces: the key's location is the one thing in an ssh argv that
 * must not reach a log or a bug report.
 */
export const defaultSshRunner: SshRunner = (call) =>
  new Promise<SshResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(call.plan.command, [...call.plan.args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reject(new SshFailureError(redact(`cannot start ${call.plan.command}`, call), null, { cause: error }));
      return;
    }
    const out = collector();
    const err = collector();
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new SshFailureError(redact(`the ssh command timed out after ${call.timeoutMs}ms`, call), null)));
    }, call.timeoutMs);
    timer.unref?.();

    child.stdin?.on("error", () => {});
    if (call.stdin === undefined) child.stdin?.end();
    else child.stdin?.end(call.stdin);

    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error: Error) => {
      finish(() => reject(new SshFailureError(redact(`cannot start ${call.plan.command}: ${error.message}`, call), null, { cause: error })));
    });
    child.on("close", (code: number | null) => {
      finish(() =>
        resolve({
          code: code ?? SSH_TRANSPORT_FAILURE,
          stdout: out.text(),
          stderr: redact(err.text(), call),
        }),
      );
    });
  });

/** One stream, kept to a byte cap. Past the cap the rest is counted, not kept. */
function collector(limit = MAX_OUTPUT_BYTES) {
  const chunks: Buffer[] = [];
  let total = 0;
  let dropped = 0;
  return {
    push(chunk: Buffer): void {
      if (total >= limit) {
        dropped += chunk.byteLength;
        return;
      }
      const room = limit - total;
      if (chunk.byteLength <= room) {
        chunks.push(chunk);
        total += chunk.byteLength;
        return;
      }
      chunks.push(chunk.subarray(0, room));
      total += room;
      dropped += chunk.byteLength - room;
    },
    text(): string {
      const body = Buffer.concat(chunks).toString("utf8");
      return dropped === 0 ? body : `${body}\n[${dropped} more bytes were dropped]`;
    },
  };
}

/** Removes the identity file's path from text this layer will surface. */
function redact(text: string, call: SshCall): string {
  const identity = call.identityFile ?? identityFromPlan(call.plan);
  if (!identity) return text;
  return text.replaceAll(identity, "<identity-file>");
}

function identityFromPlan(plan: SpawnPlan): string | null {
  const at = plan.args.indexOf("-i");
  return at === -1 ? null : (plan.args[at + 1] ?? null);
}

export interface RunRemoteOptions {
  readonly timeoutMs?: number;
}

/** Runs one argv and returns the raw result, whatever its exit status. */
export async function runRemote(
  runner: SshRunner,
  target: RemoteTarget,
  argv: readonly string[],
  options: RunRemoteOptions = {},
): Promise<SshResult> {
  const plan = sshCommandPlan(target, argv);
  return runner({
    plan,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    identityFile: target.identityFile ?? null,
  });
}

/**
 * Runs one argv and returns stdout, or throws. Exit 255 is ssh failing to reach
 * the computer at all, which is a disconnect rather than the command's own
 * answer, and is reported as one.
 */
export async function runRemoteChecked(
  runner: SshRunner,
  target: RemoteTarget,
  argv: readonly string[],
  options: RunRemoteOptions = {},
): Promise<string> {
  const result = await runRemote(runner, target, argv, options);
  if (result.code === SSH_TRANSPORT_FAILURE) {
    throw new SshDisconnectedError(`the connection to ${target.host} dropped: ${tail(result.stderr)}`);
  }
  if (result.code !== 0) {
    throw new SshFailureError(`${argv[0] ?? "the remote command"} exited ${result.code}: ${tail(result.stderr)}`, result.code);
  }
  return result.stdout;
}

function tail(text: string): string {
  const line = text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  return line.slice(0, 200);
}

export interface HostKeyPreflight {
  readonly knownHostsText: string;
  /** What the computer presented, when a caller already read it. */
  readonly presented?: HostKeyInput | null;
}

/**
 * Confirms the record's pin is the key in the dedicated known-hosts file before
 * any command runs. A changed key is refused here, not after a connection.
 */
export function preflightHostKey(target: RemoteTarget, input: HostKeyPreflight): HostKeyInput {
  return verifyHostKey({
    host: target.host,
    knownHostsText: input.knownHostsText,
    expectedFingerprint: target.hostKeyFingerprint,
    presented: input.presented ?? null,
  });
}

/** Reads `ssh-keyscan` output into keys, one per key type. */
export function parseKeyscan(text: string): HostKeyInput[] {
  const keys: HostKeyInput[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 3) continue;
    const [, keyType, keyBlob] = fields as [string, string, string];
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(keyBlob)) keys.push({ keyType, keyBlob });
  }
  return keys;
}

/**
 * `ssh-keyscan`'s argv for one host. It is discovery only: the result is shown
 * to a person, and nothing it prints is trusted until a fingerprint the person
 * supplied matches it.
 *
 * No `-o` option is passed and no file is read, so a scan cannot be turned into
 * a command by a caller's value. `-T` bounds how long a silent host can hold
 * the scan open.
 */
export function keyscanPlan(target: Pick<RemoteTarget, "host" | "port" | "ssh">, timeoutSeconds = 10): string[] {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) {
    throw new InvalidEnvironmentError(`bad keyscan timeout ${timeoutSeconds}`);
  }
  const host = target.host;
  if (host.startsWith("-") || host === "" || host.includes("@") || host.includes("/")) {
    throw new InvalidEnvironmentError(`bad ssh host ${JSON.stringify(host)}`);
  }
  const args = ["-T", String(timeoutSeconds), "-t", "ed25519,ecdsa,rsa"];
  if (target.port !== undefined && target.port !== 22) args.push("-p", String(target.port));
  args.push(host);
  return args;
}

export interface DiscoveredHostKeys {
  readonly keys: readonly HostKeyInput[];
  /** The fingerprints in `SHA256:` form, which is what a screen shows. */
  readonly fingerprints: readonly string[];
}

/**
 * Asks the host for its keys. This is a *discovery*: the caller compares what
 * comes back with a fingerprint a person already has, and only that comparison
 * can pin anything. An unreachable host yields no keys rather than an error,
 * because "the scan saw nothing" and "the scan saw the wrong key" are different
 * answers and a screen says different things about them.
 */
export async function discoverHostKeys(
  runner: SshRunner,
  target: Pick<RemoteTarget, "host" | "port" | "ssh">,
  options: { timeoutMs?: number } = {},
): Promise<DiscoveredHostKeys> {
  const result = await runner({
    plan: { command: target.ssh ?? "ssh-keyscan", args: keyscanPlan(target) },
    timeoutMs: options.timeoutMs ?? KEYSCAN_TIMEOUT_MS,
  });
  const keys = parseKeyscan(result.stdout);
  return { keys, fingerprints: keys.map((key) => fingerprintOf(key)) };
}
