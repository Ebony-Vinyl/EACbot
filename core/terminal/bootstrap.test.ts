import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EnvironmentRecord } from "../environments/types.ts";
import { UNKNOWN_CAPABILITIES } from "../environments/types.ts";
import {
  JsonTerminalRefStore,
  createProductionTerminalService,
  createUnconfiguredTerminalComposition,
  type TerminalComposition,
} from "./bootstrap.ts";
import { HcClient } from "./client.ts";
import { FakeHc } from "./testing/fake-hc.ts";
import type { HcClientFactory } from "./service.ts";
import type { Terminal } from "./types.ts";

const settle = async (turns = 6): Promise<void> => {
  for (let at = 0; at < turns; at += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const directories: string[] = [];
const compositions: TerminalComposition[] = [];

afterEach(() => {
  while (compositions.length > 0) compositions.pop()!.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eac-terminal-bootstrap-"));
  directories.push(dir);
  return dir;
}

function environmentRecord(): EnvironmentRecord {
  return {
    id: "env-1",
    label: "my laptop",
    host: "10.0.0.5",
    port: 22,
    user: "me",
    knownHostsFile: "/home/me/.eacbot/known_hosts",
    hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    identityFileRef: null,
    status: "online",
    lastSeen: null,
    capabilities: { ...UNKNOWN_CAPABILITIES, homeDir: "/home/me" },
    tools: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
  };
}

/** A fake core whose ssh plan is real but whose spawn is in memory. */
function fakeClient(): { factory: HcClientFactory; cores: FakeHc[] } {
  const cores: FakeHc[] = [];
  const factory: HcClientFactory = ({ plan }) => {
    const fake = new FakeHc();
    fake.on("call", (call: { id: number | string; method: string; params: Record<string, unknown> }) => {
      if (call.method === "events.subscribe") {
        fake.answerSubscribe(call);
        return;
      }
      if (call.method === "terminal.run") {
        const record: Terminal = {
          address: "hc-1",
          argv: (call.params.argv as string[]) ?? [],
          cwd: String(call.params.cwd ?? "/home/me"),
          state: "live",
          created_ms: 5,
          screen: "exact",
          cols: 80,
          rows: 24,
          labels: {},
          title: "",
          turn: 0,
        };
        fake.terminal("hc-1", { ...record });
        fake.reply(call, record);
      }
    });
    cores.push(fake);
    return new HcClient({ plan, spawner: fake.spawner });
  };
  return { factory, cores };
}

function compose(options: { client?: HcClientFactory; environments?: Map<string, EnvironmentRecord> } = {}): TerminalComposition {
  const environments = options.environments ?? new Map([["env-1", environmentRecord()]]);
  const composition = createProductionTerminalService({
    environments: { get: (id) => environments.get(id) ?? null },
    refsPath: join(dataDir(), "terminals.json"),
    ...(options.client !== undefined ? { client: options.client } : {}),
    now: () => "2026-01-01T00:00:01.000Z",
  });
  compositions.push(composition);
  return composition;
}

describe("createProductionTerminalService", () => {
  it("opens no connection when it is composed", () => {
    const { factory, cores } = fakeClient();
    const composition = compose({ client: factory });
    expect(cores).toHaveLength(0);
    expect(composition.terminals.list()).toEqual([]);
    expect(composition.terminals.get("term-1")).toBeUndefined();
  });

  it("wires the port and the stream handler to one service", async () => {
    const { factory, cores } = fakeClient();
    const composition = compose({ client: factory });
    const ref = await composition.service.start({
      environmentId: "env-1",
      tool: "hermes",
      missionId: "m-1",
      runId: "r-1",
    });
    await settle();
    expect(cores).toHaveLength(1);
    expect(composition.terminals.list()).toEqual([ref]);
    expect(composition.terminals.get(ref.id)).toEqual(ref);
    expect(composition.terminals.get("nope")).toBeUndefined();
  });

  it("writes the reference map where it was told, and reads it back", async () => {
    const dir = dataDir();
    const path = join(dir, "terminals.json");
    const { factory } = fakeClient();
    const first = createProductionTerminalService({
      environments: { get: (id) => (id === "env-1" ? environmentRecord() : null) },
      refsPath: path,
      client: factory,
      now: () => "2026-01-01T00:00:01.000Z",
    });
    compositions.push(first);
    const ref = await first.service.start({ environmentId: "env-1", tool: "codex", missionId: "m", runId: "r" });
    await settle();

    const written = JSON.parse(readFileSync(path, "utf8")) as { terminals: { id: string; nativeId: string }[] };
    expect(written.terminals).toEqual([expect.objectContaining({ id: ref.id, nativeId: "hc-1" })]);

    const second = createProductionTerminalService({
      environments: { get: () => null },
      refsPath: path,
    });
    compositions.push(second);
    expect(second.terminals.list()).toEqual([ref]);
  });

  it("refuses a relative reference path rather than writing into the working directory", () => {
    expect(() =>
      createProductionTerminalService({ environments: { get: () => null }, refsPath: "terminals.json" }),
    ).toThrow(/absolute path/u);
  });

  it("rejects a reference file it cannot understand instead of dropping terminals", () => {
    const dir = dataDir();
    const path = join(dir, "terminals.json");
    const store = new JsonTerminalRefStore(path);
    store.save([
      {
        id: "t-1",
        environmentId: "env-1",
        nativeId: "hc-1",
        createdMs: 1,
        tool: "hermes",
        missionId: "m",
        runId: "r",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(store.load()).toHaveLength(1);
  });
});

describe("createUnconfiguredTerminalComposition", () => {
  it("reports no terminals and refuses a stream rather than pretending", () => {
    const composition = createUnconfiguredTerminalComposition();
    compositions.push(composition);
    expect(composition.terminals.list()).toEqual([]);
    expect(composition.terminals.get("anything")).toBeUndefined();
    expect(() =>
      composition.terminalStreams.open({
        terminalId: "t-1",
        sessionId: "s-1",
        scope: "device",
        socket: { write: () => true, end: () => {}, destroy: () => {}, on: () => undefined },
      }),
    ).toThrow(/not configured/u);
  });
});
