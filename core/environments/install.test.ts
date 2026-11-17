import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  ConfirmationRequiredError,
  DiskLowError,
  HERDR_CORE_0_1_21_ARTIFACTS,
  HERDR_CORE_VERSION,
  InstallChecksumError,
  InstallFailedError,
  InstallRolledBackError,
  NotNonRootError,
  VersionMismatchError,
  envRoot,
  executorFor,
  installHerdrCore,
  installPlan,
  installedVersion,
  programFromArchive,
  releasePlatform,
  requireVersion,
  sha256Hex,
  type Executor,
  type ExecutorRequest,
  type ExecutorResult,
  type ReleasePlatform,
  type ReleaseSource,
  type RemoteTarget,
} from "./index.ts";
import { standardMachine } from "./testing/fake-ssh.ts";
import { buildTarGz } from "./testing/build-tar.ts";

const TARGET: RemoteTarget = {
  host: "laptop.example",
  port: 22,
  user: "me",
  knownHostsFile: "/var/lib/eacbot/known_hosts",
  hostKeyFingerprint: `SHA256:${"a".repeat(43)}`,
};

const BINARY = Buffer.from("#!/bin/sh\necho herdr-core 0.1.21\n");
const ARCHIVE = buildTarGz([{ name: "herdr-core-0.1.21/herdr-core", bytes: BINARY }, { name: "herdr-core-0.1.21/README.md", bytes: Buffer.from("readme\n") }]);
const SHA = sha256Hex(ARCHIVE);

const SOURCE: ReleaseSource = {
  version: HERDR_CORE_VERSION,
  artifacts: HERDR_CORE_0_1_21_ARTIFACTS,
  artifactFor(platform: ReleasePlatform) {
    return { platform, url: `https://example.invalid/herdr-core-${platform}.tar.gz`, sha256: SHA };
  },
};

const CAPABILITIES = {
  os: "Linux",
  arch: "x86_64",
  shell: "/bin/bash",
  homeDir: "/home/me",
  diskFreeBytes: 10_000_000_000,
  nonRoot: true,
};

interface Recorded {
  readonly argv: readonly string[];
  readonly stdin: string | undefined;
}

function recorder(options: { failOn?: (request: ExecutorRequest) => boolean } = {}) {
  const requests: Recorded[] = [];
  const executor: Executor = async (request): Promise<ExecutorResult> => {
    requests.push({ argv: request.argv, stdin: request.stdin });
    if (options.failOn?.(request)) return { code: 1, stdout: "", stderr: "step failed" };
    if (request.argv.includes("--version")) return { code: 0, stdout: `${HERDR_CORE_VERSION}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { requests, executor };
}

const factsFor = async (overrides: Partial<typeof CAPABILITIES> = {}) => ({
  capabilities: { ...CAPABILITIES, ...overrides },
  errors: [],
});

describe("the release the default source names", () => {
  it("pins the four published platform archives with their own digests", () => {
    const platforms = Object.keys(HERDR_CORE_0_1_21_ARTIFACTS).sort();
    expect(platforms).toEqual(["linux-aarch64", "linux-x86_64", "macos-aarch64", "macos-x86_64"]);
    for (const artifact of Object.values(HERDR_CORE_0_1_21_ARTIFACTS)) {
      expect(artifact.url).toBe(`https://releases.herdr.dev/core/0.1.21/herdr-core-${artifact.platform}.tar.gz`);
      expect(artifact.url.endsWith(".tar.gz")).toBe(true);
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(HERDR_CORE_0_1_21_ARTIFACTS["linux-x86_64"].sha256).toBe(
      "78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1",
    );
    expect(HERDR_CORE_0_1_21_ARTIFACTS["linux-aarch64"].sha256).toBe(
      "e844a2bfab48a226097679d076bc83042fe57fccef5387ef802e5b24e78b529a",
    );
    expect(HERDR_CORE_0_1_21_ARTIFACTS["macos-x86_64"].sha256).toBe(
      "e377e1d342cddce0346da5b2f3c281b9701e4731c00024c7c5028265e77a217f",
    );
    expect(HERDR_CORE_0_1_21_ARTIFACTS["macos-aarch64"].sha256).toBe(
      "1ab38dd9270f63a8f794d6d60e8702eb0d1c85a72bda85d735e5eea43f05ffed",
    );
  });

  it("names an archive, never a bare executable", () => {
    for (const artifact of Object.values(HERDR_CORE_0_1_21_ARTIFACTS)) {
      expect(artifact.url).not.toMatch(/herdr-core-(linux|macos)-(x86_64|aarch64)$/);
    }
  });
});

