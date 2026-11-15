import { afterEach, describe, expect, it } from "vitest";

import { briefTitle, renderBrief, validateBrief } from "./brief.ts";
import { createToolFixture, toolMission, type Fixture } from "./fixture.ts";

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture(): Fixture {
  const created = createToolFixture();
  open.push(created);
  return created;
}

const validBrief = {
  objective: "Audit the dependency tree for licences",
  doneWhen: ["every dependency has a licence file", "the report lists any gap"],
  permissionLevel: "read-only" as const,
  source: { kind: "hermes" as const, ref: "conversation-7" },
};

describe("a brief is structured fields, never a transcript", () => {
  it("refuses a conversation where a brief belongs", async () => {
    const f = fixture();
    for (const key of ["conversation", "transcript", "messages", "chatHistory", "history", "context"]) {
      const outcome = await f.tools.call(
        "create_mission",
        {
          agent: "hermes",
          environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
          brief: { ...validBrief, [key]: [{ role: "user", content: "my private plans" }] },
        },
        f.claims(),
      );
      expect(outcome.ok, key).toBe(false);
      if (!outcome.ok) expect(outcome.error.code, key).toBe("invalid_arguments");
    }
  });

  it("refuses a top-level conversation too", async () => {
    const f = fixture();
    const outcome = await f.tools.call(
      "create_mission",
      {
        agent: "hermes",
        environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
        brief: validBrief,
        conversation: "the whole chat",
      },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("invalid_arguments");
  });

  it("refuses an empty objective and an empty completion list", () => {
    expect(() => validateBrief({ ...validBrief, objective: "   " })).toThrow(/objective/);
    expect(() => validateBrief({ ...validBrief, doneWhen: [] })).toThrow(/doneWhen/);
    expect(() => validateBrief({ ...validBrief, doneWhen: [""] })).toThrow(/doneWhen/);
  });

  it("refuses a permission level outside the three real ones", () => {
    expect(() => validateBrief({ ...validBrief, permissionLevel: "admin" })).toThrow(/permissionLevel/);
    expect(() => validateBrief({ ...validBrief, permissionLevel: "root" })).toThrow(/permissionLevel/);
  });

  it("refuses a brief with no source", () => {
    const { source: _source, ...withoutSource } = validBrief;
    expect(() => validateBrief(withoutSource)).toThrow(/source/);
  });

  it("renders exactly the fields it was given", () => {
    const brief = validateBrief(validBrief);
    const rendered = renderBrief(brief);
    expect(rendered).toContain(brief.objective);
    expect(rendered).toContain("every dependency has a licence file");
    expect(rendered).toContain("read-only");
    expect(rendered).toContain("conversation-7");
    expect(rendered).not.toContain("role: user");
  });

  it("renders a workspace path and artifact ids as references only", () => {
    const brief = validateBrief({
      ...validBrief,
      permissionLevel: "workspace-write",
      workspace: { id: "ws-1", path: "/home/me/project" },
      artifactIds: ["artifact-1", "artifact-2"],
    });
    const rendered = renderBrief(brief);
    expect(rendered).toContain("/home/me/project");
    expect(rendered).toContain("artifact-1");
    expect(rendered).toContain("workspace-write");
  });

  it("keeps the stored prompt free of secret field names", async () => {
    const f = fixture();
    const { missionId } = await toolMission(f, {
      commandId: "c1",
      brief: validBrief,
    });
    const mission = f.missions.runtime.store.requireMission(missionId);
    expect(mission.prompt).toContain("Audit the dependency tree for licences");
    for (const name of ["privateKey", "password", "apiKey", "token", "secret"]) {
      expect(mission.prompt.toLowerCase()).not.toContain(`${name}:`);
    }
  });

  it("never stores a conversation even when one is offered as an objective", async () => {
    const f = fixture();
    const outcome = await f.tools.call(
      "create_mission",
      {
        agent: "hermes",
        environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
        brief: {
          objective: "do what I said in the chat",
          doneWhen: ["it is done"],
          permissionLevel: "read-only",
          source: { kind: "hermes" },
        },
      },
      f.claims(),
    );
    expect(outcome.ok).toBe(true);
    const mission = f.missions.runtime.store.requireMission((outcome.data as { missionId: string }).missionId);
    expect(mission.prompt).not.toMatch(/user:|assistant:/u);
    expect(mission.prompt.split("\n").length).toBeLessThan(20);
  });

  it("derives a short title from the objective's first clause", () => {
    expect(briefTitle(validateBrief({ ...validBrief, objective: "Fix the build. Then deploy." }))).toBe("Fix the build.");
    const long = briefTitle(validateBrief({ ...validBrief, objective: "a".repeat(400) }));
    expect(long.length).toBe(120);
    expect(long.endsWith("...")).toBe(true);
  });
});
