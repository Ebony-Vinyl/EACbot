import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentKind } from "../../packages/agent-protocol/agents.ts";
import { agentKindOf, CoreAgentBridge, coreAgentId, fromCoreModel, toCoreModel } from "./bridge.ts";
import { FakeCoreAdapter, type FakeCoreScript } from "./fake-core-adapter.ts";
import { FakeAdapterRegistry } from "./fake-registry.ts";
import { TestClock, commandId, createMission, environment } from "./fixture.ts";
import { MissionRuntime } from "./runtime.ts";

const open: Array<{ cleanup(): void }> = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.cleanup();
});

/** A runtime wired to the real core/agents contract through the bridge. */
function bridgedRuntime(options: { databasePath?: string; agent?: AgentKind; script?: FakeCoreScript; createError?: Error } = {}) {
  const dir = options.databasePath ? join(options.databasePath, "..") : mkdtempSync(join(tmpdir(), "eac-bridge-"));
  const agent = options.agent ?? "hermes";
  const core = new FakeCoreAdapter(agent);
  if (options.script) core.next(options.script);
  if (options.createError) core.failCreateWith(options.createError);
  const bridge = new CoreAgentBridge({ adapter: core, kind: agent, cwd: "/tmp/work" });
  const clock = new TestClock();
  const runtime = new MissionRuntime({
    databasePath: options.databasePath ?? join(dir, "missions.db"),
    adapters: (kind: AgentKind) => (kind === agent ? bridge : undefined),
    now: clock.now,
  });
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      runtime.close();
    } catch {
      // A test may have closed the runtime itself; the file is gone either way.
    }
    if (!options.databasePath) rmSync(dir, { recursive: true, force: true });
  };
  const handle = { runtime, core, bridge, clock, dir, cleanup };
  open.push(handle);
  return handle;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("the core/agents bridge", () => {
  it("maps the protocol kind onto core/agents' own id without a lookup table", () => {
    const kinds: AgentKind[] = ["hermes", "claudeCode", "codex", "openCode", "pi", "ohMyPi", "custom"];
    for (const kind of kinds) {
      expect(coreAgentId(kind)).toBe(kind);
      expect(agentKindOf(coreAgentId(kind))).toBe(kind);
    }
  });

  it("splits and rejoins a model ref the engine can read", () => {
    expect(toCoreModel({ agent: "hermes", model: "openrouter/qwen/qwen3" })).toEqual({ providerId: "openrouter", modelId: "qwen/qwen3" });
    expect(toCoreModel({ agent: "codex", model: "gpt-5" })).toEqual({ providerId: "codex", modelId: "gpt-5" });
    expect(toCoreModel(undefined)).toBeUndefined();
    expect(fromCoreModel({ providerId: "anthropic", modelId: "sonnet" }, "claudeCode")).toEqual({ agent: "claudeCode", model: "anthropic/sonnet" });
    expect(fromCoreModel(null, "hermes")).toBeUndefined();
  });

  it("starts a session, streams its events, and settles the mission", async () => {
    const f = bridgedRuntime({ script: { deltas: ["hello", " world"], complete: true } });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();

    const mission = f.runtime.store.requireMission(missionId);
    expect(mission.status).toBe("succeeded");
    const run = f.runtime.store.requireRun(mission.activeRunId ?? mission.runIds[0]!);
    expect(run.nativeSessionId).toBe(`native-${run.id}`);
    expect(run.nativeStartedAt).toBeDefined();
    expect(run.nativeOutcome).toBe("succeeded");

    const outputs = f.runtime.log.events(missionId).filter((entry) => entry.type === "run.output");
    expect(outputs.map((entry) => (entry.payload as { text: string }).text)).toEqual(["hello", " world"]);

  });

  it("records the engine's own native id from session.started, distinct from the run id", async () => {
    const f = bridgedRuntime({ script: { complete: true } });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();
    const runId = f.runtime.store.requireMission(missionId).runIds[0]!;
    const run = f.runtime.store.requireRun(runId);
    expect(run.nativeSessionId).toBe(`native-${runId}`);
    expect(run.nativeSessionId).not.toBe(run.id);

  });

  it("passes the caller's run id as the core session id and the prompt through", async () => {
    const f = bridgedRuntime({ script: { complete: true } });
    const missionId = await createMission(f, { agent: "hermes", prompt: "do the thing" });
    await settle();
    const runId = f.runtime.store.requireMission(missionId).runIds[0]!;
    expect(f.core.inputs[0]!.sessionId).toBe(runId);
    expect(f.core.inputs[0]!.prompt).toBe("do the thing");
    expect(f.core.inputs[0]!.cwd).toBe("/tmp/work");

  });

  it("records a typed failure when create throws, leaving nothing running", async () => {
    const f = bridgedRuntime({ createError: new Error("engine is not installed") });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();

    const mission = f.runtime.store.requireMission(missionId);
    expect(mission.status).toBe("failed");
    expect(mission.settledAt).toBeDefined();
    expect(mission.error?.code).toBe("native_start_failed");
    expect(mission.error?.message).toBe("engine is not installed");

    const run = f.runtime.store.requireRun(mission.runIds[0]!);
    expect(run.status).toBe("failed");
    expect(run.nativeOutcome).toBe("failed");
    expect(run.nativeCompletedAt).toBeDefined();
    expect(run.error?.code).toBe("native_start_failed");
    expect(f.runtime.log.events(missionId).some((entry) => entry.type === "run.start_failed")).toBe(true);
    expect(f.runtime.recover().openMissions).toHaveLength(0);

  });

  it("steers through the core session and acknowledges the command", async () => {
    const f = bridgedRuntime({ script: { holdOpen: true } });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();
    const session = f.core.lastSession();

    await f.runtime.execute({
      type: "run.steer",
      commandId: commandId("steer"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
      input: "also add tests",
    });
    expect(session.steers).toEqual(["also add tests"]);

  });

  it("maps the three steer outcomes onto accepted or a recorded refusal", async () => {
    const f = bridgedRuntime({ script: { holdOpen: true } });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();
    const runId = f.runtime.store.requireMission(missionId).runIds[0]!;

    const session = f.core.lastSession();
    session.steer = async () => "refused";
    await f.runtime.execute({
      type: "run.steer",
      commandId: commandId("refused"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
      input: "nope",
    });
    expect(f.runtime.log.events(missionId).some((entry) => entry.type === "run.steer_refused")).toBe(true);
    expect(f.runtime.store.requireRun(runId).status).not.toBe("succeeded");

  });

  it("interrupts through the core session and keeps the run resumable", async () => {
    const f = bridgedRuntime({ script: { holdOpen: true } });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();
    const runId = f.runtime.store.requireMission(missionId).runIds[0]!;

    await f.runtime.execute({
      type: "run.interrupt",
      commandId: commandId("interrupt"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });
    expect(f.core.lastSession().interrupts).toBe(1);
    const run = f.runtime.store.requireRun(runId);
    expect(run.status).toBe("interrupted");
    expect(run.nativeSessionId).toBe(`native-${runId}`);
    expect(run.controlPending).toBeUndefined();
    expect(f.runtime.store.requireMission(missionId).status).toBe("interrupted");

  });

  it("resumes by handing the engine its own cursor back", async () => {
    const f = bridgedRuntime({ script: { holdOpen: true } });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();
    const firstRunId = f.runtime.store.requireMission(missionId).runIds[0]!;

    await f.runtime.execute({
      type: "run.interrupt",
      commandId: commandId("i"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });
    const resumed = await f.runtime.execute({
      type: "mission.resume",
      commandId: commandId("resume"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });
    await settle();

    const created = f.core.inputs.at(-1)!;
    expect(created.resumeCursor).toBe(`native-${firstRunId}`);
    const newRun = f.runtime.store.requireRun(resumed.runId!);
    expect(newRun.resumeOfRunId).toBe(firstRunId);
    expect(newRun.nativeSessionId).toBe(`native-${firstRunId}`);
    expect(f.runtime.store.requireMission(missionId).status).toBe("running");

  });

  it("cancels through the core session and closes it", async () => {
    const f = bridgedRuntime({ script: { holdOpen: true } });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();
    const session = f.core.lastSession();

    await f.runtime.execute({
      type: "mission.cancel",
      commandId: commandId("cancel"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
      reason: "user stopped it",
    });
    expect(session.cancels).toBe(1);
    const run = f.runtime.store.requireRun(f.runtime.store.requireMission(missionId).runIds[0]!);
    expect(run.status).toBe("cancelled");
    expect(run.controlPending).toBeUndefined();
    expect(f.runtime.store.requireMission(missionId).status).toBe("cancelled");

  });

  it("records a pending cancellation when the native cancel fails, and recovery reports it", async () => {
    const f = bridgedRuntime({ script: { holdOpen: true } });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();
    const session = f.core.lastSession();
    session.cancel = async () => {
      throw new Error("native session already gone");
    };

    await f.runtime.execute({
      type: "mission.cancel",
      commandId: commandId("cancel"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });

    const run = f.runtime.store.requireRun(f.runtime.store.requireMission(missionId).runIds[0]!);
    expect(run.controlPending).toBe("cancel");
    expect(run.cancelAcceptedAt).toBeDefined();
    expect(run.reconcileRequiredAt).toBeDefined();
    expect(f.runtime.log.events(missionId).some((entry) => entry.type === "run.control_pending")).toBe(true);

  });

  it("reports a pending cancellation after a restart instead of forgetting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-bridge-restart-"));
    const path = join(dir, "missions.db");
    const first = bridgedRuntime({ databasePath: path, script: { holdOpen: true } });
    const missionId = await createMission(first, { agent: "hermes" });
    await settle();
    first.core.lastSession().cancel = async () => {
      throw new Error("native session already gone");
    };
    await first.runtime.execute({
      type: "mission.cancel",
      commandId: commandId("cancel"),
      missionId,
      expectedRevision: first.runtime.store.requireMission(missionId).revision,
    });
    first.runtime.close();

    const core = new FakeCoreAdapter("hermes");
    const bridge = new CoreAgentBridge({ adapter: core, kind: "hermes" });
    const clock = new TestClock();
    const second = new MissionRuntime({ databasePath: path, adapters: (kind) => (kind === "hermes" ? bridge : undefined), now: clock.now });
    const report = second.recover();
    expect(report.limboRuns.map((entry) => entry.reason)).toContain("cancellation_pending");
    const pending = report.limboRuns.find((entry) => entry.reason === "cancellation_pending")!;
    expect(pending.allowedActions).toEqual(["cancel", "abandon"]);
    expect(pending.run.controlPending).toBe("cancel");

    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("retries a pending cancellation only when a caller asks for it", async () => {
    const f = bridgedRuntime({ script: { holdOpen: true } });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();
    const session = f.core.lastSession();
    session.cancel = async () => {
      throw new Error("transient");
    };
    await f.runtime.execute({
      type: "mission.cancel",
      commandId: commandId("cancel"),
      missionId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
    });
    const runId = f.runtime.store.requireMission(missionId).runIds[0]!;
    expect(f.runtime.store.requireRun(runId).controlPending).toBe("cancel");

    await f.runtime.execute({
      type: "run.reconcile",
      commandId: commandId("retry-cancel"),
      missionId,
      runId,
      expectedRevision: f.runtime.store.requireMission(missionId).revision,
      action: "cancel",
      reason: "retried after restart",
    });
    expect(f.runtime.store.requireRun(runId).controlPending).toBeUndefined();
    expect(f.runtime.store.requireRun(runId).status).toBe("cancelled");

  });

  it("never replays an unstarted run on its own after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-bridge-unstarted-"));
    const path = join(dir, "missions.db");
    const clock = new TestClock();
    const registry = new FakeAdapterRegistry();
    const first = new MissionRuntime({ databasePath: path, adapters: (kind) => registry.get(kind), now: clock.now });
    const created = await first.execute({
      type: "mission.create",
      commandId: "create-1",
      title: "never started",
      prompt: "go",
      agent: "hermes",
      environment: environment(),
    });
    // A run the authority accepted but never launched, as a crash before start leaves it.
    first.store.updateRun(first.store.requireMission(created.missionId).runIds[0]!, { status: "accepted", nativeStartedAt: undefined });
    first.close();

    const core = new FakeCoreAdapter("hermes");
    const bridge = new CoreAgentBridge({ adapter: core, kind: "hermes" });
    const second = new MissionRuntime({ databasePath: path, adapters: (kind) => (kind === "hermes" ? bridge : undefined), now: clock.now });
    const report = second.recover();
    expect(report.unstartedRuns).toHaveLength(1);
    expect(report.limboRuns.find((entry) => entry.reason === "unstarted")?.allowedActions).toEqual(["start", "abandon"]);
    expect(core.sessions).toHaveLength(0);
    expect(core.inputs).toHaveLength(0);

    const started = await second.execute({
      type: "run.reconcile",
      commandId: "reconcile-start",
      missionId: created.missionId,
      runId: report.unstartedRuns[0]!.id,
      expectedRevision: second.store.requireMission(created.missionId).revision,
      action: "start",
    });
    await settle();
    expect(core.inputs).toHaveLength(1);
    expect(started.replayed).toBe(false);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("abandons a limbo run as a typed failure instead of leaving it open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-bridge-abandon-"));
    const path = join(dir, "missions.db");
    const clock = new TestClock();
    const registry = new FakeAdapterRegistry();
    const first = new MissionRuntime({ databasePath: path, adapters: (kind) => registry.get(kind), now: clock.now });
    const created = await first.execute({
      type: "mission.create",
      commandId: "create-1",
      title: "abandon me",
      prompt: "go",
      agent: "hermes",
      environment: environment(),
    });
    const runId = first.store.requireMission(created.missionId).runIds[0]!;
    first.store.updateRun(runId, { status: "accepted", nativeStartedAt: undefined });
    first.close();

    const core = new FakeCoreAdapter("hermes");
    const bridge = new CoreAgentBridge({ adapter: core, kind: "hermes" });
    const second = new MissionRuntime({ databasePath: path, adapters: (kind) => (kind === "hermes" ? bridge : undefined), now: clock.now });
    await second.execute({
      type: "run.reconcile",
      commandId: "abandon",
      missionId: created.missionId,
      runId,
      expectedRevision: second.store.requireMission(created.missionId).revision,
      action: "abandon",
      reason: "the environment is gone",
    });
    const run = second.store.requireRun(runId);
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("abandoned_after_restart");
    expect(second.store.requireMission(created.missionId).status).toBe("failed");
    expect(core.inputs).toHaveLength(0);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records an approval the engine raises and answers it through the bridge", async () => {
    const f = bridgedRuntime({
      script: { approval: { requestId: "req-1", title: "write file", detail: "src/app.ts" }, complete: true },
    });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();
    const approvals = f.runtime.records.approvalsFor(missionId);
    expect(approvals.map((approval) => approval.action)).toEqual(["write file"]);
    expect(approvals[0]!.status).toBe("pending");

  });

  it("fails the run when the event stream itself breaks", async () => {
    const f = bridgedRuntime({ script: { breakStream: "stream broke" } });
    const missionId = await createMission(f, { agent: "hermes" });
    await settle();

    expect(f.runtime.log.events(missionId).some((entry) => entry.type === "run.failed")).toBe(true);
    const run = f.runtime.store.requireRun(f.runtime.store.requireMission(missionId).runIds[0]!);
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("event_stream_failed");
    expect(f.runtime.store.requireMission(missionId).status).toBe("failed");

  });

  it("keeps the durable record when the process dies mid-run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-bridge-crash-"));
    const path = join(dir, "missions.db");
    const first = bridgedRuntime({ databasePath: path, script: { holdOpen: true } });
    const missionId = await createMission(first, { agent: "hermes" });
    await settle();
    first.core.lastSession().settle({ deltas: ["partial"], complete: true });
    await settle();
    first.runtime.close();

    const core = new FakeCoreAdapter("hermes");
    const bridge = new CoreAgentBridge({ adapter: core, kind: "hermes" });
    const clock = new TestClock();
    const second = new MissionRuntime({ databasePath: path, adapters: (kind) => (kind === "hermes" ? bridge : undefined), now: clock.now });
    const read = second.readTree(missionId);
    expect(read.tree?.mission.id).toBe(missionId);
    expect(read.events.some((entry) => entry.type === "run.output")).toBe(true);
    expect(core.sessions).toHaveLength(0);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
