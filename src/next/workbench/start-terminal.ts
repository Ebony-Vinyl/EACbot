/** Starting an agent's own native terminal on the person's computer.
 *
 * `POST /api/v1/terminals` takes the environment, the tool and, when it has
 * one, the mission and run the terminal belongs to, and answers 201 with the
 * terminal record (core/http/routes.ts). Starting a terminal is not a mission
 * mutation: the route publishes a notification so clients refetch, and the new
 * terminal's id is separate from every native session id.
 *
 * The request lives here rather than in `foundation/api.ts` because this build
 * may not change the foundation module; it goes through the foundation's own
 * client, so the bearer, the base URL and the error envelope stay in one place.
 */

import { apiClient } from "../foundation/api.ts";
import type { TerminalRef } from "../../../packages/agent-protocol/terminal.ts";

/** The tools the route accepts. A tool outside this set is refused by the
 * server, so the picker offers only these. */
export const TERMINAL_TOOLS = ["hermes", "claude", "codex", "opencode", "pi", "omp"] as const;

export type TerminalTool = (typeof TERMINAL_TOOLS)[number];

export interface StartTerminalRequest {
  readonly environmentId: string;
  readonly tool: TerminalTool;
  readonly missionId?: string;
  readonly runId?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly name?: string;
}

export interface TerminalStartResponse {
  readonly terminal: TerminalRef;
}

/** The body the route expects, with only the fields that were given: the route
 * refuses an unknown field, so an explicit `undefined` must not be sent. */
export function startTerminalBody(request: StartTerminalRequest): Record<string, unknown> {
  return {
    environmentId: request.environmentId,
    tool: request.tool,
    ...(request.missionId !== undefined ? { missionId: request.missionId } : {}),
    ...(request.runId !== undefined ? { runId: request.runId } : {}),
    ...(request.cols !== undefined ? { cols: request.cols } : {}),
    ...(request.rows !== undefined ? { rows: request.rows } : {}),
    ...(request.name !== undefined ? { name: request.name } : {}),
  };
}

/** The client shape this module calls. `foundation/api.ts` does not re-export
 * its client type, so the one method used here is named locally. */
export interface TerminalApiClient {
  request<T>(path: string, options?: { readonly method?: "POST"; readonly body?: unknown }): Promise<T>;
}

export async function startTerminal(
  request: StartTerminalRequest,
  client: TerminalApiClient = apiClient(),
): Promise<TerminalRef> {
  const body = await client.request<TerminalStartResponse>("/terminals", {
    method: "POST",
    body: startTerminalBody(request),
  });
  return body.terminal;
}

/** The tool a mission's agent maps to. The protocol's agent kinds and the
 * route's tool names are two vocabularies; this is the one place they meet. */
export function toolForAgent(agent: string): TerminalTool | null {
  switch (agent) {
    case "hermes":
      return "hermes";
    case "claudeCode":
      return "claude";
    case "codex":
      return "codex";
    case "openCode":
      return "opencode";
    case "pi":
      return "pi";
    case "ohMyPi":
      return "omp";
    default:
      return null;
  }
}

export function isTerminalTool(value: string): value is TerminalTool {
  return (TERMINAL_TOOLS as readonly string[]).includes(value);
}
