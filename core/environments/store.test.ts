import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EnvironmentStore,
  EnvironmentStoreCorruptError,
  EnvironmentRevisionConflictError,
  SecretInEnvironmentError,
  UnknownEnvironmentError,
  migrate,
} from "./index.ts";
import type { EnvironmentDraft } from "./types.ts";

const directories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eac-environments-"));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FINGERPRINT = `SHA256:${"a".repeat(43)}`;

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

describe("the environment store", () => {
  it("persists a record and reads it back from a fresh store", async () => {
    const dir = tempDir();
    const store = EnvironmentStore.open({ dataDir: dir });
    const added = await store.add(draft(), { now: "2026-01-01T00:00:00.000Z" });

    const reopened = EnvironmentStore.open({ dataDir: dir });
    const read = reopened.require(added.id);
    expect(read.host).toBe("laptop.example");
    expect(read.port).toBe(22);
    expect(read.status).toBe("unknown");
    expect(read.lastSeen).toBeNull();
    expect(read.revision).toBe(1);
  });

  it("creates the file with owner-only permissions", async () => {
    const dir = tempDir();
    const store = EnvironmentStore.open({ dataDir: dir });
    await store.add(draft());
    const file = statSync(store.filePath);
    if (process.platform !== "win32") {
      expect(file.mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(file.isFile()).toBe(true);
  });

  it("writes through a temporary file and leaves no temporary behind", async () => {
    const dir = tempDir();
    const store = EnvironmentStore.open({ dataDir: dir });
    for (let at = 0; at < 5; at += 1) {
      await store.add(draft({ label: `laptop ${at}`, host: `laptop-${at}.example` }));
    }
    const names = readdirSync(dir);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(store.filePath, "utf8")).environments).toHaveLength(5);
  });

  it("refuses a record carrying a secret field name, at any depth", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    await expect(store.add(draft({ label: "x", ...( { password: "hunter2" } as object) }))).rejects.toBeInstanceOf(
      SecretInEnvironmentError,
    );
    await expect(
      store.add({ ...draft(), ...({ nested: { pairingSecret: "abc" } } as object) } as EnvironmentDraft),
    ).rejects.toBeInstanceOf(SecretInEnvironmentError);
    expect(store.list()).toHaveLength(0);
  });

  it("never echoes a secret's value in the error", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const error = await store.add({ ...draft(), ...({ privateKey: "BEGIN OPENSSH PRIVATE KEY" } as object) }).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toContain("privateKey");
    expect(error.message).not.toContain("BEGIN OPENSSH");
  });

  it("is idempotent: adding the same computer twice returns the first record", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const first = await store.add(draft());
    const second = await store.add(draft());
    expect(second.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
  });

  it("adds a second record for the same target only when asked", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const first = await store.add(draft());
    const second = await store.add(draft({ label: "same computer, other name" }), { allowDuplicateTarget: true });
    expect(second.id).not.toBe(first.id);
    expect(store.list()).toHaveLength(2);
  });

  it("honours a caller's id so a retried add converges", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const first = await store.add(draft(), { id: "env-fixed" });
    const second = await store.add(draft(), { id: "env-fixed" });
    expect(first.id).toBe("env-fixed");
    expect(second.id).toBe("env-fixed");
    expect(store.list()).toHaveLength(1);
  });

  it("keeps every record when two stores in one directory add concurrently", async () => {
    const dir = tempDir();
    const one = EnvironmentStore.open({ dataDir: dir });
    const two = EnvironmentStore.open({ dataDir: dir });
    await Promise.all([
      one.add(draft({ host: "a.example" })),
      two.add(draft({ host: "b.example" })),
      one.add(draft({ host: "c.example" })),
      two.add(draft({ host: "d.example" })),
    ]);
    const reopened = EnvironmentStore.open({ dataDir: dir });
    expect(reopened.list().map((record) => record.host).sort()).toEqual(["a.example", "b.example", "c.example", "d.example"]);
  });

  it("serialises concurrent updates to one record without losing a write", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    await Promise.all(
      Array.from({ length: 6 }, (_, index) => store.update(record.id, 1 + index, { label: `label ${index}` })),
    );
    const read = EnvironmentStore.open({ dataDir: store.dataDir }).require(record.id);
    expect(read.revision).toBe(7);
    expect(read.label).toBe("label 5");
  });

  it("refuses an update at a stale revision", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    await store.update(record.id, 1, { label: "renamed" });
    await expect(store.update(record.id, 1, { label: "again" })).rejects.toBeInstanceOf(EnvironmentRevisionConflictError);
  });

  it("records a probe without requiring a revision, and does not resurrect a removed record", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    const probed = await store.recordProbe(record.id, {
      status: "online",
      capabilities: { os: "Linux", arch: "x86_64", shell: "/bin/bash", homeDir: "/home/me", diskFreeBytes: 1, nonRoot: true },
      tools: [],
      lastSeen: "2026-02-02T00:00:00.000Z",
    });
    expect(probed.status).toBe("online");
    expect(probed.revision).toBe(2);

    await store.remove(record.id);
    await expect(
      store.recordProbe(record.id, { status: "online", capabilities: probed.capabilities, tools: [], lastSeen: null }),
    ).rejects.toBeInstanceOf(UnknownEnvironmentError);
  });

  it("removes only the local record and leaves no secret behind", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    const removed = await store.remove(record.id);
    expect(removed.id).toBe(record.id);
    expect(store.list()).toEqual([]);
    expect(readFileSync(store.filePath, "utf8")).not.toContain(FINGERPRINT.slice(0, 12));
  });

  it("reports a corrupt file rather than starting empty", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "environments.json"), "{ not json");
    expect(() => EnvironmentStore.open({ dataDir: dir })).toThrow(EnvironmentStoreCorruptError);
  });

  it("reads a bare array written by an earlier build and fills missing fields", () => {
    const records = migrate([
      {
        id: "legacy-1",
        label: "old laptop",
        host: "old.example",
        user: "me",
        knownHostsFile: "/var/lib/eacbot/known_hosts",
        hostKeyFingerprint: FINGERPRINT,
      },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]!.port).toBe(22);
    expect(records[0]!.status).toBe("unknown");
    expect(records[0]!.tools).toEqual([]);
    expect(records[0]!.capabilities.nonRoot).toBeNull();
  });

  it("reads the document shape and keeps unknown-to-then fields at their defaults", () => {
    const records = migrate({ version: 1, environments: [{ id: "e", label: "l", host: "h", user: "u", knownHostsFile: "/k", hostKeyFingerprint: FINGERPRINT, status: "online" }] });
    expect(records[0]!.status).toBe("online");
    expect(records[0]!.identityFileRef).toBeNull();
  });

  it("refuses a legacy record that carries a secret", () => {
    expect(() =>
      migrate([
        { id: "e", label: "l", host: "h", user: "u", knownHostsFile: "/k", hostKeyFingerprint: FINGERPRINT, password: "x" },
      ]),
    ).toThrow(SecretInEnvironmentError);
  });

  it("refuses an entry it cannot recognise rather than dropping it", () => {
    expect(() => migrate({ version: 1, environments: ["not a record"] })).toThrow(EnvironmentStoreCorruptError);
    expect(() => migrate("nonsense")).toThrow(EnvironmentStoreCorruptError);
  });

  it("keeps a record's arrays out of a caller's hands", async () => {
    const store = EnvironmentStore.open({ dataDir: tempDir() });
    const record = await store.add(draft());
    const snapshot = store.require(record.id);
    (snapshot.tools as unknown[]).push({ name: "hermes" });
    (snapshot.capabilities as { os: string | null }).os = "tampered";
    expect(store.require(record.id).tools).toEqual([]);
    expect(store.require(record.id).capabilities.os).toBeNull();
  });
});
