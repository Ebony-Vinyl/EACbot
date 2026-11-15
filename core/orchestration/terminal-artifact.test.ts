import { afterEach, describe, expect, it } from "vitest";

import { adapterOf, createToolFixture, toolMission, type Fixture } from "./fixture.ts";
import { verifyTerminalTicket } from "./tickets.ts";

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture(options: Parameters<typeof createToolFixture>[0] = {}): Fixture {
  const created = createToolFixture(options);
  open.push(created);
  return created;
}

function revisionOf(f: Fixture, missionId: string): number {
  return f.missions.runtime.store.requireMission(missionId).revision;
}

describe("open_terminal asks for a stream, never opens one", () => {
  it("returns a ticket scoped to the mission, run and role", async () => {
    const f = fixture();
    const { missionId, runId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call("open_terminal", { missionId, role: "control" }, f.claims());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const data = outcome.data as { missionId: string; runId: string; role: string; kind: string; ticket: string };
    expect(data.missionId).toBe(missionId);
    expect(data.runId).toBe(runId);
    expect(data.role).toBe("control");
    expect(data.kind).toBe("nativeTui");

    const claims = verifyTerminalTicket(f.signer, data.ticket);
    expect(claims.missionId).toBe(missionId);
    expect(claims.runId).toBe(runId);
    expect(claims.role).toBe("control");
    expect(claims.terminalKind).toBe("nativeTui");
  });

  it("defaults to observing and to the engine's own TUI", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call("open_terminal", { missionId }, f.claims());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.data as { role: string }).role).toBe("observe");
    expect((outcome.data as { kind: string }).kind).toBe("nativeTui");
  });

  it("refuses a native TUI for an engine that has none", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1", agent: "custom" });
    const outcome = await f.tools.call("open_terminal", { missionId }, f.claims());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("unsupported");
  });

  it("allows a plain pty for an engine with no native TUI", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1", agent: "custom" });
    const outcome = await f.tools.call("open_terminal", { missionId, kind: "pty" }, f.claims());
    expect(outcome.ok).toBe(true);
  });

  it("refuses a role outside the two real ones", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call("open_terminal", { missionId, role: "admin" }, f.claims());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("invalid_arguments");
  });

  it("refuses an undeclared nested role, which is a grant, not a parameter", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call(
      "open_terminal",
      { missionId, kind: "pty", note: { role: "control" } },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("scope_from_arguments_refused");
  });

  it("refuses a run that belongs to another mission", async () => {
    const f = fixture();
    const mine = await toolMission(f, { commandId: "c1" });
    const theirs = await toolMission(f, { commandId: "c2" });
    const outcome = await f.tools.call("open_terminal", { missionId: mine.missionId, runId: theirs.runId }, f.claims());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("not_found");
  });

  it("refuses a ticket signed by another secret", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call("open_terminal", { missionId }, f.claims());
    if (!outcome.ok) throw new Error("open_terminal failed");
    const ticket = (outcome.data as { ticket: string }).ticket;
    const { TokenSigner } = await import("./scope.ts");
    const other = new TokenSigner("another-secret-value-long-enough-to-pass");
    expect(() => verifyTerminalTicket(other, ticket)).toThrow(/signature/);
  });

  it("gives the ticket a lifetime the caller can read", async () => {
    const f = fixture({ ticketTtlMs: 5_000 });
    const { missionId } = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call("open_terminal", { missionId }, f.claims());
    if (!outcome.ok) throw new Error("open_terminal failed");
    const data = outcome.data as { expiresAt: string; ticket: string };
    const claims = verifyTerminalTicket(f.signer, data.ticket);
    expect(Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt)).toBe(5_000);
  });
});

