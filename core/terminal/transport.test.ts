import { describe, expect, it } from "vitest";

import { HcClient } from "./client.ts";
import { HcConnection } from "./connection.ts";
import { TransportError } from "./protocol.ts";
import { FakeHc } from "./testing/fake-hc.ts";
import {
  HC_PROGRAM,
  assertHost,
  assertSecureSshArgs,
  defaultSpawner,
  describeSpawnPlan,
  localConnectPlan,
  parseSshTarget,
  remoteConnectLine,
  sshConfigFromTarget,
  sshConnectDescriptor,
  sshConnectPlan,
  type SshConnectConfig,
} from "./transport.ts";
import { FrameKind, INITIAL_STREAM_CREDIT } from "./wire.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

const KNOWN_HOSTS = "/var/lib/eacbot/known_hosts";
const IDENTITY = "/var/lib/eacbot/keys/rohan_ed25519";
const FINGERPRINT = `SHA256:${"a".repeat(43)}`;

const REMOTE: SshConnectConfig = { host: "rohan", user: "me", knownHostsFile: KNOWN_HOSTS };

/** The `-o value` pairs in an ssh argv, in order. */
function sshOptions(args: readonly string[]): string[] {
  const options: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    if (args[at] === "-o") options.push(args[at + 1] ?? "");
  }
  return options;
}

/** What a single-letter flag was given, or null. */
function sshFlag(args: readonly string[], flag: string): string | null {
  const at = args.indexOf(flag);
  return at === -1 ? null : (args[at + 1] ?? null);
}

/**
 * A stand-in for the real binary: it speaks plain JSON-RPC over stdin/stdout,
 * which is what `hc connect` does. Nothing here reaches the user's machine.
 */
const FAKE_HC_SOURCE = `
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "hello") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: message.id,
      result: {
        generation: 1, version: "0.1.21",
        core: { id: "fake", name: "fixture" },
        framed: false, methods: ["hello"], features: ["framed"],
      },
    }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id: message.id,
    result: { terminals: [], hidden_finished: 0, machines: [] },
  }) + "\\n");
});
`;

describe("spawn plans", () => {
  it("names the installed binary, with no shell in the argv", () => {
    expect(HC_PROGRAM).toBe("herdr-core");
    expect(localConnectPlan().args).toEqual(["connect"]);
    expect(localConnectPlan().command).toBe("herdr-core");
    // No local shell: a missing binary is an error, not a shell's message.
    for (const plan of [localConnectPlan(), sshConnectPlan(REMOTE)]) {
      expect(plan.command).not.toMatch(/^(sh|bash|cmd|powershell)/i);
      expect(plan.args[0]).not.toBe("-c");
    }
  });

  it("quotes a remote session so it cannot break out of the line", () => {
    const line = remoteConnectLine("herdr-core", "work; rm -rf /");
    expect(line).toContain(`HC_SESSION='work; rm -rf /'`);
    expect(line).not.toContain("; rm -rf / ");
  });

  it("does not describe a local plan as remote", () => {
    expect(localConnectPlan().connect).toBeUndefined();
  });
});

