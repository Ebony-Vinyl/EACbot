import { createFixture, environment, type Fixture as MissionFixture } from "../missions/fixture.ts";
import type { AgentKind } from "../../packages/agent-protocol/agents.ts";
import { mintScopedToken, TokenSigner, type ScopedTokenClaims } from "./scope.ts";
import { ToolService, type ToolServiceOptions } from "./tool-service.ts";
import type { ModelStatus, InstallStatus } from "./types.ts";

export const TEST_SECRET = "test-signing-secret-with-at-least-32-chars";

export interface Fixture {
  readonly missions: MissionFixture;
  readonly tools: ToolService;
  readonly signer: TokenSigner;
  /** Fixed wall clock for token lifetimes, so an expiry test moves it on purpose. */
  readonly wall: { readonly now: () => string; set(iso: string): void; advance(ms: number): void };
  token(overrides?: Partial<ScopedTokenClaims>): string;
  claims(overrides?: Partial<ScopedTokenClaims>): ScopedTokenClaims;
  close(): void;
}

export function createToolFixture(options: Partial<ToolServiceOptions> = {}): Fixture {
  const missions = createFixture();
  const signer = new TokenSigner(TEST_SECRET);
  let current = Date.parse("2026-03-01T00:00:00.000Z");
  const wall = {
    now: (): string => new Date(current).toISOString(),
    set(iso: string): void {
      current = Date.parse(iso);
    },
    advance(ms: number): void {
      current += ms;
    },
  };

  const claims = (overrides: Partial<ScopedTokenClaims> = {}): ScopedTokenClaims => ({
    v: 1,
    tokenId: "tok-1",
    ownerId: "owner-1",
    rootMissionIds: "all",
    readOnly: false,
    issuedAt: new Date(current).toISOString(),
    expiresAt: new Date(current + 3_600_000).toISOString(),
    ...overrides,
  });

  const tools = new ToolService({
    runtime: missions.runtime,
    signer,
    now: wall.now,
    ...options,
  });

  return {
    missions,
    tools,
    signer,
    wall,
    claims,
    token: (overrides = {}) => mintScopedToken(signer, claims(overrides)),
    close: () => missions.close(),
  };
}

export { environment };

export const HERMES_CAPABILITIES_PROBE = async (): Promise<ModelStatus> => ({
  state: "reported",
  models: [{ model: "hermes-3", label: "Hermes 3" }],
  defaultModel: "hermes-3",
});

export const installed = (version = "1.2.3"): InstallStatus => ({ state: "installed", version });

/** Creates a mission through the tool layer and returns its id, so a test that
 * needs one exercises the same path a caller does. */
export async function toolMission(
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
): Promise<{ missionId: string; runId: string }> {
  const outcome = await fixture.tools.call(
    "create_mission",
    {
      agent: "hermes",
      environment: environment(),
      brief: {
        objective: "summarise the build log",
        doneWhen: ["a summary exists"],
        permissionLevel: "read-only",
        source: { kind: "hermes" },
      },
      ...overrides,
    },
    fixture.claims(),
  );
  if (!outcome.ok) throw new Error(`create_mission failed: ${outcome.error.code} ${outcome.error.message}`);
  const data = outcome.data as { missionId: string; runId: string };
  return { missionId: data.missionId, runId: data.runId };
}

export function adapterOf(fixture: Fixture, agent: AgentKind = "hermes") {
  return fixture.missions.adapters.adapter(agent);
}
