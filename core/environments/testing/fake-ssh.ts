/**
 * A stand-in for the remote computer: it answers an ssh plan's remote command
 * from memory, so tests exercise the plan, the quoting and the parsing without
 * a network, a key or a user's machine.
 */

import type { SpawnPlan } from "../../terminal/transport.ts";
import { remoteCommandLine, type SshCall, type SshResult, type SshRunner } from "../ssh.ts";

export interface FakeAnswer {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const OK = (stdout = ""): FakeAnswer => ({ code: 0, stdout });

export const LOCATE_SCRIPT = 'command -v -- "$1"';

export class FakeMachine {
  readonly calls: SshCall[] = [];
  private readonly exact = new Map<string, FakeAnswer>();
  private readonly byPrefix: { prefix: string; answer: FakeAnswer }[] = [];
  private fallback: (line: string) => FakeAnswer | null = () => null;
  private readonly failures: { needle: string; answer: FakeAnswer }[] = [];
  /** A line the fake should treat as a dropped connection (ssh's exit 255). */
  private dropLine: string | null = null;
  private allowAll = false;

  answer(argv: readonly string[], result: FakeAnswer): this {
    this.exact.set(this.keyFor(argv), result);
    return this;
  }

  answerPrefix(argvPrefix: readonly string[], result: FakeAnswer): this {
    this.byPrefix.push({ prefix: this.keyFor(argvPrefix), answer: result });
    return this;
  }

  /** Answer a keyscan of `host` with these key lines. */
  answerKeyscan(host: string, keys: readonly { keyType: string; keyBlob: string }[], port = 22): this {
    const portArgs = port === 22 ? [] : ["-p", String(port)];
    this.byPrefix.push({
      prefix: ["ssh-keyscan", "-T", "10", "-t", "ed25519,ecdsa,rsa", ...portArgs, host].join(" "),
      answer: { code: 0, stdout: keys.map((key) => `${host} ${key.keyType} ${key.keyBlob}`).join("\n") },
    });
    return this;
  }

  onUnknown(fn: (line: string) => FakeAnswer | null): this {
    this.fallback = fn;
    return this;
  }

  /** Answer any line containing `needle` with this result, checked first. */
  failOn(needle: string, result: FakeAnswer): this {
    this.failures.push({ needle, answer: result });
    return this;
  }

  /** Answer an unrecognised line with success. Only for a machine whose every
   * step is a constant script from this layer, never for a probe's answer. */
  allowEverything(): this {
    this.allowAll = true;
    return this;
  }

  dropConnectionWhen(argv: readonly string[]): this {
    this.dropLine = this.keyFor(argv);
    return this;
  }

  /** What a plan is keyed on: the remote command for ssh, the program and its
   * argv for a local program such as `ssh-keyscan`. */
  private keyFor(argv: readonly string[]): string {
    return argv[0] === "ssh-keyscan" ? argv.join(" ") : remoteCommandLine(argv);
  }

  /** The remote command lines this fake was asked to run, in order. */
  lines(): string[] {
    return this.calls.map((call) => String(call.plan.args.at(-1) ?? ""));
  }

  /** Every plan's command and argv, joined, which is how a local program's call
   * reads. */
  argvLines(): string[] {
    return this.calls.map((call) => [call.plan.command, ...call.plan.args].join(" "));
  }

  plans(): SpawnPlan[] {
    return this.calls.map((call) => call.plan);
  }

  runner: SshRunner = async (call: SshCall): Promise<SshResult> => {
    this.calls.push(call);
    const isLocalProgram = call.plan.command === "ssh-keyscan";
    const line = isLocalProgram
      ? [call.plan.command, ...call.plan.args].join(" ")
      : String(call.plan.args.at(-1) ?? "");
    if (this.dropLine !== null && line === this.dropLine) {
      return { code: 255, stdout: "", stderr: "ssh: connect to host: Connection refused" };
    }
    const exact = this.exact.get(line);
    if (exact) return { code: exact.code, stdout: exact.stdout ?? "", stderr: exact.stderr ?? "" };
    for (const failure of this.failures) {
      if (line.includes(failure.needle)) {
        return { code: failure.answer.code, stdout: failure.answer.stdout ?? "", stderr: failure.answer.stderr ?? "" };
      }
    }
    for (const entry of this.byPrefix) {
      if (line.startsWith(entry.prefix)) {
        return { code: entry.answer.code, stdout: entry.answer.stdout ?? "", stderr: entry.answer.stderr ?? "" };
      }
    }
    const answered = this.fallback(line);
    if (answered) return { code: answered.code, stdout: answered.stdout ?? "", stderr: answered.stderr ?? "" };
    if (this.allowAll) return { code: 0, stdout: "", stderr: "" };
    return { code: 127, stdout: "", stderr: `sh: ${line}: not found` };
  };
}

export interface StandardMachineOptions {
  readonly os?: string;
  readonly arch?: string;
  readonly home?: string;
  readonly user?: string;
  readonly shell?: string;
  readonly availableKib?: number;
  /** tool name -> path, or absent for a machine that does not have it. */
  readonly tools?: Record<string, string>;
  /** tool name -> the first line its `--version` prints. */
  readonly versions?: Record<string, string>;
}

/** A Linux laptop with two agent CLIs, which every other test varies from. */
export function standardMachine(options: StandardMachineOptions = {}): FakeMachine {
  const machine = new FakeMachine();
  const home = options.home ?? "/home/me";
  machine
    .answer(["uname", "-s"], OK(`${options.os ?? "Linux"}\n`))
    .answer(["uname", "-m"], OK(`${options.arch ?? "x86_64"}\n`))
    .answer(["sh", "-c", 'printf %s "$HOME"'], OK(home))
    .answer(["id", "-un"], OK(`${options.user ?? "me"}\n`))
    .answer(["sh", "-c", 'printf %s "${SHELL:-}"'], OK(`${options.shell ?? "/bin/bash"}\n`))
    .answer(
      ["df", "-Pk", "."],
      OK(
        [
          "Filesystem     1024-blocks    Used Available Capacity Mounted on",
          `/dev/sda1        100000000 1000000 ${options.availableKib ?? 50_000_000}       2% /`,
          "",
        ].join("\n"),
      ),
    )
    .onUnknown((line) => {
      const locatePrefix = remoteCommandLine(["sh", "-c", LOCATE_SCRIPT, "sh"]);
      if (line.startsWith(`${locatePrefix} `)) {
        const name = line.slice(locatePrefix.length + 1).replaceAll("'", "");
        const path = options.tools?.[name];
        return path === undefined ? { code: 1, stdout: "", stderr: "" } : OK(`${path}\n`);
      }
      for (const [name, path] of Object.entries(options.tools ?? {})) {
        if (line === remoteCommandLine([path, "--version"])) {
          const version = options.versions?.[name];
          return version === undefined ? { code: 0, stdout: "" } : OK(`${version}\n`);
        }
      }
      return null;
    });
  return machine;
}