describe("the remote ssh path", () => {
  it("verifies the host key, never prompts, and checks a dedicated file", () => {
    const options = sshOptions(sshConnectPlan(REMOTE).args);
    expect(options).toContain("StrictHostKeyChecking=yes");
    expect(options).toContain(`UserKnownHostsFile=${KNOWN_HOSTS}`);
    expect(options).toContain("BatchMode=yes");
    expect(options).toContain("ConnectTimeout=10");
    expect(options).toContain("ServerAliveInterval=15");
    expect(options).toContain("ServerAliveCountMax=4");
    expect(options.join(" ")).not.toMatch(/StrictHostKeyChecking=no|accept-new/i);
  });

  it("passes the destination as one argument, after every option", () => {
    const plan = sshConnectPlan(REMOTE);
    expect(plan.args[0]).toBe("-T");
    expect(plan.args.at(-2)).toBe("rohan");
    expect(plan.args.at(-1)).toContain('exec "$p" connect');
    // Nothing before the destination names the host, so it cannot be an option's value.
    for (const arg of plan.args.slice(0, plan.args.length - 2)) expect(arg).not.toBe("rohan");
  });

  it("carries port, user and identity file as their own flags", () => {
    const plan = sshConnectPlan({ ...REMOTE, port: 2222, identityFile: IDENTITY });
    expect(sshFlag(plan.args, "-p")).toBe("2222");
    expect(sshFlag(plan.args, "-l")).toBe("me");
    expect(sshFlag(plan.args, "-i")).toBe(IDENTITY);
    expect(sshOptions(plan.args)).toContain("IdentitiesOnly=yes");
  });

  it("turns IdentitiesOnly on only when a key is provisioned", () => {
    expect(sshOptions(sshConnectPlan(REMOTE).args)).not.toContain("IdentitiesOnly=yes");
    expect(sshOptions(sshConnectPlan({ ...REMOTE, identityFile: IDENTITY }).args)).toContain("IdentitiesOnly=yes");
    expect(
      sshOptions(sshConnectPlan({ ...REMOTE, identityFile: IDENTITY, identitiesOnly: false }).args),
    ).not.toContain("IdentitiesOnly=yes");
  });

  it("files the host key under its alias when one is given", () => {
    const plan = sshConnectPlan({ ...REMOTE, hostKeyAlias: "rohan-prod" });
    expect(sshOptions(plan.args)).toContain("HostKeyAlias=rohan-prod");
    expect(plan.connect?.hostKeyAlias).toBe("rohan-prod");
  });

  it("describes the connection for the environment layer, with no key material", () => {
    const plan = sshConnectPlan({ ...REMOTE, port: 2222, identityFile: IDENTITY, hostKeyFingerprint: FINGERPRINT });
    expect(plan.connect).toEqual({
      kind: "ssh",
      host: "rohan",
      user: "me",
      port: 2222,
      knownHostsFile: KNOWN_HOSTS,
      hostKeyFingerprint: FINGERPRINT,
      hostKeyAlias: null,
      usesIdentityFile: true,
      identitiesOnly: true,
      batchMode: true,
      strictHostKeyChecking: "yes",
    });
    const serialized = JSON.stringify(plan.connect);
    expect(serialized).not.toContain(IDENTITY);
    expect(serialized).not.toContain("PRIVATE KEY");
  });

  it("parses a target into host, user and port", () => {
    expect(parseSshTarget("rohan")).toEqual({ host: "rohan", user: null, port: null });
    expect(parseSshTarget("me@rohan")).toEqual({ host: "rohan", user: "me", port: null });
    expect(parseSshTarget("me@rohan:2222")).toEqual({ host: "rohan", user: "me", port: 2222 });
    expect(parseSshTarget("ssh://me@rohan:2222")).toEqual({ host: "rohan", user: "me", port: 2222 });
    expect(parseSshTarget("[2001:db8::1]:2222")).toEqual({ host: "2001:db8::1", user: null, port: 2222 });
    expect(parseSshTarget("[2001:db8::1]")).toEqual({ host: "2001:db8::1", user: null, port: null });
    expect(() => parseSshTarget("rohan:ssh")).toThrow(TransportError);
    expect(() => parseSshTarget("")).toThrow(TransportError);
  });

  it("builds a config from a target and the settings a target cannot carry", () => {
    const config = sshConfigFromTarget("me@rohan:2222", { knownHostsFile: KNOWN_HOSTS, identityFile: IDENTITY });
    expect(config).toEqual({
      host: "rohan",
      user: "me",
      port: 2222,
      knownHostsFile: KNOWN_HOSTS,
      identityFile: IDENTITY,
    });
    expect(sshFlag(sshConnectPlan(config).args, "-p")).toBe("2222");
  });
});

