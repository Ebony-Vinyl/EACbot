import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EnvironmentRecord } from "../environments/types.ts";
import { UNKNOWN_CAPABILITIES } from "../environments/types.ts";
import { JsonTerminalRefStore } from "./bootstrap.ts";
import { HcClient } from "./client.ts";
import { TerminalService, TerminalServiceError, sshConfigForEnvironment, viewerLeaseId } from "./service.ts";
import { FakeHc } from "./testing/fake-hc.ts";
import type { SpawnPlan } from "./transport.ts";
import type { HcClientFactory } from "./service.ts";
import type { Terminal } from "./types.ts";

/** Lets queued timers and pipe reads run. A reconnect is a `setTimeout`, so
 * waiting only on immediates would never reach it. */
const settle = async (turns = 6): Promise<void> => {
  for (let at = 0; at < turns; at += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const IDENTITY = "/home/me/.ssh/id_eacbot";
const KNOWN_HOSTS = "/home/me/.eacbot/known_hosts";

function environmentRecord(overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id: "env-1",
    label: "my laptop",
    host: "10.0.0.5",
    port: 22,
    user: "me",
    knownHostsFile: KNOWN_HOSTS,
    hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    identityFileRef: "ref-1",
    status: "online",
    lastSeen: null,
    capabilities: { ...UNKNOWN_CAPABILITIES, homeDir: "/home/me" },
    tools: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

interface FakeCall {
  readonly id: number | string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function terminalRecord(address: string, createdMs: number, overrides: Partial<Terminal> = {}): Terminal {
  return {
    address,
    argv: ["sh"],
    cwd: "/home/me",
    state: "live",
    created_ms: createdMs,
    screen: "exact",
    cols: 80,
    rows: 24,
    labels: {},
    title: "",
    turn: 0,
    ...overrides,
  };
}

/**
 * A stand-in for the remote core: each client the service builds rides a
 * `FakeHc` that speaks the real wire format, so the ssh plan is real and only
 * the machine on the far side is fake.
 */
class FakeHerdr {
  readonly cores: FakeHc[] = [];
  readonly plans: SpawnPlan[] = [];
  readonly records = new Map<string, Terminal>();
  readonly lostOnRestart = new Set<string>();
  paint: Uint8Array = Buffer.from("history paint");
  #nextAddress = 1;
  #nextCreatedMs = 100;

  readonly factory: HcClientFactory = ({ plan }) => {
    this.plans.push(plan);
    const fake = this.#core();
    return new HcClient({ plan, spawner: fake.spawner });
  };

  get core(): FakeHc {
    return this.cores.at(-1)!;
  }

  #core(): FakeHc {
    const fake = new FakeHc();
    for (const [address, record] of this.records) {
      if (this.lostOnRestart.has(address)) continue;
      fake.terminal(address, { ...record });
    }
    fake.on("call", (call: FakeCall) => this.#answer(fake, call));
    this.cores.push(fake);
    return fake;
  }

  #answer(fake: FakeHc, call: FakeCall): void {
    switch (call.method) {
      case "events.subscribe":
        fake.answerSubscribe(call);
        return;
      case "terminal.run": {
        const address = `hc-${this.#nextAddress++}`;
        const createdMs = (this.#nextCreatedMs += 10);
        const record = terminalRecord(address, createdMs, {
          argv: (call.params.argv as string[]) ?? [],
          cwd: String(call.params.cwd ?? "/home/me"),
          cols: Number((call.params.size as { cols?: number } | undefined)?.cols ?? 80),
          rows: Number((call.params.size as { rows?: number } | undefined)?.rows ?? 24),
          labels: (call.params.labels as Record<string, string>) ?? {},
          name: (call.params.name as string | null) ?? null,
        });
        this.records.set(address, record);
        fake.terminal(address, { ...record });
        fake.reply(call, record);
        return;
      }
      case "terminal.get": {
        const address = String(call.params.terminal);
        const record = fake.terminals.get(address);
        if (!record) {
          fake.replyError(call, { code: -32000, message: "no such terminal", kind: "not_found" });
          return;
        }
        const { output, ...terminal } = record;
        void output;
        fake.reply(call, terminal);
        return;
      }
      case "terminal.kill": {
        const address = String(call.params.terminal);
        const record = fake.terminals.get(address);
        if (!record) {
          fake.replyError(call, { code: -32000, message: "no such terminal", kind: "not_found" });
          return;
        }
        const killed: Terminal = { ...record, state: "finished", reason: "killed", exit_code: 137 };
        this.records.set(address, killed);
        fake.reply(call, killed);
        return;
      }
      case "terminal.send":
        fake.reply(call, { turn: 1 });
        return;
      case "terminal.interrupt":
        fake.reply(call, { outcome: "stopped", key: "ctrl-c" });
        return;
      case "terminal.attach":
        fake.answerAttach(call, { paint: this.paint });
        return;
      case "terminal.list":
        fake.answerList(call);
        return;
      default:
        return;
    }
  }
}

function serviceFor(herdr: FakeHerdr, overrides: Partial<Parameters<typeof TerminalService>[0]> = {}): TerminalService {
  const environments = new Map<string, EnvironmentRecord>([["env-1", environmentRecord()]]);
  return new TerminalService({
    environments: { get: (id) => environments.get(id) ?? null },
    identity: (ref) => (ref === "ref-1" ? IDENTITY : null),
    client: herdr.factory,
    reconnectDelaysMs: [0],
    now: () => "2026-01-01T00:00:01.000Z",
    ...overrides,
  });
}

const open: (() => void)[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!();
});

function track(service: TerminalService): TerminalService {
  open.push(() => service.close());
  return service;
}

async function started(herdr: FakeHerdr, service: TerminalService) {
  const ref = await service.start({ environmentId: "env-1", tool: "claude", missionId: "m-1", runId: "r-1" });
  await settle();
  return ref;
}

describe("starting an agent TUI", () => {
  it("runs a local executable through Herdr without SSH", async () => {
    const herdr = new FakeHerdr();
    const environment = environmentRecord({ kind: "local", tools: [{ name: "claude", status: "installed", path: "/fixture/bin/claude", version: "1.0.0" }] });
    const service = track(serviceFor(herdr, { environments: { get: () => environment } }));
    await started(herdr, service);
    expect(herdr.plans[0]).toMatchObject({ command: "herdr-core", args: ["connect"] });
    expect(herdr.core.callsOf("terminal.run")[0]!.params.argv).toEqual(["/fixture/bin/claude"]);
  });
  it("opens one ssh connection from the environment record and runs the tool's own argv", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await service.start({ environmentId: "env-1", tool: "hermes", missionId: "m-1", runId: "r-1", cols: 100, rows: 30 });
    await settle();

    expect(herdr.plans).toHaveLength(1);
    const plan = herdr.plans[0]!;
    expect(plan.command).toBe("ssh");
    expect(plan.args).toContain("StrictHostKeyChecking=yes");
    expect(plan.args).toContain(`UserKnownHostsFile=${KNOWN_HOSTS}`);
    expect(plan.args).toContain("BatchMode=yes");
    expect(plan.args).toContain("10.0.0.5");
    expect(plan.args.at(-1)).toContain("exec");

    const run = herdr.core.callsOf("terminal.run")[0]!;
    expect(run.params.argv).toEqual(["hermes"]);
    expect(run.params.cwd).toBe("/home/me");
    expect(run.params.env).toMatchObject({ HOME: "/home/me" });
    expect(run.params.env?.PATH).toContain("/home/me/.local/bin");
    expect(run.params.env?.PATH).toContain("/home/me/.eacbot-env/bin");
    expect(run.params.size).toEqual({ cols: 100, rows: 30 });

    expect(ref).toMatchObject({ kind: "nativeTui", missionId: "m-1", runId: "r-1" });
    expect(service.list()).toEqual([ref]);
    expect(service.get(ref.id)).toEqual(ref);
  });

  it("keeps a fixed argv for every supported tool and refuses anything else", async () => {
    for (const tool of ["hermes", "claude", "codex", "opencode", "pi", "omp"] as const) {
      const herdr = new FakeHerdr();
      const service = track(serviceFor(herdr));
      await service.start({ environmentId: "env-1", tool, missionId: "m", runId: "r" });
      await settle();
      expect(herdr.core.callsOf("terminal.run")[0]!.params.argv).toEqual([tool]);
    }

    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    await expect(
      service.start({ environmentId: "env-1", tool: "bash" as never, missionId: "m", runId: "r" }),
    ).rejects.toBeInstanceOf(TerminalServiceError);
    expect(herdr.plans).toHaveLength(0);
  });

  it("takes the working directory and instance HOME from the environment", async () => {
    const herdr = new FakeHerdr();
    const environments = new Map<string, EnvironmentRecord>([["env-1", environmentRecord()]]);
    const service = track(
      new TerminalService({
        environments: { get: (id) => environments.get(id) ?? null },
        client: herdr.factory,
        now: () => "2026-01-01T00:00:01.000Z",
      }),
    );
    await service.start({
      environmentId: "env-1",
      tool: "codex",
      missionId: "m",
      runId: "r",
      cwd: "/home/me/work/project",
      home: "/home/me/.eacbot/instances/one",
    });
    await settle();
    const run = herdr.core.callsOf("terminal.run")[0]!;
    expect(run.params.cwd).toBe("/home/me/work/project");
    expect(run.params.env).toMatchObject({ HOME: "/home/me/.eacbot/instances/one" });
    expect(run.params.env?.PATH).toContain("/home/me/.eacbot/instances/one/.eacbot-env/bin");
  });

  it("refuses to start when the environment never reported a home directory", async () => {
    const herdr = new FakeHerdr();
    const environments = new Map<string, EnvironmentRecord>([
      ["env-1", environmentRecord({ capabilities: { ...UNKNOWN_CAPABILITIES } })],
    ]);
    const service = track(
      new TerminalService({ environments: { get: (id) => environments.get(id) ?? null }, client: herdr.factory }),
    );
    await expect(service.start({ environmentId: "env-1", tool: "pi", missionId: "m", runId: "r" })).rejects.toMatchObject({
      code: "missing_home",
    });
    expect(herdr.plans).toHaveLength(0);
  });

  it("refuses an unknown environment without opening a connection", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    await expect(service.start({ environmentId: "env-9", tool: "pi", missionId: "m", runId: "r" })).rejects.toMatchObject({
      code: "unknown_environment",
    });
    expect(herdr.plans).toHaveLength(0);
  });

  it("refuses a relative working directory rather than guessing one", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    await expect(
      service.start({ environmentId: "env-1", tool: "pi", missionId: "m", runId: "r", cwd: "work" }),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });
});

describe("one connection per environment", () => {
  it("reuses the client for a second terminal", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    await service.start({ environmentId: "env-1", tool: "hermes", missionId: "m", runId: "r1" });
    await service.start({ environmentId: "env-1", tool: "claude", missionId: "m", runId: "r2" });
    await settle();
    expect(herdr.plans).toHaveLength(1);
    expect(herdr.core.callsOf("terminal.run")).toHaveLength(2);
    expect(service.list()).toHaveLength(2);
  });

  it("resolves the identity reference for the call only", () => {
    const config = sshConfigForEnvironment(environmentRecord(), (ref) => (ref === "ref-1" ? IDENTITY : null));
    expect(config.identityFile).toBe(IDENTITY);
    expect(config.knownHostsFile).toBe(KNOWN_HOSTS);
    expect(sshConfigForEnvironment(environmentRecord({ identityFileRef: null })).identityFile).toBeNull();
  });
});

