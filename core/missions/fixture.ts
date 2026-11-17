import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentKind } from "../../packages/agent-protocol/agents.ts";
import type { MissionCommand } from "../../packages/agent-protocol/commands.ts";
import type { EnvironmentRef } from "../../packages/agent-protocol/environment.ts";
import { FakeAdapterRegistry } from "./fake-registry.ts";
import { MissionRuntime } from "./runtime.ts";

export interface Fixture {
  readonly runtime: MissionRuntime;
  readonly adapters: FakeAdapterRegistry;
  readonly dir: string;
  readonly clock: TestClock;
  close(): void;
}

/** A monotonic clock so revision and timestamp assertions are stable. */
export class TestClock {
  private millis = Date.parse("2026-01-01T00:00:00.000Z");

  now = (): string => {
    this.millis += 1000;
    return new Date(this.millis).toISOString();
  };

  peek(): string {
    return new Date(this.millis).toISOString();
  }
}

export const environment = (overrides: Partial<EnvironmentRef> = {}): EnvironmentRef => ({
  id: "env-1",
  label: "test computer",
  kind: "ssh",
  host: "127.0.0.1",
  user: "tester",
  authMode: "subscription",
  ...overrides,
});

let counter = 0;
export const commandId = (label = "cmd"): string => `${label}-${++counter}`;

export function createFixture(databasePath?: string): Fixture {
  const dir = databasePath ? join(databasePath, "..") : mkdtempSync(join(tmpdir(), "eac-missions-"));
  const adapters = new FakeAdapterRegistry();
  const clock = new TestClock();
  const runtime = new MissionRuntime({
    databasePath: databasePath ?? join(dir, "missions.db"),
    adapters: (kind: AgentKind) => adapters.get(kind),
    now: clock.now,
  });
  return {
    runtime,
    adapters,
    dir,
    clock,
    close: () => {
      runtime.close();
      if (!databasePath) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function createMission(
  fixture: Pick<Fixture, "runtime">,
  overrides: Partial<Extract<MissionCommand, { type: "mission.create" }>> = {},
): Promise<string> {
  const result = await fixture.runtime.execute({
    type: "mission.create",
    commandId: commandId("create"),
    title: "demo mission",
    prompt: "do the thing",
    agent: "hermes",
    environment: environment(),
    ...overrides,
  });
  return result.missionId;
}
