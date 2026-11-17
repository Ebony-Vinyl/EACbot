import { describe, expect, it } from "vitest";

import { pathFor } from "./api.ts";
import type { MissionCommand } from "../../../packages/agent-protocol/commands.ts";

describe("mission command paths", () => {
  it("names the mission in the path, not the body", () => {
    const command = {
      type: "run.steer",
      commandId: "cmd-1",
      missionId: "m 1",
      expectedRevision: 3,
      input: "go on",
    } satisfies MissionCommand;
    expect(pathFor(command)).toBe("/missions/m%201/steer");
  });

  it("names the mission and approval in the approval path", () => {
    const command = {
      type: "approval.resolve",
      commandId: "cmd-2",
      missionId: "m1",
      approvalId: "a/2",
      expectedRevision: 4,
      decision: "deny",
    } satisfies MissionCommand;
    expect(pathFor(command)).toBe("/missions/m1/approvals/a%2F2/resolve");
  });
});
