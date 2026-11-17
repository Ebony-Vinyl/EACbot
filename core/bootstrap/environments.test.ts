import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EnvironmentStore } from "../environments/store.ts";
import { fingerprintOf, knownHostsLine } from "../environments/hostkey.ts";
import {
  DuplicateEnvironmentError,
  FingerprintMismatchError,
  HostKeyConfirmationRequiredError,
  UnknownEnvironmentError,
} from "../environments/errors.ts";
import type { HostKeyInput } from "../environments/types.ts";
import { FakeMachine, standardMachine } from "../environments/testing/fake-ssh.ts";
import { EnvironmentStorePort } from "./environments.ts";

const directories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eac-env-port-"));
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
const OTHER_KEY = key();
const FINGERPRINT = fingerprintOf(HOST_KEY);
const HOST = "laptop.example";

/** A machine whose keyscan offers `keys`, so a first contact has something to
 * compare a supplied fingerprint against. */
function machine(keys: readonly HostKeyInput[] = [HOST_KEY]): FakeMachine {
  return standardMachine({ tools: { claude: "/usr/local/bin/claude" }, versions: { claude: "2.1.7 (Claude Code)" } }).answerKeyscan(
    HOST,
    keys,
  );
}

function port(overrides: { store?: EnvironmentStore; runner?: ReturnType<typeof machine>["runner"]; id?: () => string } = {}) {
  const dataDir = tempDir();
  const store = overrides.store ?? EnvironmentStore.open({ dataDir });
  return {
    dataDir,
    store,
    port: new EnvironmentStorePort({
      store,
      runner: overrides.runner ?? machine().runner,
      now: () => "2026-04-04T00:00:00.000Z",
      ...(overrides.id !== undefined ? { id: overrides.id } : {}),
    }),
  };
}

const input = (overrides: Partial<Parameters<EnvironmentStorePort["create"]>[0]> = {}) => ({
  label: "my laptop",
  host: HOST,
  user: "me",
  hostKeyFingerprint: FINGERPRINT,
  ...overrides,
});

describe("EnvironmentStorePort.create", () => {
  it("pins the fingerprint under known-hosts/<id>, probes, then persists online", async () => {
    const { dataDir, store, port: environments } = port({ id: () => "env-fixed" });
    const created = await environments.create(input());

    expect(created.id).toBe("env-fixed");
    expect(created.status).toBe("online");
    expect(created.hostKeyFingerprint).toBe(FINGERPRINT);
    expect(created.lastSeen).toBe("2026-04-04T00:00:00.000Z");
    expect(created).not.toHaveProperty("knownHostsFile");
    expect(created).not.toHaveProperty("identityFileRef");

    const pinFile = join(dataDir, "known-hosts", "env-fixed");
    expect(existsSync(pinFile)).toBe(true);
    expect(readFileSync(pinFile, "utf8").trim()).toBe(knownHostsLine(HOST, HOST_KEY));
    expect(store.require("env-fixed").tools.some((tool) => tool.name === "claude" && tool.status === "installed")).toBe(true);
  });

  it("reports the machine's tools through the persisted record, not just the answer", async () => {
    const { store, port: environments } = port();
    const created = await environments.create(input());
    const record = store.require(created.id);
    expect(record.tools.map((tool) => tool.name)).toContain("claude");
    expect(record.capabilities.os).toBe("Linux");
  });

  it("refuses a host key that does not match the fingerprint, and never claims connected", async () => {
    const { dataDir, store, port: environments } = port();
    await expect(environments.create(input({ hostKeyFingerprint: fingerprintOf(OTHER_KEY) }))).rejects.toBeInstanceOf(
      FingerprintMismatchError,
    );
    expect(store.list()).toHaveLength(0);
    expect(existsSync(join(dataDir, "known-hosts")) ? readdirSync(join(dataDir, "known-hosts")) : []).toEqual([]);
  });

  it("refuses an add with no fingerprint and carries what the scan saw", async () => {
    const { store, port: environments } = port();
    const error = await environments
      .create(input({ hostKeyFingerprint: "" }))
      .catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(HostKeyConfirmationRequiredError);
    expect((error as HostKeyConfirmationRequiredError).scannedFingerprints).toEqual([FINGERPRINT]);
    expect(store.list()).toHaveLength(0);
  });

  it("leaves a record whose probe failed with the status that failure earned, not online", async () => {
    const { store, port: environments } = port({ runner: machine().dropConnectionWhen(["uname", "-s"]).runner });
    const created = await environments.create(input()).catch(() => undefined);
    expect(created).toBeUndefined();
    const records = store.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("unreachable");
    expect(records[0]!.hostKeyFingerprint).toBe(FINGERPRINT);
  });

  it("takes connection facts only, so a secret has no field to arrive in", async () => {
    const { port: environments } = port();
    const created = await environments.create(input());
    const wire = JSON.stringify(created);
    expect(wire).not.toMatch(/privateKey|passphrase|password/u);
    expect(created).not.toHaveProperty("credentialRef");
  });

  it("removes the pin file it wrote when the add is refused", async () => {
    const { dataDir, port: environments } = port();
    await environments.create(input({ hostKeyFingerprint: fingerprintOf(OTHER_KEY) })).catch(() => undefined);
    expect(existsSync(join(dataDir, "known-hosts")) ? readdirSync(join(dataDir, "known-hosts")) : []).toEqual([]);
  });

  it("leaves no lock or temporary file behind, whether the add succeeded or not", async () => {
    const { dataDir, port: environments } = port();
    await environments.create(input());
    await environments.create(input({ host: "other.example" })).catch(() => undefined);
    const files = readdirSync(dataDir).filter((name) => name !== "known-hosts");
    expect(files).toEqual(["environments.json"]);
  });

  it("refuses a second record for the same computer and keeps the first", async () => {
    const { dataDir, store, port: environments } = port();
    const first = await environments.create(input());
    await expect(environments.create(input())).rejects.toBeInstanceOf(DuplicateEnvironmentError);
    expect(store.list()).toHaveLength(1);
    expect(store.require(first.id).status).toBe("online");
    expect(readdirSync(join(dataDir, "known-hosts"))).toEqual([first.id]);
  });
});

