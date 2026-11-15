import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  FingerprintMismatchError,
  HostKeyConfirmationRequiredError,
  SshDisconnectedError,
  firstContact,
  fingerprintOf,
  keyscanPlan,
  parseKeyscan,
  type HostKeyInput,
  type HostIdentity,
} from "./index.ts";
import { FakeMachine } from "./testing/fake-ssh.ts";

const IDENTITY: HostIdentity = { host: "laptop.example", port: 22, user: "me" };

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

/** A fake whose only answer is a keyscan. */
function scanner(keys: readonly HostKeyInput[]): FakeMachine {
  return new FakeMachine().answerKeyscan(IDENTITY.host, keys);
}

function writer() {
  const writes: { path: string; text: string }[] = [];
  return { writes, writeKnownHosts: (path: string, text: string) => writes.push({ path, text }) };
}

describe("the keyscan argv", () => {
  it("asks for the three key types and names the host last", () => {
    expect(keyscanPlan({ host: "laptop.example", port: 22 })).toEqual([
      "-T",
      "10",
      "-t",
      "ed25519,ecdsa,rsa",
      "laptop.example",
    ]);
  });

  it("passes a non-default port as its own argument", () => {
    const args = keyscanPlan({ host: "laptop.example", port: 2222 });
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });

  it("refuses a host that would read as an option", () => {
    expect(() => keyscanPlan({ host: "-oProxyCommand=sh", port: 22 })).toThrow();
    expect(() => keyscanPlan({ host: "me@host", port: 22 })).toThrow();
  });

  it("refuses an out-of-range timeout", () => {
    expect(() => keyscanPlan({ host: "h", port: 22 }, 0)).toThrow();
    expect(() => keyscanPlan({ host: "h", port: 22 }, 61)).toThrow();
  });

  it("parses a scan into keys and ignores its comment lines", () => {
    const found = key();
    const text = `# laptop.example:22 SSH-2.0-OpenSSH\n${IDENTITY.host} ${found.keyType} ${found.keyBlob}\n`;
    const keys = parseKeyscan(text);
    expect(keys).toHaveLength(1);
    expect(fingerprintOf(keys[0]!)).toBe(fingerprintOf(found));
  });
});

describe("a first connection with no fingerprint", () => {
  it("refuses and carries what the scan saw, so a screen can ask", async () => {
    const found = key();
    const error = await firstContact(IDENTITY, {
      runner: scanner([found]).runner,
      knownHostsFile: "/var/lib/eacbot/known_hosts",
      writeKnownHosts: () => {},
    }).catch((caught: unknown) => caught as HostKeyConfirmationRequiredError);
    expect(error).toBeInstanceOf(HostKeyConfirmationRequiredError);
    expect(error.scannedFingerprints).toEqual([fingerprintOf(found)]);
  });

  it("does not pin anything when it refuses", async () => {
    const sink = writer();
    await firstContact(IDENTITY, {
      runner: scanner([key()]).runner,
      knownHostsFile: "/k",
      writeKnownHosts: sink.writeKnownHosts,
    }).catch(() => undefined);
    expect(sink.writes).toHaveLength(0);
  });

  it("refuses when the scan found nothing", async () => {
    const error = await firstContact(IDENTITY, {
      runner: scanner([]).runner,
      knownHostsFile: "/k",
      writeKnownHosts: () => {},
    }).catch((caught: unknown) => caught as HostKeyConfirmationRequiredError);
    expect(error).toBeInstanceOf(HostKeyConfirmationRequiredError);
    expect(error.scannedFingerprints).toEqual([]);
  });
});

