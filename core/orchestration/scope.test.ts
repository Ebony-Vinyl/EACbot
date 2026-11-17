import { afterEach, describe, expect, it } from "vitest";

import { mintScopedToken, TokenSigner, verifyScopedToken, isSecretBearingPath } from "./scope.ts";
import { TEST_SECRET, createToolFixture, toolMission, type Fixture } from "./fixture.ts";

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture(options: Parameters<typeof createToolFixture>[0] = {}): Fixture {
  const created = createToolFixture(options);
  open.push(created);
  return created;
}

describe("scoped tokens", () => {
  it("round-trips claims this server minted", () => {
    const signer = new TokenSigner(TEST_SECRET);
    const token = mintScopedToken(signer, {
      v: 1,
      tokenId: "t1",
      ownerId: "o1",
      rootMissionIds: ["m1"],
      readOnly: true,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });
    const claims = verifyScopedToken(signer, token, () => "2026-01-01T00:30:00.000Z");
    expect(claims.ownerId).toBe("o1");
    expect(claims.rootMissionIds).toEqual(["m1"]);
    expect(claims.readOnly).toBe(true);
  });

  it("refuses a token signed with another secret", () => {
    const minted = new TokenSigner(TEST_SECRET);
    const other = new TokenSigner("a-completely-different-secret-value-32chars");
    const token = mintScopedToken(minted, {
      v: 1,
      tokenId: "t1",
      ownerId: "o1",
      rootMissionIds: "all",
      readOnly: false,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });
    expect(() => verifyScopedToken(other, token, () => "2026-01-01T00:30:00.000Z")).toThrow(/signature/);
  });

  it("refuses an expired token and a token from the future", () => {
    const signer = new TokenSigner(TEST_SECRET);
    const token = mintScopedToken(signer, {
      v: 1,
      tokenId: "t1",
      ownerId: "o1",
      rootMissionIds: "all",
      readOnly: false,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });
    expect(() => verifyScopedToken(signer, token, () => "2026-01-01T02:00:00.000Z")).toThrow(/expired/);
    expect(() => verifyScopedToken(signer, token, () => "2025-12-31T00:00:00.000Z")).toThrow(/not valid yet/);
  });

  it("refuses a payload edited after signing", () => {
    const signer = new TokenSigner(TEST_SECRET);
    const token = mintScopedToken(signer, {
      v: 1,
      tokenId: "t1",
      ownerId: "o1",
      rootMissionIds: ["m1"],
      readOnly: true,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });
    const [prefix, , mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        tokenId: "t1",
        ownerId: "o1",
        rootMissionIds: "all",
        readOnly: false,
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2030-01-01T01:00:00.000Z",
      }),
    ).toString("base64url");
    expect(() => verifyScopedToken(signer, `${prefix}.${forged}.${mac}`, () => "2026-01-01T00:30:00.000Z")).toThrow();
  });

  it("refuses a secret too short to be one", () => {
    expect(() => new TokenSigner("short")).toThrow(/32/);
  });
});

describe("the service verifies a token itself", () => {
  it("refuses an expired token at the service boundary", async () => {
    const f = fixture();
    const token = f.token({ expiresAt: new Date(Date.parse(f.wall.now()) + 1_000).toISOString() });
    f.wall.advance(120_000);
    const outcome = await f.tools.callWithToken("list_missions", {}, token);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("unauthenticated");
  });

  it("refuses a forged token at the service boundary", async () => {
    const f = fixture();
    const outcome = await f.tools.callWithToken("list_missions", {}, "v1.eyJ2IjoxfQ.forged");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("unauthenticated");
  });

  it("runs the call when the token verifies", async () => {
    const f = fixture();
    const outcome = await f.tools.callWithToken("list_agents", { agents: ["hermes"] }, f.token());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect((outcome.data as { agents: unknown[] }).agents).toHaveLength(1);
  });
});

