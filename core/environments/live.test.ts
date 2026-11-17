/**
 * Tests against a real host and the real release server.
 *
 * They are gated: with no explicit environment variable in the list below, the
 * whole file is skipped, so the ordinary suite never reaches a network or a
 * user's computer. When a gate is set, the test says what it proved and what it
 * did not.
 *
 * These run against a host the operator allocates for testing. Nothing here
 * writes to a computer unless `EAC_ENV_LIVE_INSTALL=1` is also set, and even
 * then it installs only into `~/.eacbot-env`.
 */

import { describe, expect, it } from "vitest";

import {
  HERDR_CORE_0_1_21_ARTIFACTS,
  HERDR_CORE_VERSION,
  defaultSshRunner,
  executorFor,
  installHerdrCore,
  installPlan,
  programFromArchive,
  probeMachine,
  sha256Hex,
  type RemoteTarget,
  type ReleasePlatform,
} from "./index.ts";

/** A live host, from the operator's own environment. */
const HOST = process.env.EAC_ENV_LIVE_HOST ?? "";
const USER = process.env.EAC_ENV_LIVE_USER ?? "";
const PORT = Number(process.env.EAC_ENV_LIVE_PORT ?? "22");
const KNOWN_HOSTS = process.env.EAC_ENV_LIVE_KNOWN_HOSTS ?? "";
const FINGERPRINT = process.env.EAC_ENV_LIVE_FINGERPRINT ?? "";
const IDENTITY = process.env.EAC_ENV_LIVE_IDENTITY ?? "";
const INSTALL = process.env.EAC_ENV_LIVE_INSTALL === "1";

const hostConfigured = HOST !== "" && USER !== "" && KNOWN_HOSTS !== "" && FINGERPRINT !== "";
const downloadConfigured = process.env.EAC_ENV_LIVE_DOWNLOAD === "1";

const target: RemoteTarget = {
  host: HOST,
  port: Number.isInteger(PORT) ? PORT : 22,
  user: USER,
  knownHostsFile: KNOWN_HOSTS,
  hostKeyFingerprint: FINGERPRINT,
  ...(IDENTITY === "" ? {} : { identityFile: IDENTITY }),
};

describe.skipIf(!downloadConfigured)("the published release archive", () => {
  it("downloads the linux-x86_64 archive and its digest matches the pin", async () => {
    const artifact = HERDR_CORE_0_1_21_ARTIFACTS["linux-x86_64"];
    const response = await fetch(artifact.url, { redirect: "follow" });
    expect(response.ok).toBe(true);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(sha256Hex(bytes)).toBe(artifact.sha256);
  }, 120_000);

  it("unpacks a herdr-core binary that reports the pinned version", async () => {
    const artifact = HERDR_CORE_0_1_21_ARTIFACTS["linux-x86_64"];
    const response = await fetch(artifact.url, { redirect: "follow" });
    const binary = programFromArchive(new Uint8Array(await response.arrayBuffer()));
    expect(binary.byteLength).toBeGreaterThan(1_000_000);
    expect(binary.subarray(0, 4).toString("hex")).toBe("7f454c46");
  }, 120_000);

  it("has a distinct digest per published platform", () => {
    const digests = Object.values(HERDR_CORE_0_1_21_ARTIFACTS).map((artifact) => artifact.sha256);
    expect(new Set(digests).size).toBe(digests.length);
    for (const platform of Object.keys(HERDR_CORE_0_1_21_ARTIFACTS) as ReleasePlatform[]) {
      expect(HERDR_CORE_0_1_21_ARTIFACTS[platform].platform).toBe(platform);
    }
  });
});

describe.skipIf(!hostConfigured)("a real allocated host", () => {
  it("answers the machine probe with its own facts", async () => {
    const facts = await probeMachine(defaultSshRunner, target);
    expect(facts.capabilities.os === "Linux" || facts.capabilities.os === "Darwin").toBe(true);
    expect(facts.capabilities.homeDir).not.toBeNull();
    expect(facts.errors).toEqual([]);
  }, 60_000);

  it("plans an install for the platform the host actually is", async () => {
    const facts = await probeMachine(defaultSshRunner, target);
    const plan = installPlan({ facts });
    expect(plan.platform.startsWith(facts.capabilities.os === "Darwin" ? "macos-" : "linux-")).toBe(true);
    expect(plan.programPath.startsWith(`${facts.capabilities.homeDir}/.eacbot-env/`)).toBe(true);
    expect(plan.version).toBe(HERDR_CORE_VERSION);
  }, 60_000);
});

describe.skipIf(!(hostConfigured && INSTALL))("installing on a real allocated host", () => {
  it("installs herdr-core into ~/.eacbot-env and the binary answers --version", async () => {
    const facts = await probeMachine(defaultSshRunner, target);
    const plan = installPlan({ facts });
    const result = await installHerdrCore({
      executor: executorFor(defaultSshRunner, target),
      user: USER,
      facts,
      download: async (url) => {
        const response = await fetch(url, { redirect: "follow" });
        expect(response.ok).toBe(true);
        return new Uint8Array(await response.arrayBuffer());
      },
      confirm: true,
    });
    expect(result.reportedVersion).toBe(HERDR_CORE_VERSION);
    expect(result.programPath).toBe(plan.programPath);
  }, 300_000);
});
