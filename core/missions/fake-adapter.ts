import { randomUUID } from "node:crypto";

import type { AgentAdapter, AdapterHandle, AdapterStartRequest, AdapterSink } from "../../packages/agent-protocol/adapter.ts";
import type { AgentDescriptor, AgentKind, ModelCatalogEntry } from "../../packages/agent-protocol/agents.ts";
import type { AdapterEvent } from "../../packages/agent-protocol/events.ts";
import { capabilitiesFor } from "./capabilities.ts";

export interface FakeRunScript {
  readonly output?: readonly string[];
  readonly waitingForInput?: boolean;
  readonly artifact?: { path: string; bytes: number; mediaType: string };
  readonly approval?: { action: string; detail: string };
  readonly failWith?: { code: string; message: string };
}

/** A native agent that never touches a model. `start` records the script and
 * emits `run.started`; `finish` drives the rest, so a test decides when a run
 * advances and can interrupt or steer one that is still live. */
export class FakeAdapter implements AgentAdapter {
  readonly kind: AgentKind;
  private readonly sinkByRun = new Map<string, AdapterSink>();
  private readonly missionByRun = new Map<string, string>();
  private readonly sessionByRun = new Map<string, string>();
  private readonly scriptByRun = new Map<string, FakeRunScript>();
  private readonly seqByRun = new Map<string, number>();
  private readonly finished = new Set<string>();
  private nextScript: FakeRunScript | undefined;
  readonly interrupts: string[] = [];
  readonly steers: { runId: string; input: string; commandId: string }[] = [];
  readonly cancelled: string[] = [];

  constructor(kind: AgentKind = "hermes") {
    this.kind = kind;
  }

  describe(): AgentDescriptor {
    return {
      kind: this.kind,
      label: this.kind,
      authModes: ["subscription", "apiKey", "compatibleEndpoint", "local"],
      capabilities: capabilitiesFor(this.kind),
      models: this.models(),
    };
  }

  models(): ModelCatalogEntry[] {
    return [{ ref: { agent: this.kind, model: "fake-1", label: "Fake 1" } }];
  }

  /** The script the next `start` uses. */
  script(script: FakeRunScript): this {
    this.nextScript = script;
    return this;
  }

  async start(request: AdapterStartRequest, sink: AdapterSink): Promise<AdapterHandle> {
    return this.begin(request, sink);
  }

  async resume(request: AdapterStartRequest, sink: AdapterSink): Promise<AdapterHandle> {
    const handle = this.begin(request, sink);
    this.emitFor(handle.runId, {
      type: "run.resumed",
      nativeSessionId: request.resumeFromSessionId ?? handle.nativeSessionId ?? "session",
      fromRunId: request.resumeOfRunId ?? request.runId,
    });
    return handle;
  }

  async steer(runId: string, input: string, commandId: string): Promise<{ accepted: boolean; reason?: string }> {
    this.steers.push({ runId, input, commandId });
    this.emitFor(runId, { type: "run.steer_acknowledged", commandId, accepted: true });
    return { accepted: true };
  }

  async interrupt(runId: string, reason?: string): Promise<{ resumable: boolean }> {
    this.interrupts.push(runId);
    this.emitFor(runId, { type: "run.interrupted", resumable: true, ...(reason !== undefined ? { reason } : {}) });
    return { resumable: true };
  }

  async cancel(runId: string, reason?: string): Promise<void> {
    this.cancelled.push(runId);
    this.emitFor(runId, { type: "run.cancelled", ...(reason !== undefined ? { reason } : {}) });
  }

  /** Drives a started run to its scripted end. A second call is a no-op, so a
   * test can prove a duplicate event changes nothing. */
  finish(runId: string): void {
    if (this.finished.has(runId)) return;
    this.finished.add(runId);
    const script = this.scriptByRun.get(runId) ?? {};
    for (const text of script.output ?? []) {
      this.emitFor(runId, { type: "run.output", text, stream: "assistant" });
    }
    if (script.approval) {
      this.emitFor(runId, {
        type: "run.approval_requested",
        approvalId: `approval-${runId}`,
        action: script.approval.action,
        detail: script.approval.detail,
      });
    }
    if (script.artifact) {
      this.emitFor(runId, {
        type: "run.artifact",
        artifactId: `artifact-${runId}`,
        path: script.artifact.path,
        bytes: script.artifact.bytes,
        mediaType: script.artifact.mediaType,
      });
    }
    if (script.waitingForInput) {
      this.emitFor(runId, { type: "run.waiting_input", question: "continue?" });
      return;
    }
    if (script.failWith) {
      this.emitFor(runId, { type: "run.failed", code: script.failWith.code, message: script.failWith.message });
      return;
    }
    this.emitFor(runId, { type: "run.completed", outcome: "succeeded" });
  }

  /** Delivers an event with an explicit sequence, for out-of-order and
   * duplicate tests. */
  emitRaw(runId: string, seq: number, type: AdapterEvent["type"], extra: Record<string, unknown> = {}): AdapterEvent {
    const sink = this.sinkByRun.get(runId);
    const missionId = this.missionByRun.get(runId);
    if (!sink || !missionId) throw new Error(`no started run ${runId}`);
    const event = {
      source: "adapter",
      type,
      eventId: `evt-${runId}-${seq}`,
      seq,
      missionId,
      runId,
      at: new Date().toISOString(),
      ...extra,
    } as unknown as AdapterEvent;
    sink.emit(event);
    return event;
  }

  sessionOf(runId: string): string | undefined {
    return this.sessionByRun.get(runId);
  }

  private begin(request: AdapterStartRequest, sink: AdapterSink): AdapterHandle {
    const nativeSessionId = request.resumeFromSessionId ?? `fake-session-${randomUUID()}`;
    this.sinkByRun.set(request.runId, sink);
    this.missionByRun.set(request.runId, request.missionId);
    this.sessionByRun.set(request.runId, nativeSessionId);
    this.scriptByRun.set(request.runId, this.nextScript ?? {});
    this.nextScript = undefined;
    this.seqByRun.set(request.runId, 0);
    this.emitFor(request.runId, { type: "run.started", nativeSessionId });
    return { runId: request.runId, nativeSessionId };
  }

  private emitFor(runId: string, payload: Record<string, unknown> & { type: AdapterEvent["type"] }): void {
    const sink = this.sinkByRun.get(runId);
    const missionId = this.missionByRun.get(runId);
    if (!sink || !missionId) return;
    const seq = (this.seqByRun.get(runId) ?? 0) + 1;
    this.seqByRun.set(runId, seq);
    const event = {
      source: "adapter",
      eventId: `evt-${runId}-${seq}`,
      seq,
      missionId,
      runId,
      at: new Date().toISOString(),
      ...payload,
    } as unknown as AdapterEvent;
    sink.emit(event);
  }
}
