import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConfirmationRequiredError,
  DiskLowError,
  EnvironmentStore,
  FingerprintMismatchError,
  HostKeyChangedError,
  HostKeyConfirmationRequiredError,
  HostKeyMissingError,
  NotNonRootError,
  SshDisconnectedError,
  SshFailureError,
  UnknownEnvironmentError,
  VersionMismatchError,
  addEnvironment,
  addFirstEnvironment,
  checkEnvironment,
  fingerprintOf,
  knownHostsLine,
  ping,
  reconfirmHostKey,
  removeEnvironment,
  statusFor,
  targetOf,
  verifyEnvironment,
  type EnvironmentDraft,
  type HostKeyInput,
} from "./index.ts";
import { FakeMachine, standardMachine } from "./testing/fake-ssh.ts";

const directories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eac-env-connect-"));
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
const KNOWN_HOSTS = "/var/lib/eacbot/known_hosts";

function draft(overrides: Partial<EnvironmentDraft> = {}): EnvironmentDraft {
  return {
    label: "my laptop",
    host: "laptop.example",
    user: "me",
    knownHostsFile: KNOWN_HOSTS,
    hostKeyFingerprint: FINGERPRINT,
    ...overrides,
  };
}

const knownHosts = () => knownHostsLine("laptop.example", HOST_KEY);

function machine() {
  return standardMachine({ tools: { claude: "/usr/local/bin/claude", pi: "/usr/local/bin/pi" }, versions: { claude: "2.1.7 (Claude Code)", pi: "1.4.2" } });
}

describe("adding a computer", () => {
  it("pins the host key, then reads the machine and its tools, then persists", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const result = await addEnvironment(store, draft(), {
      runner: machine().runner,
      readKnownHosts: knownHosts,
      now: () => "2026-03-03T00:00:00.000Z",
    });
    expect(result.status).toBe("online");
    expect(result.capabilities.os).toBe("Linux");
    expect(result.tools.map((tool) => tool.name)).toEqual(["hermes", "claude", "codex", "opencode", "pi", "omp"]);
    expect(store.require(result.record.id).status).toBe("online");
    expect(store.require(result.record.id).lastSeen).toBe("2026-03-03T00:00:00.000Z");
  });

  it("verifies the host key before it runs any command", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const spy = machine();
    await addEnvironment(store, draft(), {
      runner: spy.runner,
      readKnownHosts: () => knownHostsLine("laptop.example", key()),
    }).catch(() => undefined);
    expect(spy.calls).toHaveLength(0);
  });

  it("refuses a computer whose pinned fingerprint is not the key in the file", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const spy = machine();
    const error = await addEnvironment(store, draft({ hostKeyFingerprint: fingerprintOf(key()) }), {
      runner: spy.runner,
      readKnownHosts: knownHosts,
    }).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(FingerprintMismatchError);
    expect(spy.calls).toHaveLength(0);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.status).toBe("hostKeyChanged");
  });

  it("refuses a computer that presents a different key than the pin", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const error = await addEnvironment(store, draft(), {
      runner: machine().runner,
      readKnownHosts: knownHosts,
      presentedKey: async () => key(),
    }).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(HostKeyChangedError);
    expect(store.list()[0]!.status).toBe("hostKeyChanged");
  });

  it("reports the same failure as a status when a screen asks for one", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    const result = await checkEnvironment(store, record, {
      runner: machine().runner,
      readKnownHosts: () => knownHostsLine("laptop.example", key()),
    });
    expect(result.status).toBe("hostKeyChanged");
    expect(store.require(record.id).status).toBe("hostKeyChanged");
  });

  it("accepts a computer that presents the pinned key", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const result = await addEnvironment(store, draft(), {
      runner: machine().runner,
      readKnownHosts: knownHosts,
      presentedKey: async () => HOST_KEY,
    });
    expect(result.status).toBe("online");
  });

  it("marks a dropped connection as unreachable rather than online", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const spy = machine().dropConnectionWhen(["uname", "-s"]);
    const error = await addEnvironment(store, draft(), { runner: spy.runner, readKnownHosts: knownHosts }).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(SshDisconnectedError);
    expect(store.list()[0]!.status).toBe("unreachable");
  });

  it("marks a root login as a permission problem", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const result = await addEnvironment(store, draft({ user: "root" }), {
      runner: standardMachine({ user: "root" }).runner,
      readKnownHosts: knownHosts,
    });
    expect(result.status).toBe("permissionDenied");
  });

  it("is idempotent for a retried add of the same computer", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const options = { runner: machine().runner, readKnownHosts: knownHosts };
    const first = await addEnvironment(store, draft(), options);
    const second = await addEnvironment(store, draft(), options);
    expect(second.record.id).toBe(first.record.id);
    expect(store.list()).toHaveLength(1);
  });

  it("keeps a record from carrying the key path, only the reference", async () => {
    const dir = tempDir();
    const store = EnvironmentStore.open({ dataDir: dir });
    await addEnvironment(store, draft({ identityFileRef: "credential:laptop-key" }), {
      runner: machine().runner,
      readKnownHosts: knownHosts,
      identity: () => "/home/me/.ssh/id_ed25519",
    });
    const text = readFileSync(join(dir, "environments.json"), "utf8");
    expect(text).toContain("credential:laptop-key");
    expect(text).not.toContain("/home/me/.ssh/id_ed25519");
  });

  it("resolves a key path only for the call, never for the record", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft({ identityFileRef: "credential:laptop-key" }));
    const resolved = targetOf(record, () => "/home/me/.ssh/id_ed25519");
    expect(resolved.identityFile).toBe("/home/me/.ssh/id_ed25519");
    expect(record.identityFileRef).toBe("credential:laptop-key");
    expect(JSON.stringify(record)).not.toContain("id_ed25519");
  });

  it("passes no identity file to ssh when the record has no reference", () => {
    const record = { ...draft(), id: "e", status: "unknown" as const, lastSeen: null, capabilities: { os: null, arch: null, shell: null, homeDir: null, diskFreeBytes: null, nonRoot: null }, tools: [], createdAt: "", updatedAt: "", revision: 1 };
    expect(targetOf(record).identityFile).toBeNull();
  });
});