describe("a first connection with a fingerprint the person supplied", () => {
  it("pins the key the scan offered when it matches", async () => {
    const found = key();
    const sink = writer();
    const result = await firstContact(IDENTITY, {
      runner: scanner([found]).runner,
      fingerprint: fingerprintOf(found),
      knownHostsFile: "/var/lib/eacbot/known_hosts",
      writeKnownHosts: sink.writeKnownHosts,
    });
    expect(result.fingerprint).toBe(fingerprintOf(found));
    expect(sink.writes).toHaveLength(1);
    expect(sink.writes[0]!.path).toBe("/var/lib/eacbot/known_hosts");
    expect(sink.writes[0]!.text).toContain(found.keyBlob);
  });

  it("refuses when the scan offered a different key", async () => {
    const wanted = key();
    const other = key();
    const sink = writer();
    await expect(
      firstContact(IDENTITY, {
        runner: scanner([other]).runner,
        fingerprint: fingerprintOf(wanted),
        knownHostsFile: "/k",
        writeKnownHosts: sink.writeKnownHosts,
      }),
    ).rejects.toBeInstanceOf(FingerprintMismatchError);
    expect(sink.writes).toHaveLength(0);
  });

  it("pins a confirmed key without needing a scan", async () => {
    const found = key();
    const sink = writer();
    const machine = new FakeMachine();
    const result = await firstContact(IDENTITY, {
      runner: machine.runner,
      fingerprint: fingerprintOf(found),
      confirmedKeys: [found],
      knownHostsFile: "/k",
      writeKnownHosts: sink.writeKnownHosts,
    });
    expect(result.key).toEqual(found);
    expect(machine.calls).toHaveLength(0);
    expect(sink.writes).toHaveLength(1);
  });

  it("refuses a confirmed key that is not the fingerprint given", async () => {
    await expect(
      firstContact(IDENTITY, {
        runner: new FakeMachine().runner,
        fingerprint: fingerprintOf(key()),
        confirmedKeys: [key()],
        knownHostsFile: "/k",
        writeKnownHosts: () => {},
      }),
    ).rejects.toBeInstanceOf(FingerprintMismatchError);
  });

  it("refuses a malformed fingerprint instead of treating it as a key", async () => {
    await expect(
      firstContact(IDENTITY, {
        runner: scanner([key()]).runner,
        fingerprint: "not-a-fingerprint",
        knownHostsFile: "/k",
        writeKnownHosts: () => {},
      }),
    ).rejects.toMatchObject({ kind: "invalidRecord" });
  });

  it("refuses when the scan cannot reach the host at all", async () => {
    const machine = new FakeMachine();
    machine.dropConnectionWhen(["ssh-keyscan"]);
    await expect(
      firstContact(IDENTITY, {
        runner: machine.runner,
        fingerprint: fingerprintOf(key()),
        knownHostsFile: "/k",
        writeKnownHosts: () => {},
      }),
    ).rejects.toBeInstanceOf(SshDisconnectedError);
  });
});

describe("a person confirming what a scan showed", () => {
  it("pins a confirmed key only when the scan also saw it", async () => {
    const found = key();
    const sink = writer();
    const result = await firstContact(IDENTITY, {
      runner: scanner([found]).runner,
      confirmedKeys: [found],
      knownHostsFile: "/k",
      writeKnownHosts: sink.writeKnownHosts,
    });
    expect(result.fingerprint).toBe(fingerprintOf(found));
    expect(sink.writes).toHaveLength(1);
  });

  it("refuses a confirmed key the scan never saw", async () => {
    const sink = writer();
    await expect(
      firstContact(IDENTITY, {
        runner: scanner([key()]).runner,
        confirmedKeys: [key()],
        knownHostsFile: "/k",
        writeKnownHosts: sink.writeKnownHosts,
      }),
    ).rejects.toBeInstanceOf(FingerprintMismatchError);
    expect(sink.writes).toHaveLength(0);
  });

  it("keeps an existing known-hosts entry and appends the new one", async () => {
    const found = key();
    const sink = writer();
    await firstContact(IDENTITY, {
      runner: scanner([found]).runner,
      fingerprint: fingerprintOf(found),
      knownHostsFile: "/k",
      readKnownHosts: () => "other.example ssh-ed25519 AAAA\n",
      writeKnownHosts: sink.writeKnownHosts,
    });
    expect(sink.writes[0]!.text).toContain("other.example ssh-ed25519 AAAA");
    expect(sink.writes[0]!.text).toContain(found.keyBlob);
  });

  it("does not duplicate a line already pinned", async () => {
    const found = key();
    const sink = writer();
    const existing = `${IDENTITY.host} ${found.keyType} ${found.keyBlob}\n`;
    await firstContact(IDENTITY, {
      runner: scanner([found]).runner,
      fingerprint: fingerprintOf(found),
      knownHostsFile: "/k",
      readKnownHosts: () => existing,
      writeKnownHosts: sink.writeKnownHosts,
    });
    expect(sink.writes).toHaveLength(0);
  });

  it("refuses to pin without somewhere to write the file", async () => {
    const found = key();
    await expect(
      firstContact(IDENTITY, {
        runner: scanner([found]).runner,
        fingerprint: fingerprintOf(found),
        knownHostsFile: "/k",
      }),
    ).rejects.toMatchObject({ kind: "confirmationRequired" });
  });

  it("refuses an identity with no host or a bad port", async () => {
    await expect(
      firstContact({ host: "", port: 22, user: "me" }, { runner: new FakeMachine().runner, knownHostsFile: "/k", writeKnownHosts: () => {} }),
    ).rejects.toMatchObject({ kind: "invalidRecord" });
    await expect(
      firstContact({ host: "h", port: 0, user: "me" }, { runner: new FakeMachine().runner, knownHostsFile: "/k", writeKnownHosts: () => {} }),
    ).rejects.toMatchObject({ kind: "invalidRecord" });
  });

  it("runs the scan as an argv, never as a shell string", async () => {
    const machine = scanner([key()]);
    await firstContact(IDENTITY, { runner: machine.runner, knownHostsFile: "/k", writeKnownHosts: () => {} }).catch(
      () => undefined,
    );
    const plan = machine.calls[0]!.plan;
    expect(plan.command).toBe("ssh-keyscan");
    expect(plan.args).toEqual(["-T", "10", "-t", "ed25519,ecdsa,rsa", "laptop.example"]);
    expect(plan.args).not.toContain("sh");
    expect(plan.args).not.toContain("-c");
  });
});
