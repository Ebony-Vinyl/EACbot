/**
 * Installing herdr-core on the user's own computer.
 *
 * Three rules shape this module:
 * 1. A plan is data. `installPlan` computes what would happen and runs nothing,
 *    so a screen can show it before anything changes.
 * 2. Execution needs an explicit `confirm` and only ever goes through the
 *    executor the caller injected. This module holds no runner of its own.
 * 3. The download is a `tar.gz` checked against a pinned sha256, unpacked here
 *    in Node, and only then moved into place. A failure puts back what was
 *    there.
 *
 * The archive is never handed to a remote `tar`: its members are read by
 * `tar.ts`, which refuses a path that leaves the staging directory. Nothing
 * here pipes a vendor script into a shell.
 *
 * There is no systemd unit. `herdr-core connect` is a stdio client, not a
 * daemon, so a service whose `ExecStart` is that command would restart a client
 * that immediately has no pipe to speak over. The binary is installed; the
 * connection is opened by whoever needs it.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  ConfirmationRequiredError,
  DiskLowError,
  InstallChecksumError,
  InstallFailedError,
  InstallRolledBackError,
  NotNonRootError,
  SshFailureError,
  VersionMismatchError,
} from "./errors.ts";
import { MIN_FREE_BYTES, type MachineFacts } from "./probe.ts";
import { runRemote, sshCommandPlan, type RemoteTarget, type SshResult, type SshRunner } from "./ssh.ts";
import { findProgramMember, readTarGz, type TarMember } from "./tar.ts";
import type { EnvironmentCapabilities } from "./types.ts";

/** The herdr-core release this layer installs. Pinned, never "latest". */
export const HERDR_CORE_VERSION = "0.1.21";

const PROGRAM = "herdr-core";

/** The platform a release archive is built for, named as the release names it. */
export type ReleasePlatform = "linux-x86_64" | "linux-aarch64" | "macos-x86_64" | "macos-aarch64";

export interface ReleaseArtifact {
  readonly platform: ReleasePlatform;
  readonly url: string;
  /** Lowercase hex sha256 of the `.tar.gz` at `url`. */
  readonly sha256: string;
}

export interface ReleaseSource {
  readonly version: string;
  /** Every platform this release publishes, keyed by its own name. */
  readonly artifacts: Readonly<Record<ReleasePlatform, ReleaseArtifact>>;
  /** The archive for one platform, or a typed refusal for an unpublished one. */
  artifactFor(platform: ReleasePlatform): ReleaseArtifact;
}

/**
 * The published herdr-core 0.1.21 release, from
 * `https://releases.herdr.dev/core/latest.json`. The URLs and digests are the
 * ones that document carries for this version.
 */
export const HERDR_CORE_0_1_21_ARTIFACTS: Readonly<Record<ReleasePlatform, ReleaseArtifact>> = {
  "linux-x86_64": {
    platform: "linux-x86_64",
    url: "https://releases.herdr.dev/core/0.1.21/herdr-core-linux-x86_64.tar.gz",
    sha256: "78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1",
  },
  "linux-aarch64": {
    platform: "linux-aarch64",
    url: "https://releases.herdr.dev/core/0.1.21/herdr-core-linux-aarch64.tar.gz",
    sha256: "e844a2bfab48a226097679d076bc83042fe57fccef5387ef802e5b24e78b529a",
  },
  "macos-x86_64": {
    platform: "macos-x86_64",
    url: "https://releases.herdr.dev/core/0.1.21/herdr-core-macos-x86_64.tar.gz",
    sha256: "e377e1d342cddce0346da5b2f3c281b9701e4731c00024c7c5028265e77a217f",
  },
  "macos-aarch64": {
    platform: "macos-aarch64",
    url: "https://releases.herdr.dev/core/0.1.21/herdr-core-macos-aarch64.tar.gz",
    sha256: "1ab38dd9270f63a8f794d6d60e8702eb0d1c85a72bda85d735e5eea43f05ffed",
  },
};