describe("the install plan", () => {
  it("is data: it names the platform, the archive, the directory and every step", async () => {
    const plan = installPlan({ facts: await factsFor(), source: SOURCE });
    expect(plan.platform).toBe("linux-x86_64");
    expect(plan.artifact.url).toContain(".tar.gz");
    expect(plan.binDir).toBe("/home/me/.eacbot-env/bin");
    expect(plan.programPath).toBe("/home/me/.eacbot-env/bin/herdr-core");
    expect(plan.steps.map((step) => step.id)).toEqual(["mkdir", "stage", "verify", "activate"]);
    expect(plan.version).toBe(HERDR_CORE_VERSION);
  });

  it("creates the directory with a restrictive umask and mode 0700", async () => {
    const plan = installPlan({ facts: await factsFor(), source: SOURCE });
    const mkdir = plan.steps.find((step) => step.id === "mkdir")!;
    expect(mkdir.argv).toEqual(["sh", "-c", 'umask 077; mkdir -p -- "$1"', "sh", "/home/me/.eacbot-env/bin"]);
  });

  it("runs the staged binary's own --version before it replaces anything", async () => {
    const plan = installPlan({ facts: await factsFor(), source: SOURCE });
    const verify = plan.steps.find((step) => step.id === "verify")!;
    expect(verify.argv).toEqual(["/home/me/.eacbot-env/bin/herdr-core.new", "--version"]);
  });

  it("has no service unit, because connect is a stdio client and not a daemon", async () => {
    const plan = installPlan({ facts: await factsFor(), source: SOURCE }) as unknown as Record<string, unknown>;
    expect(plan.serviceUnit).toBeUndefined();
    for (const step of (plan.steps as { argv: readonly string[] | null }[])) {
      if (step.argv === null) continue;
      expect(step.argv.join(" ")).not.toMatch(/systemctl|systemd|\.service/);
    }
  });

  it("never pipes a vendor script into a shell", async () => {
    const plan = installPlan({ facts: await factsFor(), source: SOURCE });
    for (const step of plan.steps) {
      if (step.argv === null) continue;
      const line = step.argv.join(" ");
      expect(line).not.toContain("curl");
      expect(line).not.toContain("| sh");
      expect(line).not.toContain("| bash");
    }
  });

  it("maps a machine's own OS and architecture to the release's platform name", () => {
    expect(releasePlatform(CAPABILITIES)).toBe("linux-x86_64");
    expect(releasePlatform({ ...CAPABILITIES, os: "Darwin", arch: "arm64" })).toBe("macos-aarch64");
    expect(releasePlatform({ ...CAPABILITIES, os: "Linux", arch: "aarch64" })).toBe("linux-aarch64");
    expect(() => releasePlatform({ ...CAPABILITIES, os: "FreeBSD" })).toThrow(InstallFailedError);
    expect(() => releasePlatform({ ...CAPABILITIES, arch: "riscv64" })).toThrow(InstallFailedError);
  });

  it("refuses a platform the release does not publish", () => {
    const source: ReleaseSource = {
      version: HERDR_CORE_VERSION,
      artifacts: HERDR_CORE_0_1_21_ARTIFACTS,
      artifactFor() {
        throw new InstallFailedError("not published");
      },
    };
    expect(() => installPlan({ facts: { capabilities: CAPABILITIES, errors: [] }, source })).toThrow(InstallFailedError);
  });

  it("refuses a plan when the computer reported no home directory", () => {
    expect(() => installPlan({ facts: { capabilities: { ...CAPABILITIES, homeDir: null }, errors: [] } })).toThrow(
      InstallFailedError,
    );
  });

  it("builds the root from the reported home, not from a guessed one", () => {
    expect(envRoot("/home/someone")).toBe("/home/someone/.eacbot-env");
  });
});