describe("get_artifact reads a reference, not a secret", () => {
  it("returns metadata for an artifact in scope", async () => {
    const f = fixture();
    const adapter = adapterOf(f);
    adapter.script({ artifact: { path: "/home/me/project/report.md", bytes: 42, mediaType: "text/markdown" } });
    const { missionId, runId } = await toolMission(f, { commandId: "c1" });
    adapter.finish(runId);

    const listed = await f.tools.call("mission_status", { missionId }, f.claims());
    expect(listed.ok).toBe(true);
    const artifacts = f.missions.runtime.records.artifactsFor(missionId);
    expect(artifacts).toHaveLength(1);

    const outcome = await f.tools.call("get_artifact", { artifactId: artifacts[0]!.id }, f.claims());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { path: string; bytes: number; mediaType: string };
    expect(data.path).toBe("/home/me/project/report.md");
    expect(data.bytes).toBe(42);
    expect(data.mediaType).toBe("text/markdown");
  });

  it("refuses an artifact that names a credential file", async () => {
    const f = fixture();
    const { missionId, runId } = await toolMission(f, { commandId: "c1" });
    f.missions.runtime.records.addArtifact({
      id: "artifact-secret",
      missionId,
      runId,
      kind: "file",
      path: "/home/me/.ssh/id_ed25519",
      mediaType: "text/plain",
      bytes: 10,
      createdAt: f.missions.clock.now(),
    });
    const outcome = await f.tools.call("get_artifact", { artifactId: "artifact-secret" }, f.claims());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("secret_refused");
  });

  it("refuses an artifact outside the credential's scope", async () => {
    const f = fixture();
    const mine = await toolMission(f, { commandId: "c1" });
    const theirs = await toolMission(f, { commandId: "c2" });
    f.missions.runtime.records.addArtifact({
      id: "artifact-theirs",
      missionId: theirs.missionId,
      runId: theirs.runId,
      kind: "file",
      path: "/home/me/theirs.txt",
      mediaType: "text/plain",
      bytes: 1,
      createdAt: f.missions.clock.now(),
    });
    const outcome = await f.tools.call("get_artifact", { artifactId: "artifact-theirs" }, f.claims({ rootMissionIds: [mine.missionId] }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("not_found");
  });

  it("refuses an artifact id that does not exist", async () => {
    const f = fixture();
    await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call("get_artifact", { artifactId: "artifact-invented" }, f.claims());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("not_found");
  });
});

describe("list_missions filters", () => {
  it("filters by status and honours the limit", async () => {
    const f = fixture();
    await toolMission(f, { commandId: "c1" });
    await toolMission(f, { commandId: "c2" });

    const limited = await f.tools.call("list_missions", { limit: 1 }, f.claims());
    expect(limited.ok).toBe(true);
    if (!limited.ok) return;
    const data = limited.data as { missions: unknown[]; truncated: boolean };
    expect(data.missions).toHaveLength(1);
    expect(data.truncated).toBe(true);

    const none = await f.tools.call("list_missions", { status: ["succeeded"] }, f.claims());
    expect(none.ok).toBe(true);
    if (none.ok) expect((none.data as { missions: unknown[] }).missions).toHaveLength(0);
  });

  it("refuses a root outside scope", async () => {
    const f = fixture();
    const mine = await toolMission(f, { commandId: "c1" });
    const theirs = await toolMission(f, { commandId: "c2" });
    const outcome = await f.tools.call(
      "list_missions",
      { rootMissionId: theirs.missionId },
      f.claims({ rootMissionIds: [mine.missionId] }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("scope_denied");
  });
});

describe("cancel cascade", () => {
  it("cancels children when cascade is not disabled", async () => {
    const f = fixture();
    const parent = await toolMission(f, { commandId: "c1" });
    const child = await f.tools.call(
      "create_mission",
      {
        commandId: "c2",
        agent: "hermes",
        environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
        parentMissionId: parent.missionId,
        brief: { objective: "child", doneWhen: ["x"], permissionLevel: "read-only", source: { kind: "mission" } },
      },
      f.claims(),
    );
    expect(child.ok).toBe(true);
    const childId = (child.data as { missionId: string }).missionId;

    const cancelled = await f.tools.call(
      "cancel_mission",
      { commandId: "c3", missionId: parent.missionId, expectedRevision: revisionOf(f, parent.missionId) },
      f.claims(),
    );
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect((cancelled.data as { affectedMissionIds: string[] }).affectedMissionIds).toContain(childId);
    expect(f.missions.runtime.store.requireMission(childId).status).toBe("cancelled");
  });

  it("leaves children alone when cascade is false", async () => {
    const f = fixture();
    const parent = await toolMission(f, { commandId: "c1" });
    const child = await f.tools.call(
      "create_mission",
      {
        commandId: "c2",
        agent: "hermes",
        environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
        parentMissionId: parent.missionId,
        brief: { objective: "child", doneWhen: ["x"], permissionLevel: "read-only", source: { kind: "mission" } },
      },
      f.claims(),
    );
    if (!child.ok) throw new Error("child create failed");
    const childId = (child.data as { missionId: string }).missionId;

    await f.tools.call(
      "cancel_mission",
      { commandId: "c3", missionId: parent.missionId, expectedRevision: revisionOf(f, parent.missionId), cascade: false },
      f.claims(),
    );
    expect(f.missions.runtime.store.requireMission(childId).status).not.toBe("cancelled");
  });
});
