import { describe, expect, it } from "vitest";

import { TOOL_NAMES } from "./types.ts";
import { TOOL_SCHEMA_LIST, isToolName, toolSchema } from "./schemas.ts";
import { TOOL_ERROR_CODES, toErrorBody, ToolError } from "./errors.ts";
import { CommandError } from "../../packages/agent-protocol/commands.ts";
import { MissionNotFoundError, RevisionConflictError, RunNotFoundError } from "../missions/errors.ts";
import { SecretFieldError } from "../../packages/agent-protocol/guards.ts";
import { IllegalTransitionError } from "../../packages/agent-protocol/mission-status.ts";
import { createToolFixture, type Fixture } from "./fixture.ts";
import { afterEach } from "vitest";

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

describe("the tool catalogue is stable data", () => {
  it("names every tool exactly once, in a fixed order", () => {
    expect(TOOL_SCHEMA_LIST.map((schema) => schema.name)).toEqual([...TOOL_NAMES]);
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it("matches the recorded schema snapshot", () => {
    const snapshot = TOOL_SCHEMA_LIST.map((schema) => ({
      name: schema.name,
      readOnly: schema.readOnly,
      required: [...((schema.inputSchema.required as string[] | undefined) ?? [])].sort(),
      properties: Object.keys((schema.inputSchema.properties as Record<string, unknown> | undefined) ?? {}).sort(),
      additionalProperties: schema.inputSchema.additionalProperties,
      type: schema.inputSchema.type,
    }));
    expect(snapshot).toMatchInlineSnapshot(`
      [
        {
          "additionalProperties": false,
          "name": "list_agents",
          "properties": [
            "agents",
            "probeModels",
          ],
          "readOnly": true,
          "required": [],
          "type": "object",
        },
        {
          "additionalProperties": false,
          "name": "list_missions",
          "properties": [
            "limit",
            "rootMissionId",
            "status",
          ],
          "readOnly": true,
          "required": [],
          "type": "object",
        },
        {
          "additionalProperties": false,
          "name": "create_mission",
          "properties": [
            "agent",
            "brief",
            "commandId",
            "environment",
            "model",
            "parentMissionId",
          ],
          "readOnly": false,
          "required": [
            "agent",
            "brief",
            "environment",
          ],
          "type": "object",
        },
        {
          "additionalProperties": false,
          "name": "steer_run",
          "properties": [
            "commandId",
            "expectedRevision",
            "input",
            "missionId",
          ],
          "readOnly": false,
          "required": [
            "expectedRevision",
            "input",
            "missionId",
          ],
          "type": "object",
        },
        {
          "additionalProperties": false,
          "name": "interrupt_run",
          "properties": [
            "commandId",
            "expectedRevision",
            "missionId",
            "reason",
          ],
          "readOnly": false,
          "required": [
            "expectedRevision",
            "missionId",
          ],
          "type": "object",
        },
        {
          "additionalProperties": false,
          "name": "resume_mission",
          "properties": [
            "commandId",
            "expectedRevision",
            "missionId",
          ],
          "readOnly": false,
          "required": [
            "expectedRevision",
            "missionId",
          ],
          "type": "object",
        },
        {
          "additionalProperties": false,
          "name": "cancel_mission",
          "properties": [
            "cascade",
            "commandId",
            "expectedRevision",
            "missionId",
            "reason",
          ],
          "readOnly": false,
          "required": [
            "expectedRevision",
            "missionId",
          ],
          "type": "object",
        },
        {
          "additionalProperties": false,
          "name": "mission_status",
          "properties": [
            "eventLimit",
            "missionId",
          ],
          "readOnly": true,
          "required": [
            "missionId",
          ],
          "type": "object",
        },
        {
          "additionalProperties": false,
          "name": "list_approvals",
          "properties": [
            "missionId",
            "status",
          ],
          "readOnly": true,
          "required": [],
          "type": "object",
        },
        {
          "additionalProperties": false,
          "name": "answer_approval",
          "properties": [
            "answer",
            "approvalId",
            "commandId",
            "decision",
            "expectedRevision",
            "missionId",
          ],
          "readOnly": false,
          "required": [
            "approvalId",
            "decision",
            "expectedRevision",
            "missionId",
          ],
          "type": "object",
        },
        {
          "additionalProperties": false,
          "name": "open_terminal",
          "properties": [
            "kind",
            "missionId",
            "role",
            "runId",
          ],
          "readOnly": false,
          "required": [
            "missionId",
          ],
          "type": "object",
        },
        {
          "additionalProperties": false,
          "name": "get_artifact",
          "properties": [
            "artifactId",
            "missionId",
          ],
          "readOnly": true,
          "required": [
            "artifactId",
          ],
          "type": "object",
        },
      ]
    `);
  });

  it("marks only the four reading tools read-only", () => {
    expect(TOOL_SCHEMA_LIST.filter((schema) => schema.readOnly).map((schema) => schema.name)).toEqual([
      "list_agents",
      "list_missions",
      "mission_status",
      "list_approvals",
      "get_artifact",
    ]);
  });

  it("never declares an authority field in any schema", () => {
    for (const schema of TOOL_SCHEMA_LIST) {
      const properties = Object.keys((schema.inputSchema.properties as Record<string, unknown>) ?? {});
      expect(properties, schema.name).not.toContain("token");
      expect(properties, schema.name).not.toContain("scope");
      expect(properties, schema.name).not.toContain("readOnly");
      expect(properties, schema.name).not.toContain("ownerId");
    }
  });

  it("recognizes only declared tool names", () => {
    expect(isToolName("steer_run")).toBe(true);
    expect(isToolName("sell_cloud")).toBe(false);
    expect(toolSchema("steer_run").name).toBe("steer_run");
  });

  it("has no provider-selection or sales tool", () => {
    for (const name of TOOL_NAMES) {
      expect(name).not.toMatch(/provider|cloud|purchase|billing|checkout/u);
    }
  });

  it("declares no field that would choose a provider or buy a computer", () => {
    const forbidden = /provider|cloud|machine|purchase|plan|subscription_plan|region/u;
    for (const schema of TOOL_SCHEMA_LIST) {
      for (const key of Object.keys((schema.inputSchema.properties as Record<string, unknown>) ?? {})) {
        expect(key, `${schema.name}.${key}`).not.toMatch(forbidden);
      }
      expect(JSON.stringify(schema.inputSchema)).not.toMatch(/hosted|managed_computer/u);
    }
  });

  it("exposes only the declared agent kinds, never a provider id", async () => {
    const f = createToolFixture();
    open.push(f);
    const outcome = await f.tools.call("list_agents", {}, f.claims());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const agents = (outcome.data as { agents: { agent: string }[] }).agents;
    expect(agents.every((entry) => ["hermes", "claudeCode", "codex", "openCode", "pi", "ohMyPi", "custom"].includes(entry.agent))).toBe(true);
  });
});

describe("errors map to a closed vocabulary", () => {
  it("maps a command error to its own code and keeps the revision", () => {
    const body = toErrorBody(new CommandError("revision_conflict", "moved on", 7));
    expect(body.code).toBe("revision_conflict");
    expect(body.retryable).toBe(true);
    expect(body.details).toEqual({ currentRevision: 7 });
  });

  it("maps the mission layer's own errors", () => {
    expect(toErrorBody(new MissionNotFoundError("m1")).code).toBe("not_found");
    expect(toErrorBody(new RunNotFoundError("r1")).code).toBe("not_found");
    expect(toErrorBody(new RevisionConflictError("m1", 1, 2)).code).toBe("revision_conflict");
    expect(toErrorBody(new IllegalTransitionError("running", "resuming")).code).toBe("illegal_transition");
    expect(toErrorBody(new SecretFieldError(["apiKey"])).code).toBe("secret_refused");
  });

  it("never leaks an unexpected error's message", () => {
    const body = toErrorBody(new Error("connection string with a password"));
    expect(body.code).toBe("internal");
    expect(body.message).not.toContain("password");
    expect(body.retryable).toBe(false);
  });

  it("maps every code in the closed list, and nothing else", () => {
    const bodies = TOOL_ERROR_CODES.map((code) => toErrorBody(new ToolError(code, "x")));
    for (const body of bodies) expect(TOOL_ERROR_CODES).toContain(body.code);
  });

  it("reports an unknown command code as internal rather than passing it through", () => {
    const body = toErrorBody(new CommandError("not_found", "no mission"));
    expect(body.code).toBe("not_found");
  });
});

describe("a tool refusal is a value, not an exception", () => {
  it("returns the failing tool's name and the caller's command id", async () => {
    const f = createToolFixture();
    open.push(f);
    const outcome = await f.tools.call(
      "cancel_mission",
      { commandId: "keep-me", missionId: "missing", expectedRevision: 1 },
      f.claims(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.tool).toBe("cancel_mission");
      expect(outcome.commandId).toBe("keep-me");
      expect(outcome.error.code).toBe("not_found");
    }
  });

  it("names a tool for an unknown name so the envelope keeps its shape", async () => {
    const f = createToolFixture();
    open.push(f);
    const outcome = await f.tools.call("nope", {}, f.claims());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("unknown_tool");
      expect(typeof outcome.tool).toBe("string");
    }
  });

  it("refuses an unknown argument rather than ignoring it", async () => {
    const f = createToolFixture();
    open.push(f);
    const outcome = await f.tools.call("list_missions", { sort: "newest" }, f.claims());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("invalid_arguments");
  });
});
