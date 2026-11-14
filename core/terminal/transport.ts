/**
 * The child process a connection rides, and the two spawn configurations the
 * core documents: `hc connect` locally, and `hc connect` on a remote host.
 *
 * A transport is always an argv plus an environment: never a shell string. An
 * ssh destination goes to ssh as one argument, and the remote side runs
 * `hc connect` itself (herdr-core 0.1.21, `crates/herdr-core/src/machines.rs`).
 *
 * The remote path is hardened for a machine the user owns but does not
 * physically control: host keys are checked against a dedicated known-hosts
 * file, a missing or changed key is a hard failure, and nothing may prompt.
 * `StrictHostKeyChecking=no` is not reachable from this API, by type or by
 * argument: see `assertSecureSshArgs`.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";

import { TransportError } from "./protocol.ts";

/**
 * A non-secret description of how a remote connection is made. The environment
 * layer reads it to pin the host key before the pipe opens; it carries no key
 * material, and the identity file is reported as configured or not, never as a
 * path.
 */
export interface SshConnectDescriptor {
  readonly kind: "ssh";
  readonly host: string;
  readonly user: string | null;
  readonly port: number | null;
  readonly knownHostsFile: string;
  readonly hostKeyFingerprint: string | null;
  readonly hostKeyAlias: string | null;
  readonly usesIdentityFile: boolean;
  readonly identitiesOnly: boolean;
  readonly batchMode: true;
  readonly strictHostKeyChecking: "yes";
}

export interface SpawnPlan {
  /** Program to run, as one argv entry. */
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Present for a remote core; the environment layer pins the host key from it. */
  readonly connect?: SshConnectDescriptor;
}

export interface SpawnedProcess {
  readonly child: ChildProcess;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /**
   * Rejects when the program could not be started at all (a missing binary,
   * a permission error). The spawn call itself returns before that is known.
   */
  readonly spawnFailure?: Promise<never>;
}

/** Starts the child. Tests substitute one that speaks the protocol in memory. */
export type Spawner = (plan: SpawnPlan, options: SpawnOptions) => SpawnedProcess;

export const SPAWN_OPTIONS: SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
};

export function defaultSpawner(plan: SpawnPlan, options: SpawnOptions): SpawnedProcess {
  const child = nodeSpawn(plan.command, [...plan.args], {
    ...options,
    env: plan.env === undefined ? process.env : { ...process.env, ...plan.env },
  });
  // A program that is not there fails asynchronously; the connection must hear
  // about it rather than wait for a reply that cannot come.
  const spawnFailure = new Promise<never>((_, reject) => {
    child.once("error", (error: Error) => {
      reject(new TransportError(`cannot start ${plan.command}: ${error.message}`, { cause: error }));
    });
  });
  spawnFailure.catch(() => {});
  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) {
    child.kill();
    throw new TransportError("the core process came up without the three pipes");
  }
  return { child, stdin, stdout, stderr, spawnFailure };
}

/** The binary name the core installs; `hc` is the same program. */
export const HC_PROGRAM = "herdr-core";

/**
 * A local core: `herdr-core connect`, the protocol over its stdin/stdout.
 * A session is selected the way the CLI does it, through the environment.
 */
export function localConnectPlan(options: { program?: string; session?: string | null } = {}): SpawnPlan {
  const env = options.session ? { HC_SESSION: options.session } : undefined;
  return { command: options.program ?? HC_PROGRAM, args: ["connect"], env };
}

/**
 * How to reach a remote core. `knownHostsFile` is required and must be a file
 * this application owns: the user's own `~/.ssh/known_hosts` is not read, so a
 * key trusted here is a key this application pinned on purpose.
 */
export interface SshConnectConfig {
  /** Bare host or address, without `user@` or `:port`. Use `parseSshTarget` for that form. */
  readonly host: string;
  readonly user?: string | null;
  readonly port?: number | null;
  /** A provisioned private key. Its path stays out of logs; its bytes are never read. */
  readonly identityFile?: string | null;
  /** Dedicated known-hosts file, absolute, owned by this application. */
  readonly knownHostsFile: string;
  /** The key the environment layer expects, as `SHA256:…` or `MD5:…`. */
  readonly hostKeyFingerprint?: string | null;
  /** The name the known-hosts entry is filed under, when it is not the host. */
  readonly hostKeyAlias?: string | null;
  /** The hc session there, like `HC_SESSION`. */
  readonly session?: string | null;
  readonly program?: string;
  /** The ssh binary, when it is not the one on PATH. */
  readonly ssh?: string;
  /**
   * Restrict ssh to the identities named here, ignoring an agent. Defaults to
   * true when `identityFile` is set: a provisioned key is the only one tried.
   */
  readonly identitiesOnly?: boolean;
}

/** Seconds ssh may take to connect, and how it keeps a long-lived pipe alive. */
const CONNECT_TIMEOUT_SECONDS = 10;
const SERVER_ALIVE_INTERVAL_SECONDS = 15;
const SERVER_ALIVE_COUNT_MAX = 4;

