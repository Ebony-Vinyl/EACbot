import type { AgentAdapter } from "../../packages/agent-protocol/adapter.ts";
import type { AgentKind } from "../../packages/agent-protocol/agents.ts";
import { capabilitiesFor } from "./capabilities.ts";
import { FakeAdapter, type FakeRunScript } from "./fake-adapter.ts";

/** Holds one fake per agent kind so a test can script a run and still receive
 * the adapter events it wants. */
export class FakeAdapterRegistry {
  private readonly adapters = new Map<AgentKind, FakeAdapter>();

  get(kind: AgentKind): AgentAdapter | undefined {
    return this.adapter(kind);
  }

  adapter(kind: AgentKind = "hermes"): FakeAdapter {
    const existing = this.adapters.get(kind);
    if (existing) return existing;
    const created = new FakeAdapter(kind);
    this.adapters.set(kind, created);
    return created;
  }

  list(): readonly AgentAdapter[] {
    return [...this.adapters.values()];
  }

  capabilitiesFor(kind: AgentKind) {
    return capabilitiesFor(kind);
  }

  /** Starts a mission's run on the fake and returns both handles. */
  async start(
    kind: AgentKind,
    request: {
      missionId: string;
      runId: string;
      prompt: string;
      environmentId: string;
      attempt: number;
      resumeFromSessionId?: string;
    },
    sink: { emit(event: import("../../packages/agent-protocol/events.ts").AdapterEvent): void },
    script?: FakeRunScript,
  ) {
    const adapter = this.adapter(kind);
    if (script) adapter.script(script);
    return adapter.start(
      {
        missionId: request.missionId,
        runId: request.runId,
        prompt: request.prompt,
        environmentId: request.environmentId,
        attempt: request.attempt,
        ...(request.resumeFromSessionId !== undefined ? { resumeFromSessionId: request.resumeFromSessionId } : {}),
      },
      sink,
    );
  }
}