describe("unpacking the release archive", () => {
  it("finds the binary inside the archive and ignores the other members", () => {
    expect(programFromArchive(ARCHIVE).toString()).toBe(BINARY.toString());
  });

  it("refuses an archive that is not gzip", () => {
    expect(() => programFromArchive(Buffer.from("not gzip"))).toThrow(InstallFailedError);
  });

  it("refuses an archive with no binary", () => {
    const empty = buildTarGz([{ name: "pkg/README.md", bytes: Buffer.from("x") }]);
    expect(() => programFromArchive(empty)).toThrow(/no herdr-core/);
  });

  it("refuses an archive whose binary is empty", () => {
    const empty = buildTarGz([{ name: "pkg/herdr-core", bytes: Buffer.alloc(0) }]);
    expect(() => programFromArchive(empty)).toThrow(/is empty/);
  });
});

describe("installing herdr-core", () => {
  it("refuses to run without an explicit confirmation", async () => {
    const { executor, requests } = recorder();
    await expect(
      installHerdrCore({ executor, user: "me", facts: await factsFor(), source: SOURCE, download: async () => ARCHIVE, confirm: false }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(requests).toHaveLength(0);
  });

  it("refuses a root login", async () => {
    await expect(
      installHerdrCore({
        executor: recorder().executor,
        user: "root",
        facts: await factsFor({ nonRoot: false }),
        source: SOURCE,
        download: async () => ARCHIVE,
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(NotNonRootError);
  });

  it("refuses a computer with too little free space", async () => {
    await expect(
      installHerdrCore({
        executor: recorder().executor,
        user: "me",
        facts: await factsFor({ diskFreeBytes: 1024 }),
        source: SOURCE,
        download: async () => ARCHIVE,
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(DiskLowError);
  });

  it("refuses bytes that do not match the pinned sha256, before touching the computer", async () => {
    const { executor, requests } = recorder();
    await expect(
      installHerdrCore({
        executor,
        user: "me",
        facts: await factsFor(),
        source: SOURCE,
        download: async () => buildTarGz([{ name: "pkg/herdr-core", bytes: Buffer.from("other") }]),
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(InstallChecksumError);
    expect(requests).toHaveLength(0);
  });

  it("downloads the platform archive the plan named", async () => {
    const urls: string[] = [];
    const { executor } = recorder();
    await installHerdrCore({
      executor,
      user: "me",
      facts: await factsFor(),
      source: SOURCE,
      download: async (url) => {
        urls.push(url);
        return ARCHIVE;
      },
      confirm: true,
    });
    expect(urls).toEqual(["https://example.invalid/herdr-core-linux-x86_64.tar.gz"]);
  });

  it("writes only the extracted binary, not the whole archive", async () => {
    const { executor, requests } = recorder();
    await installHerdrCore({ executor, user: "me", facts: await factsFor(), source: SOURCE, download: async () => ARCHIVE, confirm: true });
    const writer = requests.find((request) => request.stdin !== undefined);
    expect(gunzipSync(Buffer.from(writer!.stdin!, "base64"))).toEqual(BINARY);
  });

  it("sends the binary as base64 on stdin, never in argv", async () => {
    const { executor, requests } = recorder();
    await installHerdrCore({ executor, user: "me", facts: await factsFor(), source: SOURCE, download: async () => ARCHIVE, confirm: true });
    const writer = requests.find((request) => request.stdin !== undefined)!;
    for (const request of requests) {
      expect(request.argv.join(" ")).not.toContain(writer.stdin!);
      expect(request.argv.join(" ")).not.toContain("herdr-core-0.1.21/README.md");
    }
  });

  it("reports the version the staged binary printed for itself", async () => {
    const { executor } = recorder();
    const result = await installHerdrCore({
      executor,
      user: "me",
      facts: await factsFor(),
      source: SOURCE,
      download: async () => ARCHIVE,
      confirm: true,
    });
    expect(result.reportedVersion).toBe(HERDR_CORE_VERSION);
    expect(result.sha256).toBe(SHA);
    expect(result.platform).toBe("linux-x86_64");
  });

  it("rolls back when the staged binary will not run", async () => {
    const { executor } = recorder({ failOn: (request) => request.argv.includes("--version") });
    const error = await installHerdrCore({
      executor,
      user: "me",
      facts: await factsFor(),
      source: SOURCE,
      download: async () => ARCHIVE,
      confirm: true,
    }).catch((caught: unknown) => caught as InstallRolledBackError);
    expect(error).toBeInstanceOf(InstallRolledBackError);
    expect(error.recovered).toBe(true);
  });

  it("rolls back when the staged binary reports another version", async () => {
    const requests: ExecutorRequest[] = [];
    const executor: Executor = async (request) => {
      requests.push(request);
      if (request.argv.includes("--version")) return { code: 0, stdout: "0.1.9\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const error = await installHerdrCore({
      executor,
      user: "me",
      facts: await factsFor(),
      source: SOURCE,
      download: async () => ARCHIVE,
      confirm: true,
    }).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(InstallRolledBackError);
    expect(error.message).toContain("0.1.9");
    expect(requests.some((request) => request.argv.join(" ").includes("mv -f"))).toBe(true);
  });

  it("reports a rollback that itself failed instead of hiding it", async () => {
    const executor: Executor = async (request) => {
      if (request.argv.includes("--version")) return { code: 1, stdout: "", stderr: "cannot execute" };
      if (request.argv.join(" ").includes("mv -f")) return { code: 1, stdout: "", stderr: "no" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const error = await installHerdrCore({
      executor,
      user: "me",
      facts: await factsFor(),
      source: SOURCE,
      download: async () => ARCHIVE,
      confirm: true,
    }).catch((caught: unknown) => caught as InstallRolledBackError);
    expect(error).toBeInstanceOf(InstallRolledBackError);
    expect(error.recovered).toBe(false);
  });

  it("changes the computer only through the executor it was handed", async () => {
    const { executor, requests } = recorder();
    await installHerdrCore({ executor, user: "me", facts: await factsFor(), source: SOURCE, download: async () => ARCHIVE, confirm: true });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some((request) => request.argv[0] === "sh")).toBe(true);
  });

  it("keeps every install step on the validated ssh plan", async () => {
    const machine = standardMachine().allowEverything();
    await installHerdrCore({
      executor: executorFor(machine.runner, TARGET),
      user: "me",
      facts: await factsFor(),
      source: SOURCE,
      download: async () => ARCHIVE,
      confirm: true,
    });
    for (const plan of machine.plans()) {
      expect(plan.args).toContain("StrictHostKeyChecking=yes");
      expect(plan.args).toContain("BatchMode=yes");
    }
  });

  it("uses the decoder the machine's own base64 ships", async () => {
    const linux = standardMachine().allowEverything();
    await installHerdrCore({
      executor: executorFor(linux.runner, TARGET),
      user: "me",
      facts: await factsFor(),
      source: SOURCE,
      download: async () => ARCHIVE,
      confirm: true,
    });
    expect(linux.lines().some((line) => line.includes("base64 -d"))).toBe(true);

    const mac = standardMachine({ os: "Darwin", arch: "aarch64" }).allowEverything();
    await installHerdrCore({
      executor: executorFor(mac.runner, TARGET),
      user: "me",
      facts: await factsFor({ os: "Darwin", arch: "aarch64" }),
      source: SOURCE,
      download: async () => ARCHIVE,
      confirm: true,
    });
    expect(mac.lines().some((line) => line.includes("base64 -D"))).toBe(true);
    expect(mac.lines().some((line) => line.includes("base64 -d"))).toBe(false);
  });
});

describe("the installed version", () => {
  it("reads the version the remote binary prints", async () => {
    const machine = standardMachine().answer(["/home/me/.eacbot-env/bin/herdr-core", "--version"], {
      code: 0,
      stdout: "herdr-core 0.1.21\n",
    });
    expect(await installedVersion(machine.runner, TARGET, "/home/me/.eacbot-env/bin/herdr-core")).toBe("0.1.21");
  });

  it("refuses a version that is not the one this layer speaks", async () => {
    const machine = standardMachine().answer(["/x/herdr-core", "--version"], { code: 0, stdout: "herdr-core 0.1.9\n" });
    await expect(requireVersion(machine.runner, TARGET, "/x/herdr-core")).rejects.toBeInstanceOf(VersionMismatchError);
  });

  it("refuses when the binary is absent", async () => {
    await expect(requireVersion(standardMachine().runner, TARGET, "/x/herdr-core")).rejects.toBeInstanceOf(VersionMismatchError);
  });
});