describe("EnvironmentStorePort.list and get", () => {
  it("maps a persisted record onto the wire shape without a credential or a data path", async () => {
    const { port: environments } = port();
    const created = await environments.create(input());
    const listed = environments.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.id,
      label: "my laptop",
      host: HOST,
      port: 22,
      user: "me",
      hostKeyFingerprint: FINGERPRINT,
      status: "online",
    });
    expect(JSON.stringify(listed)).not.toContain("known-hosts");
    expect(environments.get(created.id)?.id).toBe(created.id);
    expect(environments.get("nope")).toBeUndefined();
  });

  it("lists what a previous process wrote", async () => {
    const dataDir = tempDir();
    const first = EnvironmentStore.open({ dataDir });
    await new EnvironmentStorePort({ store: first, runner: machine().runner }).create(input());
    const reopened = EnvironmentStore.open({ dataDir });
    const listed = new EnvironmentStorePort({ store: reopened, runner: machine().runner }).list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.host).toBe(HOST);
  });
});

describe("EnvironmentStorePort.check", () => {
  it("reports reachable with a detail when the pin matches and the machine answers", async () => {
    const { port: environments } = port();
    const created = await environments.create(input());
    const test = await environments.check(created.id);
    expect(test.reachable).toBe(true);
    expect(test.checkedAt).toBe("2026-04-04T00:00:00.000Z");
    expect(test.detail).toMatch(/Linux/u);
    expect(environments.lastTest(created.id)?.reachable).toBe(true);
  });

  it("reports unreachable with the failure's detail when the connection drops", async () => {
    const dataDir = tempDir();
    const store = EnvironmentStore.open({ dataDir });
    const created = await new EnvironmentStorePort({ store, runner: machine().runner }).create(input());
    const dropping = new EnvironmentStorePort({ store, runner: machine().dropConnectionWhen(["uname", "-s"]).runner });
    const test = await dropping.check(created.id);
    expect(test.reachable).toBe(false);
    expect(test.detail).toBeTruthy();
  });

  it("refuses a check of a computer it does not have", async () => {
    const { port: environments } = port();
    await expect(environments.check("nope")).rejects.toBeInstanceOf(UnknownEnvironmentError);
  });

  it("reports a changed pin as unreachable rather than connecting", async () => {
    const { dataDir, store, port: environments } = port();
    const created = await environments.create(input());
    writeFileSync(join(dataDir, "known-hosts", created.id), `${knownHostsLine(HOST, OTHER_KEY)}\n`);
    const test = await environments.check(created.id);
    expect(test.reachable).toBe(false);
    expect(test.detail).toMatch(/known-hosts/u);
    expect(store.require(created.id).status).toBe("hostKeyChanged");
  });
});

describe("EnvironmentStorePort across a restart", () => {
  it("reads the record back as unknown, with no test this process did not run", async () => {
    const dataDir = tempDir();
    const firstStore = EnvironmentStore.open({ dataDir });
    const first = new EnvironmentStorePort({ store: firstStore, runner: machine().runner });
    const created = await first.create(input());
    expect(first.lastTest(created.id)?.reachable).toBe(true);
    expect(first.get(created.id)?.status).toBe("online");

    const secondStore = EnvironmentStore.open({ dataDir });
    const second = new EnvironmentStorePort({
      store: secondStore,
      runner: machine().runner,
      now: () => "2026-05-05T00:00:00.000Z",
    });
    expect(second.list()).toHaveLength(1);
    expect(second.lastTest(created.id)).toBeUndefined();
    expect(second.get(created.id)?.status).toBe("unknown");
    expect(second.get(created.id)?.lastSeen).toBe(created.lastSeen);
    expect(secondStore.require(created.id).status).toBe("online");
  });

  it("reports unknown until a check in this process observes something", async () => {
    const dataDir = tempDir();
    await new EnvironmentStorePort({ store: EnvironmentStore.open({ dataDir }), runner: machine().runner }).create(input());
    const second = new EnvironmentStorePort({
      store: EnvironmentStore.open({ dataDir }),
      runner: machine().dropConnectionWhen(["uname", "-s"]).runner,
    });
    const [listed] = second.list();
    expect(listed?.status).toBe("unknown");
    expect(second.lastTest(listed!.id)).toBeUndefined();
    expect((await second.check(listed!.id)).reachable).toBe(false);
    expect(second.get(listed!.id)?.status).toBe("unreachable");
  });
});

describe("EnvironmentStorePort.remove", () => {
  it("drops the local record and the local pin file, and touches nothing remote", async () => {
    const { dataDir, store, port: environments } = port();
    const runner = machine();
    const created = await environments.create(input());
    const callsBefore = runner.calls.length;
    await environments.remove(created.id);
    expect(store.list()).toHaveLength(0);
    expect(existsSync(join(dataDir, "known-hosts", created.id))).toBe(false);
    expect(runner.calls).toHaveLength(callsBefore);
  });

  it("refuses to remove a computer it does not have", async () => {
    const { port: environments } = port();
    await expect(environments.remove("nope")).rejects.toBeInstanceOf(UnknownEnvironmentError);
  });
});
