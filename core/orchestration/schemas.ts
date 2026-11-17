import { AGENT_KINDS } from "../../packages/agent-protocol/agents.ts";
import { APPROVAL_STATUSES } from "../../packages/agent-protocol/artifact.ts";
import { MISSION_STATUSES } from "../../packages/agent-protocol/mission-status.ts";
import { TERMINAL_KINDS } from "../../packages/agent-protocol/terminal.ts";
import { PERMISSION_LEVELS } from "./brief.ts";
import { TERMINAL_ROLES } from "./tickets.ts";
import { TOOL_NAMES, type ToolName } from "./types.ts";

export interface ToolSchema {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** A read-only tool never mutates a mission, and a read-only credential may
   * still call it. */
  readonly readOnly: boolean;
}

const COMMAND_ID_PROPERTY = {
  type: "string",
  description: "Caller-chosen idempotency key. Reusing it with the same arguments returns the original result.",
  minLength: 1,
  maxLength: 200,
} as const;

const MISSION_ID_PROPERTY = {
  type: "string",
  description: "The mission this call acts on.",
  minLength: 1,
} as const;

const REVISION_PROPERTY = {
  type: "integer",
  description: "The mission revision the caller saw. A stale value is refused rather than applied.",
  minimum: 1,
} as const;

const MUTATION_REQUIRED = ["missionId", "expectedRevision"] as const;

function mutationProperties(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    missionId: MISSION_ID_PROPERTY,
    expectedRevision: REVISION_PROPERTY,
    commandId: COMMAND_ID_PROPERTY,
    ...extra,
  };
}