export const DEFAULT_HERDR_CORE_SOURCE: ReleaseSource = {
  version: HERDR_CORE_VERSION,
  artifacts: HERDR_CORE_0_1_21_ARTIFACTS,
  artifactFor(platform: ReleasePlatform): ReleaseArtifact {
    const artifact = this.artifacts[platform];
    if (!artifact) throw new InstallFailedError(`herdr-core ${this.version} publishes no build for ${platform}`);
    return artifact;
  },
};

export interface ExecutorRequest {
  readonly argv: readonly string[];
  /** Text for the remote command's stdin, for a file this layer writes. */
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface ExecutorResult extends SshResult {}

/** The only way this module changes the computer. Tests inject a recorder. */
export type Executor = (request: ExecutorRequest) => Promise<ExecutorResult>;

/** Wraps a runner and a target into the executor an install takes. A request's
 * argv goes through the same validated ssh plan every other remote call uses. */
export function executorFor(runner: SshRunner, target: RemoteTarget): Executor {
  return (request) =>
    runner({
      plan: sshCommandPlan(target, request.argv),
      timeoutMs: request.timeoutMs ?? 60_000,
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    });
}

export interface InstallStep {
  readonly id: string;
  readonly description: string;
  /** The argv that will run, or null for a step this layer performs itself. */
  readonly argv: readonly string[] | null;
}

export interface InstallPlan {
  readonly version: string;
  readonly platform: ReleasePlatform;
  readonly artifact: ReleaseArtifact;
  readonly rootDir: string;
  readonly binDir: string;
  readonly programPath: string;
  readonly steps: readonly InstallStep[];
  readonly diskFreeBytes: number | null;
  readonly minimumFreeBytes: number;
}

export interface InstallPlanInput {
  readonly facts: MachineFacts;
  readonly source?: ReleaseSource;
}

/**
 * The release platform from the machine's own answer. A triple the release does
 * not publish is a typed refusal, never a nearest guess: an x64 archive on an
 * arm64 host fails as a bad-binary exec, far from the cause.
 */
export function releasePlatform(capabilities: EnvironmentCapabilities): ReleasePlatform {
  const os = capabilities.os === "Linux" ? "linux" : capabilities.os === "Darwin" ? "macos" : null;
  if (os === null) {
    throw new InstallFailedError(`herdr-core publishes builds for Linux and macOS, not ${capabilities.os ?? "an unknown system"}`);
  }
  const arch =
    capabilities.arch === "x86_64" || capabilities.arch === "amd64"
      ? "x86_64"
      : capabilities.arch === "aarch64" || capabilities.arch === "arm64"
        ? "aarch64"
        : null;
  if (arch === null) throw new InstallFailedError(`herdr-core publishes no build for architecture ${capabilities.arch ?? "unknown"}`);
  return `${os}-${arch}` as ReleasePlatform;
}

/** The home-relative directory everything this layer installs lives in. */
export function envRoot(homeDir: string): string {
  return `${homeDir}/.eacbot-env`;
}

export function installPlan(input: InstallPlanInput): InstallPlan {
  const source = input.source ?? DEFAULT_HERDR_CORE_SOURCE;
  const platform = releasePlatform(input.facts.capabilities);
  const artifact = source.artifactFor(platform);
  const home = input.facts.capabilities.homeDir;
  if (home === null) throw new InstallFailedError("the computer did not report a home directory");
  const rootDir = envRoot(home);
  const binDir = `${rootDir}/bin`;
  const programPath = `${binDir}/${PROGRAM}`;
  const staging = `${binDir}/${PROGRAM}.new`;
  return {
    version: source.version,
    platform,
    artifact,
    rootDir,
    binDir,
    programPath,
    diskFreeBytes: input.facts.capabilities.diskFreeBytes,
    minimumFreeBytes: MIN_FREE_BYTES,
    steps: [
      { id: "mkdir", description: `create ${binDir} with mode 0700`, argv: ["sh", "-c", 'umask 077; mkdir -p -- "$1"', "sh", binDir] },
      { id: "stage", description: `unpack ${artifact.url} and write its ${PROGRAM} to ${staging}`, argv: null },
      { id: "verify", description: `run the staged ${PROGRAM} and read its version`, argv: [staging, "--version"] },
      { id: "activate", description: `move the staged binary into place`, argv: ["sh", "-c", 'mv -f -- "$1" "$2"', "sh", staging, programPath] },
    ],
  };
}

export interface InstallOptions {
  /** The only channel that changes the computer. Tests inject a recorder. */
  readonly executor: Executor;
  /** The login user the preconditions are checked against. */
  readonly user: string;
  readonly facts: MachineFacts;
  readonly source?: ReleaseSource;
  /** Fetches the archive bytes. Injected so no test and no dry run reaches the network. */
  readonly download: (url: string) => Promise<Uint8Array>;
  /** Execution is refused unless this is exactly true. */
  readonly confirm: boolean;
}

export interface InstallResult {
  readonly version: string;
  readonly platform: ReleasePlatform;
  readonly programPath: string;
  readonly sha256: string;
  readonly rolledBack: boolean;
  /** The version the installed binary printed for itself. */
  readonly reportedVersion: string | null;
}

/**
 * Installs herdr-core. The order is: refuse unsafe preconditions, download,
 * verify the pinned digest, unpack in Node, stage, run the staged binary,
 * activate atomically, and on any failure restore the previous binary.
 */
export async function installHerdrCore(options: InstallOptions): Promise<InstallResult> {
  if (options.confirm !== true) throw new ConfirmationRequiredError("installing herdr-core");

  const { capabilities } = options.facts;
  if (capabilities.nonRoot === false || options.user === "root") throw new NotNonRootError(options.user);
  const free = capabilities.diskFreeBytes;
  if (free !== null && free < MIN_FREE_BYTES) throw new DiskLowError(free, MIN_FREE_BYTES);

  const source = options.source ?? DEFAULT_HERDR_CORE_SOURCE;
  const plan = installPlan({ facts: options.facts, source });

  const archive = await options.download(plan.artifact.url);
  const actual = sha256Hex(archive);
  if (actual !== plan.artifact.sha256.toLowerCase()) throw new InstallChecksumError(plan.artifact.sha256, actual);

  const binary = programFromArchive(archive);

  const executor = options.executor;
  const staged = `${plan.programPath}.new`;
  const rollbackPath = `${plan.programPath}.previous`;

  await expectOk(executor, stepArgv(plan, "mkdir"));
  const hadPrevious = await exists(executor, plan.programPath);
  if (hadPrevious) {
    await expectOk(executor, ["sh", "-c", 'cp -p -- "$1" "$2"', "sh", plan.programPath, rollbackPath]);
  }

  let reportedVersion: string | null = null;
  try {
    await writeExecutable(executor, staged, binary, capabilities.os);
    reportedVersion = await readStagedVersion(executor, stepArgv(plan, "verify"));
    if (reportedVersion !== null && reportedVersion !== plan.version) {
      throw new VersionMismatchError(plan.version, reportedVersion);
    }
    await expectOk(executor, stepArgv(plan, "activate"));
  } catch (error) {
    const recovered = await restore(executor, staged, rollbackPath, plan.programPath, hadPrevious);
    throw new InstallRolledBackError(
      `installing herdr-core ${source.version} failed: ${(error as Error).message}`,
      recovered,
      { cause: error },
    );
  }

  return {
    version: source.version,
    platform: plan.platform,
    programPath: plan.programPath,
    sha256: actual,
    rolledBack: false,
    reportedVersion,
  };
}

/** The one `herdr-core` member of the checked archive. */
export function programFromArchive(archive: Uint8Array): Buffer {
  const members: TarMember[] = readTarGz(archive);
  const member = findProgramMember(members, PROGRAM);
  if (member.bytes.byteLength === 0) throw new InstallFailedError(`the archive's ${PROGRAM} is empty`);
  return member.bytes;
}

/**
 * Runs the staged binary's `--version` before it replaces anything. A build for
 * the wrong platform, or a truncated one, fails here instead of after the move.
 */
async function readStagedVersion(executor: Executor, argv: readonly string[]): Promise<string | null> {
  const result = await executor({ argv });
  if (result.code !== 0) {
    throw new SshFailureError(`${PROGRAM} did not run: ${result.stderr.trim().slice(0, 200) || `exit ${result.code}`}`, result.code);
  }
  const match = /(\d+\.\d+\.\d+)/.exec(result.stdout);
  return match?.[1] ?? null;
}

async function restore(
  executor: Executor,
  staged: string,
  rollbackPath: string,
  programPath: string,
  hadPrevious: boolean,
): Promise<boolean> {
  await safeExec(executor, ["sh", "-c", 'rm -f -- "$1"', "sh", staged]);
  if (!hadPrevious) return true;
  const result = await safeExec(executor, ["sh", "-c", 'mv -f -- "$1" "$2"', "sh", rollbackPath, programPath]);
  return result !== null && result.code === 0;
}

/** The argv a named plan step will run. Execution reads the plan, so what a
 * screen showed is what runs. */
function stepArgv(plan: InstallPlan, id: string): readonly string[] {
  const step = plan.steps.find((candidate) => candidate.id === id);
  if (!step?.argv) throw new InstallFailedError(`the install plan has no runnable step ${id}`);
  return step.argv;
}

/**
 * Base64 on stdin keeps binary out of argv, where a process list would show it.
 * The decoder is chosen from the machine's own OS: GNU `base64 -d` and BSD
 * `base64 -D` differ, and macOS ships the BSD one.
 */
async function writeExecutable(executor: Executor, path: string, bytes: Uint8Array, os: string | null): Promise<void> {
  const encoded = gzipSync(bytes, { level: 9 }).toString("base64");
  const decoder = os === "Darwin" ? "base64 -D" : "base64 -d";
  const result = await executor({
    argv: ["sh", "-c", `${decoder} | gzip -d > "$1"`, "sh", path],
    stdin: encoded,
    timeoutMs: 300_000,
  });
  if (result.code !== 0) throw new SshFailureError(`cannot write ${path}: ${result.stderr.trim().slice(0, 200)}`, result.code);
  await expectOk(executor, ["sh", "-c", 'chmod 0755 -- "$1"', "sh", path]);
}

async function exists(executor: Executor, path: string): Promise<boolean> {
  const result = await safeExec(executor, ["sh", "-c", '[ -f "$1" ]', "sh", path]);
  return result !== null && result.code === 0;
}

async function expectOk(executor: Executor, argv: readonly string[]): Promise<void> {
  const result = await executor({ argv });
  if (result.code !== 0) {
    throw new SshFailureError(`${argv[0] ?? "the step"} exited ${result.code}: ${result.stderr.trim().slice(0, 200)}`, result.code);
  }
}

async function safeExec(executor: Executor, argv: readonly string[]): Promise<ExecutorResult | null> {
  try {
    return await executor({ argv });
  } catch {
    return null;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The version the installed binary reports, when its `--version` can be read. */
export async function installedVersion(runner: SshRunner, target: RemoteTarget, programPath: string): Promise<string | null> {
  const result = await runRemote(runner, target, [programPath, "--version"]);
  if (result.code !== 0) return null;
  const match = /(\d+\.\d+\.\d+)/.exec(result.stdout);
  return match?.[1] ?? null;
}

/** Refuses when the computer's binary is not the version this layer speaks. */
export async function requireVersion(runner: SshRunner, target: RemoteTarget, programPath: string): Promise<void> {
  const actual = await installedVersion(runner, target, programPath);
  if (actual !== HERDR_CORE_VERSION) throw new VersionMismatchError(HERDR_CORE_VERSION, actual);
}
