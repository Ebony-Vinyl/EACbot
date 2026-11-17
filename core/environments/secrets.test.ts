import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EnvironmentStore,
  HERDR_CORE_0_1_21_ARTIFACTS,
  HERDR_CORE_VERSION,
  HostKeyChangedError,
  InstallChecksumError,
  addEnvironment,
  fingerprintOf,
  installHerdrCore,
  installPlan,
  knownHostsLine,
  sha256Hex,
  sshCommandPlan,
  type EnvironmentDraft,
  type HostKeyInput,
  type ReleaseSource,
} from "./index.ts";
import { describeSpawnPlan } from "../terminal/transport.ts";
import { probeMachine } from "./probe.ts";
import { standardMachine } from "./testing/fake-ssh.ts";

const directories: string[] = [];

/** Every source file this layer ships, so a scan covers all of them. */
const SOURCE_FILES = [
  "connect.ts",
  "errors.ts",
  "first-contact.ts",
  "hostkey.ts",
  "index.ts",
  "install.ts",
  "probe.ts",
  "ssh.ts",
  "store.ts",
  "tar.ts",
  "types.ts",
];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eac-env-secrets-"));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function key(): HostKeyInput {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = Buffer.from(der).subarray(der.length - 32);
  const type = Buffer.from("ssh-ed25519");
  const size = (value: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value, 0);
    return out;
  };
  return { keyType: "ssh-ed25519", keyBlob: Buffer.concat([size(type.length), type, size(raw.length), raw]).toString("base64") };
}

const HOST_KEY = key();
const FINGERPRINT = fingerprintOf(HOST_KEY);
const PRIVATE_KEY_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";

function draft(overrides: Partial<EnvironmentDraft> = {}): EnvironmentDraft {
  return {
    label: "my laptop",
    host: "laptop.example",
    user: "me",
    knownHostsFile: "/var/lib/eacbot/known_hosts",
    hostKeyFingerprint: FINGERPRINT,
    ...overrides,
  };
}

describe("no key material ever reaches the disk", () => {
  it("writes no private key body after a full add and verify", async () => {
    const dir = tempDir();
    const store = EnvironmentStore.open({ dataDir: dir });
    await addEnvironment(store, draft({ identityFileRef: "credential:laptop" }), {
      runner: standardMachine({ tools: { claude: "/usr/bin/claude" }, versions: { claude: "2.1.7 (Claude Code)" } }).runner,
      readKnownHosts: () => knownHostsLine("laptop.example", HOST_KEY),
      identity: () => "/home/me/.ssh/id_ed25519",
    });
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text).not.toContain(PRIVATE_KEY_MARKER);
      expect(text).not.toContain("id_ed25519");
    }
  });

  it("keeps a private key out of the record even when a caller passes one", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    await expect(
      store.add({ ...draft(), ...({ privateKey: `${PRIVATE_KEY_MARKER}\nAAAA\n` } as object) }),
    ).rejects.toMatchObject({ kind: "secretInRecord" });
    expect(store.list()).toEqual([]);
  });
});

describe("no credential ever reaches a command line", () => {
  it("builds an ssh argv with no token, password or key body", () => {
    const plan = sshCommandPlan(
      {
        host: "laptop.example",
        port: 22,
        user: "me",
        knownHostsFile: "/var/lib/eacbot/known_hosts",
        hostKeyFingerprint: FINGERPRINT,
        identityFile: "/var/lib/eacbot/keys/me_ed25519",
      },
      ["sh", "-c", "command -v -- \"$1\"", "sh", "claude"],
    );
    const joined = plan.args.join(" ");
    expect(joined).not.toMatch(/password|passphrase|token|api[_-]?key|secret/i);
    expect(joined).not.toContain(PRIVATE_KEY_MARKER);
  });

  it("replaces the identity path when a plan is described for a log", () => {
    const plan = sshCommandPlan(
      {
        host: "laptop.example",
        port: 22,
        user: "me",
        knownHostsFile: "/var/lib/eacbot/known_hosts",
        hostKeyFingerprint: FINGERPRINT,
        identityFile: "/var/lib/eacbot/keys/me_ed25519",
      },
      ["true"],
    );
    const described = describeSpawnPlan(plan);
    expect(described.args).not.toContain("/var/lib/eacbot/keys/me_ed25519");
    expect(described.args).toContain("<identity-file>");
  });
});