describe("mission scope", () => {
  it("refuses a mission outside the credential's trees", async () => {
    const f = fixture();
    const mine = await toolMission(f, { commandId: "c1" });
    const theirs = await toolMission(f, { commandId: "c2" });

    const scoped = f.claims({ rootMissionIds: [mine.missionId] });
    const allowed = await f.tools.call("mission_status", { missionId: mine.missionId }, scoped);
    expect(allowed.ok).toBe(true);

    const denied = await f.tools.call("mission_status", { missionId: theirs.missionId }, scoped);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("scope_denied");
  });

  it("hides other trees from list_missions", async () => {
    const f = fixture();
    const mine = await toolMission(f, { commandId: "c1" });
    await toolMission(f, { commandId: "c2" });

    const listed = await f.tools.call("list_missions", {}, f.claims({ rootMissionIds: [mine.missionId] }));
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const data = listed.data as { missions: { id: string }[] };
      expect(data.missions.map((mission) => mission.id)).toEqual([mine.missionId]);
    }
  });

  it("refuses to open a new mission tree from a tree-scoped credential", async () => {
    const f = fixture();
    const mine = await toolMission(f, { commandId: "c1" });
    const outcome = await f.tools.call(
      "create_mission",
      {
        commandId: "c2",
        agent: "hermes",
        environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
        brief: {
          objective: "another tree",
          doneWhen: ["done"],
          permissionLevel: "read-only",
          source: { kind: "owner" },
        },
      },
      f.claims({ rootMissionIds: [mine.missionId] }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("scope_denied");
  });

  it("allows a delegation under a mission in scope", async () => {
    const f = fixture();
    const parent = await toolMission(f, { commandId: "c1" });
    const child = await f.tools.call(
      "create_mission",
      {
        commandId: "c2",
        agent: "hermes",
        environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
        parentMissionId: parent.missionId,
        brief: {
          objective: "the sub task",
          doneWhen: ["the sub task is done"],
          permissionLevel: "read-only",
          source: { kind: "mission", ref: parent.missionId },
        },
      },
      f.claims({ rootMissionIds: [parent.missionId] }),
    );
    expect(child.ok).toBe(true);
    if (child.ok) {
      const created = f.missions.runtime.store.requireMission((child.data as { missionId: string }).missionId);
      expect(created.rootMissionId).toBe(parent.missionId);
    }
  });

  it("refuses a cancel whose cascade would leave scope", async () => {
    const f = fixture();
    const parent = await toolMission(f, { commandId: "c1" });
    await f.tools.call(
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
    const other = await toolMission(f, { commandId: "c3" });

    const denied = await f.tools.call(
      "cancel_mission",
      { commandId: "c4", missionId: parent.missionId, expectedRevision: 1 },
      f.claims({ rootMissionIds: [other.missionId] }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("scope_denied");
  });
});

describe("read-only credentials", () => {
  it("may read but may not mutate", async () => {
    const f = fixture();
    const mission = await toolMission(f, { commandId: "c1" });
    const readOnly = f.claims({ readOnly: true });

    const status = await f.tools.call("mission_status", { missionId: mission.missionId }, readOnly);
    expect(status.ok).toBe(true);

    const steer = await f.tools.call(
      "steer_run",
      { commandId: "c2", missionId: mission.missionId, expectedRevision: 1, input: "go" },
      readOnly,
    );
    expect(steer.ok).toBe(false);
    if (!steer.ok) expect(steer.error.code).toBe("read_only");
  });

  it("refuses every mutating tool before reading its arguments", async () => {
    const f = fixture();
    const readOnly = f.claims({ readOnly: true });
    const mutating = ["create_mission", "steer_run", "interrupt_run", "resume_mission", "cancel_mission", "answer_approval", "open_terminal"];
    for (const tool of mutating) {
      const outcome = await f.tools.call(tool, {}, readOnly);
      expect(outcome.ok, tool).toBe(false);
      if (!outcome.ok) expect(outcome.error.code, tool).toBe("read_only");
    }
  });
});

describe("authority cannot arrive as arguments", () => {
  it("refuses a call that supplies its own token", async () => {
    const f = fixture();
    const outcome = await f.tools.call("list_missions", { token: f.token() }, f.claims());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("scope_from_arguments_refused");
  });

  it("refuses nested authority fields", async () => {
    const f = fixture();
    const outcome = await f.tools.call(
      "list_missions",
      { filter: { scope: { rootMissionIds: "all" } } },
      f.claims({ rootMissionIds: ["only-this"] }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("scope_from_arguments_refused");
  });

  it("refuses readOnly and role claims in arguments", async () => {
    const f = fixture();
    for (const key of ["readOnly", "role", "ownerId", "elevated", "impersonate"]) {
      const outcome = await f.tools.call("list_missions", { [key]: true }, f.claims({ readOnly: true }));
      expect(outcome.ok, key).toBe(false);
      if (!outcome.ok) expect(outcome.error.code, key).toBe("scope_from_arguments_refused");
    }
  });

  it("refuses an unknown tool without touching the runtime", async () => {
    const f = fixture();
    const outcome = await f.tools.call("sell_cloud_computer", {}, f.claims());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("unknown_tool");
  });
});

describe("secret material never crosses the tool layer", () => {
  it("refuses a secret-bearing argument", async () => {
    const f = fixture();
    const outcome = await f.tools.call("list_missions", { apiKey: "sk-live" }, f.claims());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("secret_refused");
  });

  it("refuses an environment carrying a private key", async () => {
    const f = fixture();
    const outcome = await f.tools.call(
      "create_mission",
      {
        agent: "hermes",
        environment: { id: "env", label: "pc", kind: "ssh", authMode: "local", privateKey: "-----BEGIN-----" },
        brief: { objective: "x", doneWhen: ["y"], permissionLevel: "read-only", source: { kind: "owner" } },
      },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("secret_refused");
  });

  it("recognizes credential paths and refuses to read them", () => {
    expect(isSecretBearingPath("/home/me/.ssh/id_ed25519")).toBe(true);
    expect(isSecretBearingPath("/home/me/project/.env")).toBe(true);
    expect(isSecretBearingPath("/home/me/project/.env.production")).toBe(true);
    expect(isSecretBearingPath("C:\\Users\\me\\.ssh\\config")).toBe(true);
    expect(isSecretBearingPath("/home/me/certs/server.pem")).toBe(true);
    expect(isSecretBearingPath("/home/me/project/src/index.ts")).toBe(false);
  });

  it("refuses a brief whose workspace names a credential directory", async () => {
    const f = fixture();
    const outcome = await f.tools.call(
      "create_mission",
      {
        agent: "hermes",
        environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
        brief: {
          objective: "x",
          doneWhen: ["y"],
          permissionLevel: "read-only",
          source: { kind: "owner" },
          workspace: { id: "ws", path: "/home/me/.ssh" },
        },
      },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("secret_refused");
  });
});
