import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_OUTPUT_BYTES,
  SshFailureError,
  defaultSshRunner,
  sshCommandPlan,
  type RemoteTarget,
  type SshCall,
} from "./index.ts";

const directories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eac-env-runner-"));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * These exercise the real `spawn`, with a real child, but never `ssh` itself:
 * the plan's command is swapped for `node`, so nothing leaves this machine and
 * no key is read.
 */
function callWith(args: readonly string[], extra: Partial<SshCall> = {}): SshCall {
  const target: RemoteTarget = {
    host: "laptop.example",
    port: 22,
    user: "me",
    knownHostsFile: "/var/lib/eacbot/known_hosts",
    hostKeyFingerprint: `SHA256:${"a".repeat(43)}`,
  };
  const plan = sshCommandPlan(target, ["true"]);
  return { plan: { ...plan, command: process.execPath, args }, timeoutMs: 10_000, ...extra };
}

describe("the real spawn runner", () => {
  it("returns the child's stdout and its exit code", async () => {
    const result = await defaultSshRunner(callWith(["-e", "process.stdout.write('hello')"]));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("returns a non-zero exit rather than throwing, so the caller can branch", async () => {
    const result = await defaultSshRunner(callWith(["-e", "process.exit(3)"]));
    expect(result.code).toBe(3);
  });

  it("feeds the caller's stdin and closes it", async () => {
    const script = "let data='';process.stdin.on('data',(c)=>data+=c);process.stdin.on('end',()=>process.stdout.write(data));";
    const result = await defaultSshRunner(callWith(["-e", script], { stdin: "payload" }));
    expect(result.stdout).toBe("payload");
  });

  it("closes stdin when the caller has nothing to send", async () => {
    const script = "(async()=>{let n=0;for await (const c of process.stdin) n+=c.length;process.stdout.write(`closed:${n}`);})();";
    const result = await defaultSshRunner(callWith(["-e", script]));
    expect(result.stdout).toBe("closed:0");
  });

  it("kills a child that outlives the timeout and reports it", async () => {
    const error = await defaultSshRunner(callWith(["-e", "setTimeout(()=>{},60000)"], { timeoutMs: 250 })).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(SshFailureError);
    expect(error.message).toContain("timed out");
  });

  it("caps a runaway stream instead of holding it all", async () => {
    const script = `process.stdout.write('x'.repeat(${MAX_OUTPUT_BYTES + 4096}))`;
    const result = await defaultSshRunner(callWith(["-e", script]));
    expect(result.stdout.length).toBeLessThan(MAX_OUTPUT_BYTES + 200);
    expect(result.stdout).toContain("more bytes were dropped");
  });

  it("reports a program that cannot start at all as a typed failure", async () => {
    const call: SshCall = { plan: { command: "/nonexistent/definitely-not-here", args: [] }, timeoutMs: 2_000 };
    const error = await defaultSshRunner(call).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(SshFailureError);
    expect(error.message).toContain("cannot start");
  });

  it("keeps the identity file's path out of what it reports", async () => {
    const dir = tempDir();
    const identity = join(dir, "id_ed25519");
    writeFileSync(identity, "not a real key\n");
    const script = "process.stderr.write(process.argv[1]||'');process.exit(1);";
    const call: SshCall = {
      plan: { command: process.execPath, args: ["-e", script, identity] },
      timeoutMs: 10_000,
      identityFile: identity,
    };
    const result = await defaultSshRunner(call);
    expect(result.stderr).toContain("<identity-file>");
    expect(result.stderr).not.toContain(identity);
  });

  it("reads the identity path off the plan's -i when the call does not name one", async () => {
    const dir = tempDir();
    const identity = join(dir, "id_ed25519");
    writeFileSync(identity, "not a real key\n");
    const script = "process.stderr.write(process.argv[1]||'');";
    const plan = {
      command: process.execPath,
      args: ["-i", identity, "-e", script, identity],
    };
    const result = await defaultSshRunner({ plan, timeoutMs: 10_000 });
    expect(result.stderr).toContain("<identity-file>");
    expect(result.stderr).not.toContain(identity);
  });

  it("never echoes a private key body, because it never reads one", async () => {
    const script = "process.stdout.write('ok')";
    const result = await defaultSshRunner(callWith(["-e", script]));
    expect(result.stdout).not.toContain("PRIVATE KEY");
  });
});