describe("refusing unsafe ssh settings", () => {
  it("offers no field that could turn host key checking off", () => {
    const asRecord = REMOTE as unknown as Record<string, unknown>;
    expect("strictHostKeyChecking" in asRecord).toBe(false);
    expect("knownHosts" in asRecord).toBe(false);
    expect("options" in asRecord).toBe(false);
    expect("proxyCommand" in asRecord).toBe(false);
  });

  it("rejects a host that is an option, two words, a user@host or a port", () => {
    const hosts = ["-oProxyCommand=evil", "rohan && rm -rf /", "rohan other", "", "me@rohan", "rohan:22", "/tmp/x"];
    hosts.push(`rohan${String.fromCharCode(9)}x`);
    for (const host of hosts) {
      expect(() => sshConnectPlan({ ...REMOTE, host }), JSON.stringify(host)).toThrow(TransportError);
    }
  });

  it("rejects a user that could become an option or a shell word", () => {
    for (const user of ["-oProxyCommand=evil", "me user", "me;rm", "", "me/x", "me@x"]) {
      expect(() => sshConnectPlan({ ...REMOTE, user }), user).toThrow(TransportError);
    }
  });

  it("rejects a port outside 1-65535 or not an integer", () => {
    for (const port of [0, -1, 65_536, 22.5, Number.NaN]) {
      expect(() => sshConnectPlan({ ...REMOTE, port }), String(port)).toThrow(TransportError);
    }
  });

  it("requires an absolute, dedicated known-hosts file", () => {
    expect(() => sshConnectPlan({ ...REMOTE, knownHostsFile: "" })).toThrow(TransportError);
    expect(() => sshConnectPlan({ ...REMOTE, knownHostsFile: "known_hosts" })).toThrow(/absolute/);
    expect(() => sshConnectPlan({ ...REMOTE, knownHostsFile: "~/.ssh/known_hosts" })).toThrow(/absolute/);
    expect(() => sshConnectPlan({ ...REMOTE, knownHostsFile: "-oStrictHostKeyChecking=no" })).toThrow(TransportError);
  });

  it("requires an absolute identity file that is not an option", () => {
    expect(() => sshConnectPlan({ ...REMOTE, identityFile: "id_ed25519" })).toThrow(/absolute/);
    expect(() => sshConnectPlan({ ...REMOTE, identityFile: "-oProxyCommand=evil" })).toThrow(TransportError);
    expect(() => sshConnectPlan({ ...REMOTE, identityFile: "" })).toThrow(TransportError);
  });

  it("accepts only a real SHA256 or MD5 fingerprint", () => {
    for (const fingerprint of ["", "SHA256:short", `sha256:${"a".repeat(43)}`, "MD5:aa:bb", "rohan"]) {
      expect(() => sshConnectPlan({ ...REMOTE, hostKeyFingerprint: fingerprint }), fingerprint).toThrow(TransportError);
    }
    expect(() => sshConnectPlan({ ...REMOTE, hostKeyFingerprint: FINGERPRINT })).not.toThrow();
    expect(() => sshConnectPlan({ ...REMOTE, hostKeyFingerprint: `MD5:${"aa:".repeat(15)}aa` })).not.toThrow();
  });

  it("rejects control characters in every free-form setting", () => {
    const newline = String.fromCharCode(10);
    const nul = String.fromCharCode(0);
    expect(() => sshConnectPlan({ ...REMOTE, session: `work${newline}` })).toThrow(TransportError);
    expect(() => sshConnectPlan({ ...REMOTE, program: `herdr-core${nul}` })).toThrow(TransportError);
    expect(() => sshConnectPlan({ ...REMOTE, ssh: `ssh${newline}` })).toThrow(TransportError);
  });

  it("refuses an argv that would stop checking the host key", () => {
    expect(() => assertSecureSshArgs(["-T", "-o", "StrictHostKeyChecking=no", "rohan", "x"])).toThrow(
      /StrictHostKeyChecking=no/,
    );
    expect(() => assertSecureSshArgs(["-T", "-o", "StrictHostKeyChecking=accept-new", "rohan", "x"])).toThrow(
      TransportError,
    );
    expect(() => assertSecureSshArgs(["-T", "-o", "ProxyCommand=evil", "rohan", "x"])).toThrow(/runs a command/);
    expect(() => assertSecureSshArgs(["-T", "-o", "LocalCommand=evil", "rohan", "x"])).toThrow(/runs a command/);
    expect(() => assertSecureSshArgs(["-T", "-o", "KnownHostsCommand=evil", "rohan", "x"])).toThrow(/runs a command/);
    expect(() => assertSecureSshArgs(["-T", "rohan", "x"])).toThrow(/host key/);
    expect(() => assertSecureSshArgs(["-T", "-o", "StrictHostKeyChecking=yes", "rohan", "x"])).toThrow(/known-hosts/);
    expect(() =>
      assertSecureSshArgs([
        "-T",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${KNOWN_HOSTS}`,
        "rohan",
        "x",
      ]),
    ).toThrow(/never prompt/);
  });

  it("keeps the identity file's path out of anything loggable", () => {
    const plan = sshConnectPlan({ ...REMOTE, identityFile: IDENTITY });
    const described = describeSpawnPlan(plan);
    expect(JSON.stringify(described)).not.toContain(IDENTITY);
    expect(described.args).toContain("<identity-file>");
    expect(sshFlag(described.args, "-i")).toBe("<identity-file>");
    // The plan itself still has it: only the loggable view is redacted.
    expect(sshFlag(plan.args, "-i")).toBe(IDENTITY);
  });

  it("never reads or embeds the key's bytes", () => {
    const plan = sshConnectPlan({ ...REMOTE, identityFile: IDENTITY });
    // The plan is data: a path and flags, never file contents.
    expect(JSON.stringify(plan)).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    for (const arg of plan.args) expect(arg).not.toContain("PRIVATE KEY");
  });

  it("builds the same argv for the same config, so a retry cannot drift", () => {
    const config: SshConnectConfig = { ...REMOTE, port: 2222, identityFile: IDENTITY };
    expect(sshConnectPlan(config).args).toEqual(sshConnectPlan(config).args);
    expect(sshOptions(sshConnectPlan(config).args).filter((option) => option === "StrictHostKeyChecking=yes")).toHaveLength(1);
  });
});

describe("the environment layer's pre-check", () => {
  it("gets a descriptor before any pipe opens", () => {
    const descriptor = sshConnectDescriptor({ ...REMOTE, port: 2222, hostKeyFingerprint: FINGERPRINT });
    expect(descriptor).toMatchObject({
      kind: "ssh",
      host: "rohan",
      user: "me",
      port: 2222,
      knownHostsFile: KNOWN_HOSTS,
      hostKeyFingerprint: FINGERPRINT,
      batchMode: true,
      strictHostKeyChecking: "yes",
    });
    // Building the descriptor spawns nothing and needs no key file to exist.
    expect(descriptor.identitiesOnly).toBe(false);
  });

  it("validates a host the same way whichever entry point is used", () => {
    expect(() => assertHost("-oProxyCommand=evil")).toThrow(TransportError);
    expect(() => assertHost("rohan.example.com")).not.toThrow();
    expect(() => assertHost("10.0.0.5")).not.toThrow();
    expect(() => assertHost("[2001:db8::1]")).not.toThrow();
  });
});

describe("the default spawner", () => {
  it("runs a real child process and speaks the protocol over its pipes", async () => {
    const plan = { command: process.execPath, args: ["-e", FAKE_HC_SOURCE] };
    const connection = new HcConnection({ plan, spawner: defaultSpawner }).open();
    try {
      const hello = await connection.handshake({ framed: false });
      expect(hello.core.name).toBe("fixture");
      expect(hello.generation).toBe(1);
      await expect(connection.request("terminal.list", {})).resolves.toMatchObject({ terminals: [] });
    } finally {
      connection.close();
    }
  });

  it("reports a program that does not exist instead of hanging", async () => {
    const connection = new HcConnection({
      plan: { command: "definitely-not-herdr-core", args: ["connect"] },
      spawner: defaultSpawner,
      requestTimeoutMs: 5000,
    });
    connection.open();
    const error = await connection.handshake({ framed: false }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toContain("cannot start definitely-not-herdr-core");
  });

  it("surfaces a child that exits at once, with its stderr", async () => {
    const plan = { command: process.execPath, args: ["-e", 'process.stderr.write("no hc here\\n"); process.exit(127);'] };
    const connection = new HcConnection({ plan, spawner: defaultSpawner, requestTimeoutMs: 5000 }).open();
    const error = await connection.handshake({ framed: false }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toContain("no hc here");
  });
});

describe("a slow stream never blocks channel 0", () => {
  it("answers a call while an attach channel waits for credit", async () => {
    const fake = new FakeHc();
    fake.terminal("t1");
    const hc = new HcClient({ transport: { kind: "local" }, spawner: fake.spawner });
    await hc.connect();
    const opening = hc.attach({ terminal: "t1", cols: 80, rows: 24 });
    await settle();
    const channel = fake.answerAttach(fake.call("terminal.attach")!);
    const stream = await opening;
    stream.on("data", () => {});
    // Fill the window with output the viewer never acknowledges.
    fake.streamData(channel, Buffer.alloc(INITIAL_STREAM_CREDIT));
    await settle();

    const listing = hc.list();
    await settle();
    const call = fake.call("terminal.list")!;
    expect(call).toBeDefined();
    fake.answerList(call);
    await expect(listing).resolves.toMatchObject({ terminals: [{ address: "t1" }] });
    expect(stream.window).toBeLessThan(INITIAL_STREAM_CREDIT);
    hc.close();
  });

  it("still routes viewer input while the stream is stalled", async () => {
    const fake = new FakeHc();
    const hc = new HcClient({ transport: { kind: "local" }, spawner: fake.spawner });
    await hc.connect();
    const opening = hc.attach({ terminal: "t1", cols: 80, rows: 24 });
    await settle();
    const channel = fake.answerAttach(fake.call("terminal.attach")!);
    const stream = await opening;
    stream.on("data", () => {});
    fake.streamData(channel, Buffer.alloc(INITIAL_STREAM_CREDIT));
    await settle();
    await stream.sendInput(Buffer.from("still typing\r"));
    const keys = fake.framesIn.filter((frame) => frame.channel === channel && frame.kind === FrameKind.DATA);
    expect(Buffer.from(keys.at(-1)!.payload).toString()).toBe("still typing\r");
    hc.close();
  });

  it("answers channel 0 while two streams and the event channel are stalled", async () => {
    const fake = new FakeHc();
    fake.terminal("t1");
    fake.terminal("t2");
    const hc = new HcClient({ transport: { kind: "local" }, spawner: fake.spawner });
    await hc.connect();
    const subscribing = hc.subscribe();
    await settle();
    fake.answerSubscribe(fake.call("events.subscribe")!, { seq: 0 });
    await subscribing;

    const first = hc.attach({ terminal: "t1", cols: 80, rows: 24 });
    await settle();
    const one = fake.answerAttach(fake.call("terminal.attach")!);
    const streamOne = await first;
    streamOne.on("data", () => {});

    const second = hc.attach({ terminal: "t2", cols: 80, rows: 24 });
    await settle();
    const two = fake.answerAttach(fake.callsOf("terminal.attach").at(-1)!);
    const streamTwo = await second;
    streamTwo.on("data", () => {});

    fake.streamData(one, Buffer.alloc(INITIAL_STREAM_CREDIT));
    fake.streamData(two, Buffer.alloc(INITIAL_STREAM_CREDIT));
    await settle();
    expect(streamOne.window).toBeLessThan(INITIAL_STREAM_CREDIT);
    expect(streamTwo.window).toBeLessThan(INITIAL_STREAM_CREDIT);

    const listing = hc.list();
    await settle();
    fake.answerList(fake.call("terminal.list")!);
    await expect(listing).resolves.toMatchObject({ terminals: expect.any(Array) });
    hc.close();
  });
});