describe("terminal list and reference mapping", () => {
  it("maps this application's id onto the core's native address", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    expect(ref).not.toBe("hc-1");
    const attach = await service.attach({ terminalId: ref.id, viewerId: "browser" });
    await settle();
    expect(herdr.core.callsOf("terminal.attach")[0]!.params.terminal).toBe("hc-1");
    await attach.stream.detach();
  });

  it("persists the mapping so a restarted process still names the same terminals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-terminal-refs-"));
    open.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "terminals.json");
    const herdr = new FakeHerdr();
    const first = track(serviceFor(herdr, { refs: new JsonTerminalRefStore(path) }));
    const ref = await started(herdr, first);
    expect(JSON.parse(readFileSync(path, "utf8")).terminals).toHaveLength(1);
    first.close();

    const second = track(serviceFor(herdr, { refs: new JsonTerminalRefStore(path) }));
    expect(second.list()).toEqual([ref]);
    expect(second.get(ref.id)).toEqual(ref);
  });

  it("reports an unknown terminal id instead of reaching the core", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    await expect(service.attach({ terminalId: "nope", viewerId: "browser" })).rejects.toMatchObject({
      code: "unknown_terminal",
    });
    expect(herdr.plans).toHaveLength(0);
  });
});

describe("send, interrupt and kill", () => {
  it("sends text to the native terminal", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const result = await service.send(ref.id, "hello\n");
    expect(result.turn).toBe(1);
    const call = herdr.core.callsOf("terminal.send")[0]!;
    expect(call.params).toMatchObject({ terminal: "hc-1", text: "hello\n" });
  });

  it("interrupts the native terminal", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    expect((await service.interrupt(ref.id, 2_000)).outcome).toBe("stopped");
    expect(herdr.core.callsOf("terminal.interrupt")[0]!.params).toEqual({ terminal: "hc-1", timeout: 2_000 });
  });

  it("kills a terminal and reports it closed with the core's exit code", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const exits: unknown[] = [];
    service.on("exit", (event) => exits.push(event));
    const killed = await service.kill(ref.id);
    expect(killed.closedAt).toBeDefined();
    expect(killed.exitCode).toBe(137);
    expect(exits).toEqual([{ terminalId: ref.id, reason: "killed", exitCode: 137 }]);
    await expect(service.attach({ terminalId: ref.id, viewerId: "browser" })).rejects.toMatchObject({ code: "closed" });
  });

  it("refuses a send after the terminal ended", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    await service.kill(ref.id);
    await expect(service.send(ref.id, "x")).rejects.toMatchObject({ code: "unknown_terminal" }).catch(() => {});
    expect(service.get(ref.id)?.closedAt).toBeDefined();
  });
});

