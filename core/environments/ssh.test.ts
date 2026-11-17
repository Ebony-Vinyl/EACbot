import { describe, expect, it } from "vitest";

import { assertSecureSshArgs } from "../terminal/transport.ts";
import {
  InvalidEnvironmentError,
  SshDisconnectedError,
  SshFailureError,
  UnsafeSshArgumentsError,
  quoteRemoteWord,
  remoteCommandLine,
  runRemote,
  runRemoteChecked,
  sshCommandPlan,
  type RemoteTarget,
} from "./index.ts";
import { FakeMachine } from "./testing/fake-ssh.ts";

const TARGET: RemoteTarget = {
  host: "laptop.example",
  port: 2222,
  user: "me",
  knownHostsFile: "/var/lib/eacbot/known_hosts",
  hostKeyFingerprint: `SHA256:${"a".repeat(43)}`,
};

const IDENTITY = "/var/lib/eacbot/keys/me_ed25519";

function optionsOf(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    if (args[at] === "-o") values.push(args[at + 1] ?? "");
  }
  return values;
}

describe("remote argument quoting", () => {
  it("leaves a plain word alone and quotes everything else", () => {
    expect(quoteRemoteWord("uname")).toBe("'uname'");
    expect(quoteRemoteWord("a b")).toBe("'a b'");
    expect(quoteRemoteWord("it's")).toBe(`'it'\\''s'`);
    expect(quoteRemoteWord("$HOME; rm -rf /")).toBe(`'$HOME; rm -rf /'`);
  });

  it("refuses an empty word and a control character", () => {
    expect(() => quoteRemoteWord("")).toThrow(InvalidEnvironmentError);
    expect(() => quoteRemoteWord("a\nb")).toThrow(InvalidEnvironmentError);
  });

  it("joins an argv without ever leaving a word unquoted", () => {
    expect(remoteCommandLine(["sh", "-c", "printf %s \"$HOME\""])).toBe(`'sh' '-c' 'printf %s "$HOME"'`);
  });
});

describe("the ssh plan this layer builds", () => {
  it("passes the terminal layer's own safety assertions", () => {
    const plan = sshCommandPlan(TARGET, ["true"]);
    expect(() => assertSecureSshArgs(plan.args)).not.toThrow();
  });

  it("always verifies the host key against the dedicated file and never prompts", () => {
    const options = optionsOf(sshCommandPlan(TARGET, ["true"]).args);
    expect(options).toContain("StrictHostKeyChecking=yes");
    expect(options).toContain(`UserKnownHostsFile=${TARGET.knownHostsFile}`);
    expect(options).toContain("BatchMode=yes");
    expect(options.some((value) => /^ProxyCommand|^LocalCommand|^KnownHostsCommand/.test(value))).toBe(false);
  });

  it("puts the destination and the remote command last, as single arguments", () => {
    const args = sshCommandPlan(TARGET, ["uname", "-s"]).args;
    expect(args.at(-2)).toBe("laptop.example");
    expect(args.at(-1)).toBe(`'uname' '-s'`);
    expect(args.slice(0, 2)).toEqual(["-T", "-o"]);
  });

  it("adds -p and -l as separate arguments, not as part of the host", () => {
    const args = sshCommandPlan(TARGET, ["true"]).args;
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
    expect(args[args.indexOf("-l") + 1]).toBe("me");
    expect(args).not.toContain("me@laptop.example");
  });

  it("uses the identity file as -i and restricts identities to it", () => {
    const args = sshCommandPlan({ ...TARGET, identityFile: IDENTITY }, ["true"]).args;
    expect(args[args.indexOf("-i") + 1]).toBe(IDENTITY);
    expect(optionsOf(args)).toContain("IdentitiesOnly=yes");
  });

  it("carries no credential and no shell string when the target has a key", () => {
    const plan = sshCommandPlan({ ...TARGET, identityFile: IDENTITY }, ["true"]);
    expect(plan.connect?.usesIdentityFile).toBe(true);
    expect(plan.connect?.strictHostKeyChecking).toBe("yes");
    expect(plan.args.some((arg) => arg.includes("Password"))).toBe(false);
  });

  it("refuses a host that ssh would read as an option", () => {
    expect(() => sshCommandPlan({ ...TARGET, host: "-oProxyCommand=sh" }, ["true"])).toThrow(UnsafeSshArgumentsError);
  });

  it("refuses a relative known-hosts file, which would resolve to the user's own", () => {
    expect(() => sshCommandPlan({ ...TARGET, knownHostsFile: ".ssh/known_hosts" }, ["true"])).toThrow(UnsafeSshArgumentsError);
  });

  it("refuses a control character smuggled through a remote word", () => {
    expect(() => sshCommandPlan(TARGET, ["uname", "a\u0000b"])).toThrow(InvalidEnvironmentError);
  });
});

describe("running a remote command", () => {
  it("returns the answer of the command it asked for", async () => {
    const machine = new FakeMachine().answer(["uname", "-s"], { code: 0, stdout: "Linux\n" });
    expect(await runRemoteChecked(machine.runner, TARGET, ["uname", "-s"])).toBe("Linux\n");
    expect(machine.lines()).toEqual([`'uname' '-s'`]);
  });

  it("reports a dropped connection as a disconnect, not as the command failing", async () => {
    const machine = new FakeMachine().dropConnectionWhen(["true"]);
    await expect(runRemoteChecked(machine.runner, TARGET, ["true"])).rejects.toBeInstanceOf(SshDisconnectedError);
  });

  it("reports a command's own non-zero exit as a failure with its code", async () => {
    const machine = new FakeMachine().answer(["false"], { code: 3, stderr: "no such tool\n" });
    const error = await runRemoteChecked(machine.runner, TARGET, ["false"]).catch((caught: unknown) => caught as SshFailureError);
    expect(error).toBeInstanceOf(SshFailureError);
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain("no such tool");
  });

  it("keeps a failure's message to the last line, not the whole transcript", async () => {
    const machine = new FakeMachine().answer(["false"], { code: 1, stderr: "one\ntwo\nthree\n" });
    const error = await runRemoteChecked(machine.runner, TARGET, ["false"]).catch((caught: unknown) => caught as Error);
    expect(error.message).toContain("three");
    expect(error.message).not.toContain("one");
  });

  it("hands the caller the raw result when it asks for one", async () => {
    const machine = new FakeMachine().answer(["false"], { code: 1 });
    expect((await runRemote(machine.runner, TARGET, ["false"])).code).toBe(1);
  });
});

describe("an unsafe plan never reaches a runner", () => {
  it("throws before the runner is called", async () => {
    const machine = new FakeMachine();
    const unsafe: RemoteTarget = { ...TARGET, knownHostsFile: "relative_known_hosts" };
    await expect(runRemote(machine.runner, unsafe, ["true"])).rejects.toBeInstanceOf(UnsafeSshArgumentsError);
    expect(machine.calls).toHaveLength(0);
  });

  it("wraps a terminal-layer refusal as an unsafe-arguments error", () => {
    const target: RemoteTarget = { ...TARGET, knownHostsFile: "/var/lib/eacbot/known_hosts", ssh: "ssh\n-oProxyCommand=x" };
    expect(() => sshCommandPlan(target, ["true"])).toThrow(UnsafeSshArgumentsError);
  });
});