/**
 * A remote core: `ssh` runs `hc connect` there. The remote command is a fixed
 * line, so a caller never composes shell text from user input, and every ssh
 * setting is a separate argv entry.
 */
export function sshConnectPlan(config: SshConnectConfig): SpawnPlan {
  const descriptor = sshConnectDescriptor(config);
  const args = sshConnectArgs(config, descriptor);
  assertSecureSshArgs(args);
  return {
    command: config.ssh ?? "ssh",
    args,
    connect: descriptor,
  };
}

/**
 * Validates a remote connection and returns the description the environment
 * layer needs to pin the host key. Throws on anything that would let ssh do
 * something the caller did not ask for.
 */
export function sshConnectDescriptor(config: SshConnectConfig): SshConnectDescriptor {
  assertHost(config.host);
  if (config.user != null) assertUser(config.user);
  if (config.port != null) assertPort(config.port);
  assertDedicatedKnownHosts(config.knownHostsFile);
  if (config.identityFile != null) assertKeyPath(config.identityFile, "identity file");
  if (config.hostKeyFingerprint != null) assertFingerprint(config.hostKeyFingerprint);
  if (config.hostKeyAlias != null) assertHost(config.hostKeyAlias);
  if (config.session != null) assertNoControl(config.session, "session");
  if (config.program != null) assertNoControl(config.program, "program");
  if (config.ssh != null) assertNoControl(config.ssh, "ssh command");
  const usesIdentityFile = config.identityFile != null && config.identityFile !== "";
  return {
    kind: "ssh",
    host: config.host,
    user: config.user ?? null,
    port: config.port ?? null,
    knownHostsFile: config.knownHostsFile,
    hostKeyFingerprint: config.hostKeyFingerprint ?? null,
    hostKeyAlias: config.hostKeyAlias ?? null,
    usesIdentityFile,
    identitiesOnly: usesIdentityFile ? (config.identitiesOnly ?? true) : (config.identitiesOnly ?? false),
    batchMode: true,
    strictHostKeyChecking: "yes",
  };
}

function sshConnectArgs(config: SshConnectConfig, descriptor: SshConnectDescriptor): string[] {
  const options: string[] = [
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    `UserKnownHostsFile=${config.knownHostsFile}`,
    `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
    `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS}`,
    `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`,
  ];
  if (descriptor.hostKeyAlias !== null) options.push(`HostKeyAlias=${descriptor.hostKeyAlias}`);
  if (descriptor.identitiesOnly) options.push("IdentitiesOnly=yes");

  const args = ["-T"];
  for (const option of options) args.push("-o", option);
  if (descriptor.usesIdentityFile) args.push("-i", config.identityFile!);
  if (descriptor.port !== null) args.push("-p", String(descriptor.port));
  if (descriptor.user !== null) args.push("-l", descriptor.user);
  args.push(descriptor.host, remoteConnectLine(config.program ?? HC_PROGRAM, config.session ?? null));
  return args;
}

/**
 * The one invariant this module cannot express in a type: ssh must verify the
 * host key. Every `StrictHostKeyChecking` in a plan is `yes`, and no argument
 * may smuggle in a different value.
 */
export function assertSecureSshArgs(args: readonly string[]): void {
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === "-o" || arg === "-O") {
      const value = args[at + 1] ?? "";
      if (/^StrictHostKeyChecking=/i.test(value) && value !== "StrictHostKeyChecking=yes") {
        throw new TransportError(`refusing StrictHostKeyChecking=${value.slice("StrictHostKeyChecking=".length)}`);
      }
      if (/^(ProxyCommand|LocalCommand|PermitLocalCommand|KnownHostsCommand)=/i.test(value)) {
        throw new TransportError(`refusing ${value.split("=")[0]}: it runs a command`);
      }
      at += 1;
      continue;
    }
    if (/^StrictHostKeyChecking=/i.test(arg) && arg !== "StrictHostKeyChecking=yes") {
      throw new TransportError(`refusing StrictHostKeyChecking=${arg.slice("StrictHostKeyChecking=".length)}`);
    }
  }
  if (!args.includes("StrictHostKeyChecking=yes")) {
    throw new TransportError("an ssh plan must verify the host key");
  }
  if (!args.some((arg) => arg.startsWith("UserKnownHostsFile="))) {
    throw new TransportError("an ssh plan must name the known-hosts file it checks");
  }
  if (!args.includes("BatchMode=yes")) {
    throw new TransportError("an ssh plan must never prompt");
  }
}

/** `user@host:2222`, `ssh://user@host:2222` or a bare host, split into fields. */
export function parseSshTarget(target: string): { host: string; user: string | null; port: number | null } {
  if (typeof target !== "string" || target.trim() === "") {
    throw new TransportError("an ssh target is required");
  }
  const withoutScheme = target.startsWith("ssh://") ? target.slice("ssh://".length) : target;
  const at = withoutScheme.lastIndexOf("@");
  const user = at === -1 ? null : withoutScheme.slice(0, at);
  const rest = at === -1 ? withoutScheme : withoutScheme.slice(at + 1);
  if (rest === "") throw new TransportError(`bad ssh target ${JSON.stringify(target)}`);
  // A bracketed IPv6 literal keeps its colons; a trailing `:port` is a port.
  // The brackets are target syntax, not part of the host ssh is given.
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracketed) {
    return { host: bracketed[1]!, user, port: bracketed[2] === undefined ? null : Number(bracketed[2]) };
  }
  const colon = rest.lastIndexOf(":");
  if (colon !== -1) {
    const port = rest.slice(colon + 1);
    if (!/^\d+$/.test(port)) throw new TransportError(`bad ssh target ${JSON.stringify(target)}`);
    return { host: rest.slice(0, colon), user, port: Number(port) };
  }
  return { host: rest, user, port: null };
}