describe("attach and the control lease", () => {
  it("gives the first viewer control and asks the core for a paint", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const attachment = await service.attach({ terminalId: ref.id, viewerId: "browser", cols: 120, rows: 40, history: 500 });
    await settle();
    expect(attachment.canControl).toBe(true);
    expect(attachment.cols).toBe(120);
    const call = herdr.core.callsOf("terminal.attach")[0]!;
    expect(call.params).toMatchObject({ terminal: "hc-1", cols: 120, rows: 40, history: 500, observe: false });
    const paint: string[] = [];
    attachment.stream.on("data", (bytes) => paint.push(Buffer.from(bytes).toString()));
    expect(paint).toEqual(["history paint"]);
    await attachment.stream.detach();
  });

  it("lets an observer watch but never type or resize", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const controller = await service.attach({ terminalId: ref.id, viewerId: "browser" });
    const observer = await service.attach({ terminalId: ref.id, viewerId: "phone", observe: true });
    await settle();
    expect(observer.canControl).toBe(false);
    await expect(observer.stream.sendInput(Buffer.from("x"))).rejects.toThrow(/observer never types/u);
    await expect(observer.stream.resize(90, 30)).rejects.toThrow(/may watch but not resize/u);
    expect(controller.canControl).toBe(true);
    await observer.stream.detach();
    await controller.stream.detach();
  });

  it("moves control to a second viewer and reports the first as revoked", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const first = await service.attach({ terminalId: ref.id, viewerId: "laptop" });
    const second = await service.attach({ terminalId: ref.id, viewerId: "phone" });
    await settle();
    expect(second.canControl).toBe(true);
    expect(first.stream.role).toBe("observe");
    await expect(first.stream.sendInput(Buffer.from("x"))).rejects.toThrow(/does not hold control/u);
    await first.stream.detach();
    await second.stream.detach();
  });

  it("uses one lease holder per viewer and terminal", () => {
    expect(viewerLeaseId("session-1", "term-1")).not.toBe(viewerLeaseId("session-1", "term-2"));
    expect(viewerLeaseId("session-1", "term-1")).toBe(viewerLeaseId("session-1", "term-1"));
  });

  it("resizes only through the viewer that holds control", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    await expect(service.resize(ref.id, 100, 30)).rejects.toMatchObject({ code: "not_controller" });
    const attachment = await service.attach({ terminalId: ref.id, viewerId: "browser" });
    await settle();
    await service.resize(ref.id, 100, 30);
    await settle();
    const resize = herdr.core.framesIn.find((frame) => frame.kind === 3);
    expect(resize?.payload.readUInt16LE(0)).toBe(100);
    expect(resize?.payload.readUInt16LE(2)).toBe(30);
    await attachment.stream.detach();
  });

  it("detaches only the named viewer", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const first = await service.attach({ terminalId: ref.id, viewerId: "laptop" });
    const second = await service.attach({ terminalId: ref.id, viewerId: "phone", observe: true });
    await settle();
    await service.detach(ref.id, "laptop");
    expect(first.stream.closed).toBe(true);
    expect(second.stream.closed).toBe(false);
    await second.stream.detach();
  });

  it("keeps the native terminal when a viewer detaches", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const attachment = await service.attach({ terminalId: ref.id, viewerId: "browser" });
    await settle();
    await attachment.stream.detach();
    await settle();
    expect(herdr.core.callsOf("terminal.kill")).toHaveLength(0);
    const again = await service.attach({ terminalId: ref.id, viewerId: "browser" });
    await settle();
    expect(herdr.core.callsOf("terminal.attach")).toHaveLength(2);
    await again.stream.detach();
  });
});