describe("re-checking a recorded computer", () => {
  it("updates the observed state without a revision from the caller", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    const result = await verifyEnvironment(store, record, { runner: machine().runner, readKnownHosts: knownHosts });
    expect(result.status).toBe("online");
    expect(result.record.revision).toBe(2);
  });

  it("answers a reachability question without changing the record", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    const spy = machine().answer(["true"], { code: 0 });
    expect(await ping(spy.runner, record)).toBe(true);
    expect(spy.lines()).toEqual([`'true'`]);
    expect(store.require(record.id).revision).toBe(1);
  });
});

describe("removing a computer", () => {
  it("needs an explicit confirmation", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    await expect(removeEnvironment(store, record, { confirm: false })).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(store.list()).toHaveLength(1);
  });

  it("removes the local record and leaves the computer alone", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    const spy = machine();
    const result = await removeEnvironment(store, record, { confirm: true });
    expect(result.removed.id).toBe(record.id);
    expect(spy.calls).toHaveLength(0);
    expect(store.list()).toEqual([]);
  });

  it("touches nothing remote, because there is no daemon to stop", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    const spy = machine();
    await removeEnvironment(store, record, { confirm: true });
    expect(spy.lines()).toEqual([]);
  });

  it("refuses a stale revision and keeps the record", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    await expect(removeEnvironment(store, record, { confirm: true, expectedRevision: 99 })).rejects.toMatchObject({
      kind: "revisionConflict",
    });
    expect(store.list()).toHaveLength(1);
  });

  it("reports an unknown id as unknown, not as success", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    await store.remove(record.id);
    await expect(removeEnvironment(store, record, { confirm: true })).rejects.toBeInstanceOf(UnknownEnvironmentError);
  });
});

describe("replacing a changed host key", () => {
  it("needs an explicit confirmation", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    await expect(
      reconfirmHostKey(store, record, { confirm: false, presented: key(), writeKnownHosts: () => {} }),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(store.require(record.id).hostKeyFingerprint).toBe(FINGERPRINT);
  });

  it("rewrites the pin only from the key the person confirmed", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    const replacement = key();
    const writes: { path: string; text: string }[] = [];
    const updated = await reconfirmHostKey(store, record, {
      confirm: true,
      presented: replacement,
      writeKnownHosts: (path, text) => writes.push({ path, text }),
    });
    expect(updated.hostKeyFingerprint).toBe(fingerprintOf(replacement));
    expect(updated.status).toBe("unknown");
    expect(writes[0]!.path).toBe(KNOWN_HOSTS);
    expect(writes[0]!.text).toContain(replacement.keyBlob);
  });

  it("then lets the computer connect again", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    const replacement = key();
    await reconfirmHostKey(store, record, { confirm: true, presented: replacement, writeKnownHosts: () => {} });
    const updated = store.require(record.id);
    const result = await verifyEnvironment(store, updated, {
      runner: machine().runner,
      readKnownHosts: () => knownHostsLine("laptop.example", replacement),
    });
    expect(result.status).toBe("online");
  });
});

