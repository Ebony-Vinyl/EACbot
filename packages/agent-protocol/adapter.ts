/** The contract every native agent transport implements. It reports only
 * structured events; a terminal it opens reports terminal status separately. */
import type { AgentDescriptor, AgentKind } from "./agents.ts";
import type { AdapterEvent } from "./events.ts";
import type { ModelRef } from "./agents.ts";

export interface AdapterStartRequest {
  readonly missionId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly model?: ModelRef;
  readonly environmentId: string;
  readonly resumeFromSessionId?: string;
  readonly resumeOfRunId?: string;
  readonly attempt: number;
}

export interface AdapterHandle {
  readonly runId: string;
  readonly nativeSessionId?: string;
}

export interface AdapterSink {
  emit(event: AdapterEvent): void;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  describe(): AgentDescriptor;
  start(request: AdapterStartRequest, sink: AdapterSink): Promise<AdapterHandle>;
  steer(runId: string, input: string, commandId: string): Promise<{ accepted: boolean; reason?: string }>;
  interrupt(runId: string, reason?: string): Promise<{ resumable: boolean }>;
  resume(request: AdapterStartRequest, sink: AdapterSink): Promise<AdapterHandle>;
  cancel(runId: string, reason?: string): Promise<void>;
  dispose?(): Promise<void>;
}

export interface AdapterRegistry {
  get(kind: AgentKind): AgentAdapter | undefined;
  list(): readonly AgentAdapter[];
}