describe("events from the core", () => {
  it("passes a title and status through as the program reported them", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const titles: unknown[] = [];
    const statuses: unknown[] = [];
    service.on("title", (event) => titles.push(event));
    service.on("status", (event) => statuses.push(event));
    herdr.core.emitEvent("title", "hc-1", { title: "hermes — plan" });
    herdr.core.emitEvent("status", "hc-1", { status: { state: "working", app: "hermes" } });
    await settle();
    expect(titles).toEqual([{ terminalId: ref.id, title: "hermes — plan" }]);
    expect(statuses).toEqual([{ terminalId: ref.id, status: { state: "working", app: "hermes" } }]);
  });

  it("ends the reference when the core reports the program finished", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    herdr.core.emitEvent("finished", "hc-1", { reason: "exited", exit_code: 0 });
    await settle();
    expect(service.get(ref.id)).toMatchObject({ closedAt: "2026-01-01T00:00:01.000Z", exitCode: 0 });
  });

  it("ignores an event for a terminal this application did not start", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    await started(herdr, service);
    const exits: unknown[] = [];
    service.on("exit", (event) => exits.push(event));
    herdr.core.emitEvent("finished", "someone-else", { reason: "exited", exit_code: 0 });
    await settle();
    expect(exits).toEqual([]);
  });
});