describe("adding a computer the person has not connected to before", () => {
  function scanner(keys: readonly HostKeyInput[]): FakeMachine {
    return standardMachine().answerKeyscan("laptop.example", keys);
  }

  it("refuses with a confirmation request when no fingerprint was supplied", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const error = await addFirstEnvironment(
      store,
      { label: "laptop", host: "laptop.example", user: "me", knownHostsFile: KNOWN_HOSTS },
      { runner: scanner([HOST_KEY]).runner, writeKnownHosts: () => {} },
    ).catch((caught: unknown) => caught as HostKeyConfirmationRequiredError);
    expect(error).toBeInstanceOf(HostKeyConfirmationRequiredError);
    expect(error.scannedFingerprints).toEqual([FINGERPRINT]);
    expect(store.list()).toEqual([]);
  });

  it("pins the supplied fingerprint, writes the known-hosts line, then probes", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const writes: { path: string; text: string }[] = [];
    const result = await addFirstEnvironment(
      store,
      { label: "laptop", host: "laptop.example", user: "me", knownHostsFile: KNOWN_HOSTS, hostKeyFingerprint: FINGERPRINT },
      {
        runner: scanner([HOST_KEY]).runner,
        writeKnownHosts: (path, text) => writes.push({ path, text }),
        readKnownHosts: () => writes.at(-1)?.text ?? null,
        now: () => "2026-04-04T00:00:00.000Z",
      },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(KNOWN_HOSTS);
    expect(writes[0]!.text).toContain(HOST_KEY.keyBlob);
    expect(result.record.hostKeyFingerprint).toBe(FINGERPRINT);
    expect(result.status).toBe("online");
  });

  it("refuses a fingerprint the host does not present", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const writes: string[] = [];
    await expect(
      addFirstEnvironment(
        store,
        { label: "laptop", host: "laptop.example", user: "me", knownHostsFile: KNOWN_HOSTS, hostKeyFingerprint: fingerprintOf(key()) },
        { runner: scanner([HOST_KEY]).runner, writeKnownHosts: (_path, text) => writes.push(text) },
      ),
    ).rejects.toBeInstanceOf(FingerprintMismatchError);
    expect(writes).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it("pins a key the person confirmed from a scan", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const writes: string[] = [];
    const result = await addFirstEnvironment(
      store,
      { label: "laptop", host: "laptop.example", user: "me", knownHostsFile: KNOWN_HOSTS },
      {
        runner: scanner([HOST_KEY]).runner,
        confirmedKeys: [HOST_KEY],
        writeKnownHosts: (_path, text) => writes.push(text),
        readKnownHosts: () => writes.at(-1) ?? null,
      },
    );
    expect(result.record.hostKeyFingerprint).toBe(FINGERPRINT);
    expect(writes[0]).toContain(HOST_KEY.keyBlob);
  });

  it("pins nothing for a confirmed key the scan never saw", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    await expect(
      addFirstEnvironment(
        store,
        { label: "laptop", host: "laptop.example", user: "me", knownHostsFile: KNOWN_HOSTS },
        { runner: scanner([HOST_KEY]).runner, confirmedKeys: [key()], writeKnownHosts: () => {} },
      ),
    ).rejects.toBeInstanceOf(FingerprintMismatchError);
    expect(store.list()).toEqual([]);
  });
});

describe("failure statuses", () => {
  it("maps a disconnect and a command failure to unreachable", () => {
    expect(statusFor(new SshDisconnectedError("gone"))).toBe("unreachable");
    expect(statusFor(new SshFailureError("exited 1", 1))).toBe("unreachable");
  });

  it("maps a changed, missing or mismatched host key to hostKeyChanged", () => {
    expect(statusFor(new HostKeyChangedError("h", "SHA256:a", null))).toBe("hostKeyChanged");
    expect(statusFor(new HostKeyMissingError("h"))).toBe("hostKeyChanged");
    expect(statusFor(new FingerprintMismatchError("SHA256:a", "SHA256:b"))).toBe("hostKeyChanged");
  });

  it("maps a root login, low disk and a version mismatch to their own statuses", () => {
    expect(statusFor(new NotNonRootError("root"))).toBe("permissionDenied");
    expect(statusFor(new DiskLowError(1, 2))).toBe("diskLow");
    expect(statusFor(new VersionMismatchError("0.1.21", "0.1.9"))).toBe("needsUpdate");
  });

  it("maps anything it does not recognise to unknown rather than claiming a cause", () => {
    expect(statusFor(new Error("anything else"))).toBe("unknown");
    expect(statusFor({ kind: "hostKeyChanged" })).toBe("unknown");
  });

  it("records that status on the record so a screen can show it", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    const updated = await store.update(record.id, record.revision, { status: statusFor(new DiskLowError(1, 2)) });
    expect(store.require(updated.id).status).toBe("diskLow");
  });
});