/** Builds a config from a target string plus the settings a target cannot carry. */
export function sshConfigFromTarget(
  target: string,
  options: Omit<SshConnectConfig, "host" | "user" | "port">,
): SshConnectConfig {
  const parsed = parseSshTarget(target);
  return { ...options, ...parsed };
}

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const IPV6_LITERAL = /^\[?[0-9A-Fa-f:.]+\]?$/;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A host is a name, an IPv4 address or a bracketed IPv6 literal: never an
 * option, never two words, and never something ssh would read as a setting.
 */
export function assertHost(host: string): void {
  if (typeof host !== "string" || host === "") throw new TransportError("an ssh host is required");
  assertNoControl(host, "host");
  if (host.startsWith("-") || host.includes("@") || host.includes("/")) {
    throw new TransportError(`bad ssh host ${JSON.stringify(host)}`);
  }
  if (!HOSTNAME.test(host) && !IPV6_LITERAL.test(host)) {
    throw new TransportError(`bad ssh host ${JSON.stringify(host)}`);
  }
}

function assertUser(user: string): void {
  if (!USERNAME.test(user)) throw new TransportError(`bad ssh user ${JSON.stringify(user)}`);
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TransportError(`bad ssh port ${port}: expected 1-65535`);
  }
}

/**
 * The known-hosts file must be an absolute path this application owns. A bare
 * name would resolve against the user's home, which is the file this design
 * deliberately does not trust.
 */
function assertDedicatedKnownHosts(path: string): void {
  if (typeof path !== "string" || path === "") {
    throw new TransportError("a dedicated known-hosts file is required");
  }
  assertNoControl(path, "known-hosts file");
  if (!isAbsolute(path)) {
    throw new TransportError(`the known-hosts file must be an absolute path, got ${JSON.stringify(path)}`);
  }
  if (path.startsWith("-")) throw new TransportError(`bad known-hosts file ${JSON.stringify(path)}`);
}

function assertKeyPath(path: string, what: string): void {
  if (path === "") throw new TransportError(`an empty ${what} path`);
  assertNoControl(path, what);
  if (path.startsWith("-")) throw new TransportError(`bad ${what} ${JSON.stringify(path)}`);
  if (!isAbsolute(path)) throw new TransportError(`the ${what} must be an absolute path, got ${JSON.stringify(path)}`);
}

function assertFingerprint(fingerprint: string): void {
  const sha256 = /^SHA256:[A-Za-z0-9+/]{43}$/;
  const md5 = /^MD5:(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/i;
  if (!sha256.test(fingerprint) && !md5.test(fingerprint)) {
    throw new TransportError(`bad host key fingerprint ${JSON.stringify(fingerprint)}: expected SHA256:… or MD5:…`);
  }
}

function assertNoControl(value: string, what: string): void {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) throw new TransportError(`bad ${what}: it contains a control character`);
  }
}

/**
 * The line ssh runs on the far side. It never prompts and never guesses: the
 * program is looked up on PATH, then in ~/.local/bin, and a missing one exits
 * 127 so the client can say so instead of hanging.
 */
export function remoteConnectLine(program: string, session: string | null): string {
  const env = session === null ? "" : `HC_SESSION=${quoteShellWord(session)} `;
  const name = quoteShellWord(program);
  return `sh -c 'p=$(command -v ${name}) || p=$HOME/.local/bin/${name}; [ -x "$p" ] || { echo "${program} not found there" >&2; exit 127; }; ${env}exec "$p" connect'`;
}

function quoteShellWord(word: string): string {
  if (/^[A-Za-z0-9_./@%+:=-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * A plan as it may be logged: the identity file's path is replaced, because a
 * log is the easiest place for a key's location to leak into a bug report.
 */
export function describeSpawnPlan(plan: SpawnPlan): { command: string; args: string[] } {
  const args = [...plan.args];
  for (let at = 0; at < args.length; at += 1) {
    if (args[at] === "-i" && at + 1 < args.length) {
      args[at + 1] = "<identity-file>";
      at += 1;
    }
  }
  return { command: plan.command, args };
}
