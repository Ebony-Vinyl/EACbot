import { TOOL_BRIDGE_ENV } from "./agents-bridge.ts";
import { TOOL_LIMIT_ENV } from "../tool-count-limit.ts";

/** The settings the harness gives the agents MCP server, and the only ones a request may carry over HTTP. */
export const AGENTS_MCP_ENV = ["EAC_BOT_ID", "EAC_THREAD_ID", "EAC_TURN_DEPTH", "EAC_EXTERNAL_RUNTIME", "EAC_CHIEF_OF_STAFF",
  "EAC_SKILL_AUTHORING_ENABLED", "EAC_MEMORY_ENABLED", "EAC_SHARED_COMPUTERS_ENABLED", "EAC_CLOUD_HOME", "EAC_VOICE_NOTES",
  "EAC_X_RESEARCH", "EAC_RESEARCH", "EAC_ESCALATIONS", "EAC_TEAM_PEOPLE", "EAC_MAUSBOT", "EAC_COMPUTER_SELECTION", "EAC_ROOM", "EAC_IMAGE_GENERATION", TOOL_BRIDGE_ENV, TOOL_LIMIT_ENV] as const;
