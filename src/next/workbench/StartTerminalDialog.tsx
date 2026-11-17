/** The "open the agent's own terminal" entry: one click when a mission is
 * selected, a small form when it is not.
 *
 * The form asks only for what the route needs: a computer and a tool. A
 * mission's own computer and its agent's tool are already known, so that path
 * asks nothing and starts the terminal the person meant. */

import { useState } from "react";

import type { Mission } from "../../../packages/agent-protocol/mission.ts";
import { TERMINAL_TOOLS, isTerminalTool, toolForAgent, type TerminalTool } from "./start-terminal.ts";

export interface StartTerminalDialogProps {
  readonly mission: Mission | null;
  /** The computers a terminal can start on. */
  readonly environments: readonly { readonly id: string; readonly label: string; readonly kind?: "local" | "ssh"; readonly tools?: readonly { name: string; status: string }[] }[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly onStart: (request: { environmentId: string; tool: TerminalTool }) => void;
  readonly onCancel: () => void;
}

export function StartTerminalDialog(props: StartTerminalDialogProps) {
  const fromMission = props.mission;
  const missionTool = fromMission === null ? null : toolForAgent(fromMission.agent);
  const [environmentId, setEnvironmentId] = useState(fromMission?.environment.id ?? props.environments[0]?.id ?? "");
  const installed = props.environments.find((environment) => environment.id === environmentId);
  const choices = installed?.kind === "local" ? TERMINAL_TOOLS.filter((name) => installed.tools?.some((tool) => tool.name === name && tool.status === "installed")) : TERMINAL_TOOLS;
  const [selectedTool, setTool] = useState<TerminalTool>(missionTool ?? "hermes");
  const tool = choices.includes(selectedTool) ? selectedTool : choices[0];

  return (
    <div className="wb-dialog-scrim" role="presentation">
      <div className="wb-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-start-title">
        <h2 id="wb-start-title" className="wb-inspector-title">Open an agent terminal</h2>
        {fromMission === null ? (
          <p className="wb-hint">Pick the computer and the agent whose terminal to open.</p>
        ) : (
          <p className="wb-hint">
            Opens {missionTool ?? "the agent"} on {fromMission.environment.label}.
          </p>
        )}
        <label className="wb-field">
          <span>Computer</span>
          <select
            value={environmentId}
            onChange={(event) => setEnvironmentId(event.currentTarget.value)}
            disabled={props.busy || fromMission !== null}
          >
            {props.environments.length === 0 ? <option value="">No computer is known</option> : null}
            {props.environments.map((environment) => (
              <option key={environment.id} value={environment.id}>{environment.label}</option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          <span>Agent</span>
          <select
            value={tool}
            onChange={(event) => {
              if (isTerminalTool(event.currentTarget.value)) setTool(event.currentTarget.value);
            }}
            disabled={props.busy || missionTool !== null}
          >
            {choices.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        {props.error ? <p className="wb-error" role="alert">{props.error}</p> : null}
        <div className="wb-command-row">
          <button
            type="button"
            className="wb-button"
            disabled={props.busy || environmentId === "" || tool === undefined}
            onClick={() => tool !== undefined && props.onStart({ environmentId, tool })}
          >
            {props.busy ? "Starting…" : "Open terminal"}
          </button>
          <button type="button" className="wb-button" onClick={props.onCancel} disabled={props.busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
