import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { EnvironmentStore } from "../environments/store.ts";
import { defaultSshRunner } from "../environments/ssh.ts";
import { FakeAdapterRegistry } from "../missions/fake-registry.ts";
import { MissionRuntime } from "../missions/runtime.ts";
import {
  createProductionTerminalService,
  createUnconfiguredTerminalComposition,
  type TerminalComposition,
} from "../terminal/bootstrap.ts";
import { AgentCatalog } from "./agents.ts";
import { EnvironmentStorePort, InMemoryEnvironmentStore } from "./environments.ts";
import { buildProductionComposition } from "./production.ts";
import { startServer } from "./start.ts";
import type { AgentKind } from "../../packages/agent-protocol/agents.ts";
import type { AgentCatalogPort, EnvironmentPort } from "../http/ports.ts";
import type { ChildLike, SpawnFn } from "../agents/transport/types.ts";

const dataDir = process.env.EAC_CORE_DATA_DIR ?? join(process.cwd(), ".eacbot-core");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

/** The adapter contract names signals as strings; Node's child only accepts
 * its own signal union. Everything else on the child is structurally what the
 * adapters read. */
const spawnAgent: SpawnFn = (command, args, options) =>
  spawn(command, [...args], {
    env: options.env,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as unknown as ChildLike;

const useFake = process.env.EAC_CORE_FAKE_AGENTS === "1" || !existsSync(join(dataDir, "core.json"));
const agents = useFake ? fakeAgents() : null;
const production = agents === null
  ? buildProductionComposition({
      dataDir,
      spawn: spawnAgent,
      fetch: (input, init) => fetch(input, init),
      hostEnv: process.env,
      onError: (error, context) => process.stderr.write(`${context}: ${describe(error)}\n`),
    })
  : null;
const runtime = production?.runtime ?? agents!.runtime;
const catalog: AgentCatalogPort = production?.agents ?? agents!.catalog;
const computers = openComputers(dataDir);
const staticRoot = join(process.cwd(), "dist");

const server = await startServer({
  runtime,
  agents: catalog,
  environments: computers.environments,
  terminals: computers.terminals.terminals,
  terminalStreams: computers.terminals.terminalStreams,
  ...(existsSync(join(staticRoot, "index.html")) ? { staticRoot } : {}),
  listen: { host: process.env.EAC_CORE_HOST ?? "127.0.0.1", port: Number(process.env.EAC_CORE_PORT ?? 8789) },
  onError: (error, context) => process.stderr.write(`${context}: ${describe(error)}\n`),
});
process.stdout.write(`EACbot core listening at ${server.url}\n`);
for (const skipped of production?.skipped ?? []) {
  process.stderr.write(`agent ${skipped.instanceId} skipped: ${skipped.reason}\n`);
}

const shutdown = async (): Promise<void> => {
  await server.shutdown();
  computers.terminals.close();
  if (production !== null) production.close();
  else (runtime as MissionRuntime).close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

interface Computers {
  readonly environments: EnvironmentPort;
  readonly terminals: TerminalComposition;
}

/** One durable record of the person's computers, read by both the terminal
 * layer and the HTTP routes: a terminal opened from a route and a computer
 * listed by one are the same record. A store that cannot be read leaves the
 * server with neither, rather than stopping it, and says so once. No connection
 * is opened here: the service reaches a computer only when a route asks. */
function openComputers(directory: string): Computers {
  try {
    const store = EnvironmentStore.open({ dataDir: directory });
    return {
      environments: new EnvironmentStorePort({ store, runner: defaultSshRunner }),
      terminals: createProductionTerminalService({
        environments: store,
        refsPath: join(directory, "terminals.json"),
        log: (line) => process.stderr.write(`${line}\n`),
      }),
    };
  } catch (error) {
    process.stderr.write(`terminals are unavailable: ${describe(error)}\n`);
    return {
      environments: new InMemoryEnvironmentStore({ now: () => new Date().toISOString() }),
      terminals: createUnconfiguredTerminalComposition(),
    };
  }
}

/** Development and the visual fixture only: an explicit switch or an absent
 * `core.json`, never a fallback that could show a fake model in an installation
 * that configured real agents. */
function fakeAgents(): { runtime: MissionRuntime; catalog: AgentCatalog } {
  const registry = new FakeAdapterRegistry();
  const fakeRuntime = new MissionRuntime({
    databasePath: join(dataDir, "missions.db"),
    adapters: (kind: AgentKind) => registry.get(kind),
  });
  return {
    runtime: fakeRuntime,
    catalog: new AgentCatalog({ kinds: ["hermes"], describe: (kind) => registry.get(kind)?.describe() }),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