const TOOL_SCHEMAS: Readonly<Record<ToolName, ToolSchema>> = {
  list_agents: {
    name: "list_agents",
    description:
      "List the agents this credential may delegate to, with their real capabilities, install state and model state. An engine with no readable model catalog says so instead of showing a list.",
    readOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agents: {
          type: "array",
          description: "Restrict the answer to these agents.",
          items: { type: "string", enum: [...AGENT_KINDS] },
          maxItems: AGENT_KINDS.length,
        },
        probeModels: {
          type: "boolean",
          description: "Ask each engine for its own model catalog. Off by default because it starts a process or an HTTP call per agent.",
        },
      },
    },
  },
  list_missions: {
    name: "list_missions",
    description: "List missions inside this credential's scope, newest first.",
    readOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        rootMissionId: { type: "string", description: "Restrict the answer to one mission tree.", minLength: 1 },
        status: { type: "array", items: { type: "string", enum: [...MISSION_STATUSES] }, maxItems: MISSION_STATUSES.length },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum missions to return. Defaults to 50." },
      },
    },
  },
  create_mission: {
    name: "create_mission",
    description:
      "Delegate a task to an agent. The server renders the brief into the mission prompt; a conversation transcript is refused, and so is a secret-bearing field.",
    readOnly: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agent", "environment", "brief"],
      properties: {
        commandId: COMMAND_ID_PROPERTY,
        agent: { type: "string", enum: [...AGENT_KINDS], description: "The agent that runs the work." },
        model: {
          type: "object",
          additionalProperties: false,
          description: "A model this agent actually offers. Omitted means the engine's own default.",
          required: ["agent", "model"],
          properties: {
            agent: { type: "string", enum: [...AGENT_KINDS] },
            model: { type: "string", minLength: 1 },
            effort: { type: "string", minLength: 1 },
            variant: { type: "string", minLength: 1 },
            label: { type: "string", minLength: 1 },
          },
        },
        environment: {
          type: "object",
          additionalProperties: false,
          description: "The user's own computer. A credential is named by reference, never supplied here.",
          required: ["id", "label", "kind", "authMode"],
          properties: {
            id: { type: "string", minLength: 1 },
            label: { type: "string", minLength: 1 },
            kind: { type: "string", enum: ["ssh", "local"] },
            host: { type: "string", minLength: 1 },
            port: { type: "integer", minimum: 1, maximum: 65_535 },
            user: { type: "string", minLength: 1 },
            authMode: { type: "string", enum: ["subscription", "apiKey", "compatibleEndpoint", "local"] },
            credentialRef: { type: "string", minLength: 1, description: "A handle to a credential the environment agent holds." },
            baseUrl: { type: "string", minLength: 1 },
            hostKeyFingerprint: { type: "string", minLength: 1 },
          },
        },
        brief: {
          type: "object",
          additionalProperties: false,
          description: "The task as structured fields. Never a transcript of the conversation that led to it.",
          required: ["objective", "doneWhen", "permissionLevel", "source"],
          properties: {
            objective: { type: "string", minLength: 1, maxLength: 2_000 },
            doneWhen: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 300 } },
            permissionLevel: { type: "string", enum: [...PERMISSION_LEVELS] },
            source: {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: {
                kind: { type: "string", enum: ["hermes", "owner", "mission"] },
                ref: { type: "string", minLength: 1, maxLength: 200 },
              },
            },
            workspace: {
              type: "object",
              additionalProperties: false,
              required: ["id"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 200 },
                path: { type: "string", minLength: 1, maxLength: 1_000 },
              },
            },
            artifactIds: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
          },
        },
        parentMissionId: {
          type: "string",
          description: "Delegate under an existing mission in scope. A mission with live children waits for them.",
          minLength: 1,
        },
      },
    },
  },
  steer_run: {
    name: "steer_run",
    description:
      "Send text into a live run. The answer says whether the engine admitted it and when it will be read: immediately, or at the engine's next tool boundary.",
    readOnly: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [...MUTATION_REQUIRED, "input"],
      properties: mutationProperties({
        input: { type: "string", minLength: 1, maxLength: 20_000 },
      }),
    },
  },
  interrupt_run: {
    name: "interrupt_run",
    description:
      "Stop the live run but keep its native session resumable. This is not a cancel: `resume_mission` can continue the work.",
    readOnly: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [...MUTATION_REQUIRED],
      properties: mutationProperties({
        reason: { type: "string", maxLength: 1_000 },
      }),
    },
  },
  resume_mission: {
    name: "resume_mission",
    description:
      "Continue an interrupted mission from its own native session. Refused when the mission is not resumable, so a caller learns the real state instead of starting a new run.",
    readOnly: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [...MUTATION_REQUIRED],
      properties: mutationProperties(),
    },
  },
  cancel_mission: {
    name: "cancel_mission",
    description: "Terminate a mission and its live run. Unlike an interrupt, the native session is not kept.",
    readOnly: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [...MUTATION_REQUIRED],
      properties: mutationProperties({
        reason: { type: "string", maxLength: 1_000 },
        cascade: { type: "boolean", description: "Also cancel delegated children. Defaults to true." },
      }),
    },
  },
  mission_status: {
    name: "mission_status",
    description: "Read one mission's state, its latest run and how many approvals wait on a person.",
    readOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["missionId"],
      properties: {
        missionId: MISSION_ID_PROPERTY,
        eventLimit: { type: "integer", minimum: 0, maximum: 100, description: "Recent log entries to include. Defaults to 10." },
      },
    },
  },
  list_approvals: {
    name: "list_approvals",
    description: "List approvals an agent is waiting on. Only approvals that exist can be answered.",
    readOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        missionId: { type: "string", description: "Restrict the answer to one mission.", minLength: 1 },
        status: { type: "array", items: { type: "string", enum: [...APPROVAL_STATUSES] }, maxItems: APPROVAL_STATUSES.length },
      },
    },
  },
  answer_approval: {
    name: "answer_approval",
    description:
      "Answer an approval that is still pending. An approval id that does not exist on the named mission is refused, so a caller cannot answer on another mission's behalf.",
    readOnly: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [...MUTATION_REQUIRED, "approvalId", "decision"],
      properties: mutationProperties({
        approvalId: { type: "string", minLength: 1 },
        decision: { type: "string", enum: ["allow", "deny", "answer"] },
        answer: { type: "string", maxLength: 4_000, description: "The answer text, when decision is `answer`." },
      }),
    },
  },
  open_terminal: {
    name: "open_terminal",
    description:
      "Ask for a terminal on a mission's run. Returns a scoped ticket for the terminal layer; it opens no stream, types nothing and reads nothing.",
    readOnly: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["missionId"],
      properties: {
        missionId: MISSION_ID_PROPERTY,
        runId: { type: "string", description: "Defaults to the mission's live run.", minLength: 1 },
        kind: { type: "string", enum: [...TERMINAL_KINDS], description: "Defaults to the engine's own TUI." },
        role: { type: "string", enum: [...TERMINAL_ROLES], description: "Defaults to observe." },
      },
    },
  },
  get_artifact: {
    name: "get_artifact",
    description:
      "Read an artifact's reference and metadata. Content stays on the user's computer; a credential-bearing path is refused.",
    readOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["artifactId"],
      properties: {
        artifactId: { type: "string", minLength: 1 },
        missionId: { type: "string", description: "When present, the artifact must belong to this mission.", minLength: 1 },
      },
    },
  },
};

export const TOOL_SCHEMA_LIST: readonly ToolSchema[] = TOOL_NAMES.map((name) => TOOL_SCHEMAS[name]);

export function toolSchema(name: ToolName): ToolSchema {
  return TOOL_SCHEMAS[name];
}

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}