describe("a changed host key is always refused", () => {
  it("refuses before any command runs, and never rewrites the pin", async () => {
    const dir = tempDir();
    const store = EnvironmentStore.open({ dataDir: dir });
    const machine = standardMachine();
    const result = await addEnvironment(store, draft(), {
      runner: machine.runner,
      readKnownHosts: () => knownHostsLine("laptop.example", key()),
    }).catch(() => null);
    expect(result).toBeNull();
    expect(store.list()[0]!.status).toBe("hostKeyChanged");
    expect(machine.calls).toHaveLength(0);
    const text = readFileSync(join(dir, "environments.json"), "utf8");
    expect(text).toContain(FINGERPRINT);
  });

  it("refuses a presented key that differs from the pin", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const error = await addEnvironment(store, draft(), {
      runner: standardMachine().runner,
      readKnownHosts: () => knownHostsLine("laptop.example", HOST_KEY),
      presentedKey: async () => key(),
    }).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(HostKeyChangedError);
    expect(store.list()[0]!.status).toBe("hostKeyChanged");
  });
});

describe("installation refuses to trust the network", () => {
  const CAPABILITIES = {
    os: "Linux",
    arch: "x86_64",
    shell: "/bin/bash",
    homeDir: "/home/me",
    diskFreeBytes: 10_000_000_000,
    nonRoot: true,
  };

  it("refuses a checksum mismatch", async () => {
    const source: ReleaseSource = {
      version: HERDR_CORE_VERSION,
      artifacts: HERDR_CORE_0_1_21_ARTIFACTS,
      artifactFor: (platform) => ({ platform, url: "https://example.invalid/x.tar.gz", sha256: sha256Hex(new Uint8Array([1])) }),
    };
    await expect(
      installHerdrCore({
        executor: async () => ({ code: 0, stdout: "", stderr: "" }),
        user: "me",
        facts: { capabilities: CAPABILITIES, errors: [] },
        source,
        download: async () => new Uint8Array([2]),
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(InstallChecksumError);
  });

  it("names a fixed version, never a mutable latest", async () => {
    const facts = await probeMachine(standardMachine().runner, {
      host: "h",
      port: 22,
      user: "me",
      knownHostsFile: "/k",
      hostKeyFingerprint: FINGERPRINT,
    });
    const plan = installPlan({ facts });
    expect(plan.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plan.version).toBe(HERDR_CORE_VERSION);
  });

  it("installs a pinned archive and no service, because connect is a client", async () => {
    const facts = { capabilities: CAPABILITIES, errors: [] };
    const plan = installPlan({ facts });
    expect(plan.artifact.url).toBe("https://releases.herdr.dev/core/0.1.21/herdr-core-linux-x86_64.tar.gz");
    expect(plan.artifact.sha256).toBe("78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1");
    expect(plan).not.toHaveProperty("serviceUnit");
  });

  it("never writes a systemd unit or calls systemctl in its source", () => {
    for (const name of SOURCE_FILES) {
      const text = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
      expect(text).not.toMatch(/systemctl/);
      expect(text).not.toMatch(/WantedBy=/);
      expect(text).not.toMatch(/\[Service\]/);
      expect(text).not.toMatch(/^ExecStart=/m);
    }
  });
});

describe("this layer never names a commercial provider", () => {
  // The terms are assembled so this test's own text does not carry them.
  const banned = [["Insta", "box"], ["B", "oat"], ["\u8d2d\u4e70"], ["\u5957", "\u9910"]];

  it("mentions no provider, purchase or plan language in its source", () => {
    for (const name of SOURCE_FILES) {
      const text = readFileSync(new URL(`./${name}`, import.meta.url), "utf8").toLowerCase();
      for (const [left, right] of banned) {
        expect(text).not.toContain(`${left}${right}`.toLowerCase());
      }
    }
  });

  it("does not import the legacy server, and starts only ssh, never an agent binary", () => {
    for (const name of SOURCE_FILES) {
      const text = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
      expect(text).not.toMatch(/from\s+["'][^"']*\/server\//);
      expect(text).not.toMatch(/from\s+["'][^"']*server\/index\.ts/);
      expect(text).not.toMatch(/\bdefaultSpawner\b/);
    }
    const spawners = SOURCE_FILES.filter((name) =>
      /node:child_process/.test(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")),
    );
    expect(spawners).toEqual(["ssh.ts"]);
  });
});

describe("the store's own files", () => {
  it("leaves no lock file behind after a mutation", async () => {
    const dir = tempDir();
    const store = EnvironmentStore.open({ dataDir: dir });
    await store.add(draft());
    expect(readdirSync(dir).some((name) => name.endsWith(".lock"))).toBe(false);
  });

  it("recovers from a lock left by a writer that died", async () => {
    const dir = tempDir();
    const store = EnvironmentStore.open({ dataDir: dir });
    writeFileSync(`${store.filePath}.lock`, "999999");
    const { utimesSync } = await import("node:fs");
    const past = new Date(Date.now() - 60_000);
    utimesSync(`${store.filePath}.lock`, past, past);
    await expect(store.add(draft())).resolves.toMatchObject({ host: "laptop.example" });
  });
});