describe("a dropped line", () => {
  it("reconnects, reattaches nothing, and asks viewers to resync a surviving terminal", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const resyncs: unknown[] = [];
    const exits: unknown[] = [];
    service.on("resync", (event) => resyncs.push(event));
    service.on("exit", (event) => exits.push(event));

    herdr.core.crash("the core died");
    await settle(20);

    expect(herdr.plans).toHaveLength(2);
    expect(herdr.core.callsOf("terminal.get")[0]!.params.terminal).toBe("hc-1");
    expect(resyncs).toEqual([{ terminalId: ref.id, reason: "reconnected" }]);
    expect(exits).toEqual([]);
    expect(service.get(ref.id)?.closedAt).toBeUndefined();
  });

  it("reports an exit for a terminal the new core no longer has, and never fakes one", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const exits: unknown[] = [];
    service.on("exit", (event) => exits.push(event));

    herdr.lostOnRestart.add("hc-1");
    herdr.core.crash();
    await settle(20);

    expect(exits).toEqual([{ terminalId: ref.id, reason: "lost", exitCode: null }]);
    expect(service.get(ref.id)?.closedAt).toBeDefined();
  });

  it("reports an exit when the core reused the address for a different program", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const exits: unknown[] = [];
    service.on("exit", (event) => exits.push(event));

    herdr.records.set("hc-1", terminalRecord("hc-1", 9_999));
    herdr.core.crash();
    await settle(20);

    expect(exits).toEqual([{ terminalId: ref.id, reason: "lost", exitCode: null }]);
  });

  it("attaches again after the reconnect and paints from the core's own history", async () => {
    const herdr = new FakeHerdr();
    const service = track(serviceFor(herdr));
    const ref = await started(herdr, service);
    const first = await service.attach({ terminalId: ref.id, viewerId: "browser" });
    await settle();

    herdr.paint = Buffer.from("second paint");
    herdr.core.crash();
    await settle(20);
    first.stream.on("lost", () => {});
    await settle();

    const second = await service.attach({ terminalId: ref.id, viewerId: "browser" });
    await settle();
    const paint: string[] = [];
    second.stream.on("data", (bytes) => paint.push(Buffer.from(bytes).toString()));
    expect(paint).toEqual(["second paint"]);
    expect(herdr.core.callsOf("terminal.attach")).toHaveLength(1);
    await second.stream.detach();
  });

  it("stops reconnecting once the service is closed", async () => {
    const herdr = new FakeHerdr();
    const service = serviceFor(herdr);
    await started(herdr, service);
    service.close();
    herdr.core.crash();
    await settle(20);
    expect(herdr.plans).toHaveLength(1);
  });
});

describe("failures are typed", () => {
  it("surfaces the core's own error kind when a start fails", async () => {
    const herdr = new FakeHerdr();
    const failing: HcClientFactory = ({ plan }) => {
      const fake = new FakeHc({ helloError: { code: -32000, message: "no login", kind: "needs_login" } });
      return new HcClient({ plan, spawner: fake.spawner });
    };
    const service = track(serviceFor(herdr, { client: failing }));
    await expect(
      service.start({ environmentId: "env-1", tool: "hermes", missionId: "m", runId: "r" }),
    ).rejects.toMatchObject({ kind: "needs_login" });
    expect(service.list()).toEqual([]);
  });

  it("refuses every call after close", async () => {
    const herdr = new FakeHerdr();
    const service = serviceFor(herdr);
    service.close();
    await expect(service.start({ environmentId: "env-1", tool: "hermes", missionId: "m", runId: "r" })).rejects.toMatchObject({
      code: "closed",
    });
  });
});
