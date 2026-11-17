import { t } from "@/lib/i18n";
/** The left rail: the computers and spaces work runs on, the agents that can
 * run it, and the missions and terminals each one has.
 *
 * A terminal is a real stream, not a mission: picking one points the focused
 * pane at it. Nothing here infers a mission state from a terminal; the counts
 * beside an agent come from the mission snapshot alone.
 */

import type { AgentDescriptor } from "../../../packages/agent-protocol/agents.ts";
import type { Mission } from "../../../packages/agent-protocol/mission.ts";
import type { TerminalRef } from "../../../packages/agent-protocol/terminal.ts";
import { isActive, missionLabel, missionTone, sortMissions } from "./status.ts";

export interface SidebarTerminal {
  readonly terminal: TerminalRef;
  /** What the terminal belongs to, so a list of opaque ids is readable. */
  readonly missionTitle: string | null;
  readonly inPane: boolean;
}

export interface MachineGroup {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly terminals: readonly SidebarTerminal[];
}

export interface WorkbenchSidebarProps {
  readonly machines: readonly MachineGroup[];
  readonly agents: readonly AgentDescriptor[];
  readonly missions: readonly Mission[];
  readonly collapsed: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly focusedTerminalId: string | null;
  readonly onToggle: () => void;
  readonly onPickTerminal: (terminalId: string) => void;
  readonly onOpenMission: (missionId: string) => void;
  readonly onRetry: () => void;
}

/** Groups terminals by the computer their mission runs on. A mission names its
 * own environment, so this is a view of the snapshot, not a second source. */
export function groupMachines(missions: readonly Mission[], terminals: readonly TerminalRef[], paneTerminalIds: readonly string[]): MachineGroup[] {
  const byMission = new Map(missions.map((mission) => [mission.id, mission]));
  const groups = new Map<string, { label: string; detail: string; terminals: SidebarTerminal[] }>();
  for (const terminal of terminals) {
    const mission = byMission.get(terminal.missionId);
    const environment = mission?.environment;
    const id = environment?.id ?? "unknown";
    const group = groups.get(id) ?? {
      label: environment?.label ?? t("workspaceUi.unknownComputer"),
      detail: environment ? describeEnvironment(environment) : t("workspaceUi.copy69"),
      terminals: [],
    };
    group.terminals.push({
      terminal,
      missionTitle: mission?.title ?? null,
      inPane: paneTerminalIds.includes(terminal.id),
    });
    groups.set(id, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => ({ id, label: group.label, detail: group.detail, terminals: group.terminals }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function describeEnvironment(environment: Mission["environment"]): string {
  const where = environment.host ?? environment.baseUrl ?? environment.kind;
  return environment.user ? `${environment.user}@${where}` : where;
}

export function WorkbenchSidebar(props: WorkbenchSidebarProps) {
  const { collapsed } = props;
  return (
    <aside className="wb-side" data-collapsed={collapsed ? "true" : "false"} aria-label={t("workspaceUi.copy80")}>
      <div className="wb-side-head">
        <button
          type="button"
          className="wb-icon-button"
          onClick={props.onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? t("workspaceUi.copy64") : t("workspaceUi.copy36")}
        >
          {collapsed ? "»" : "«"}
        </button>
        {collapsed ? null : <h2 className="wb-side-title">{t("workspaceUi.copy20")}</h2>}
      </div>

      {collapsed ? (
        <div className="wb-side-rail" aria-hidden="true">
          {props.machines.slice(0, 6).map((machine) => (
            <span key={machine.id} className="wb-rail-dot" title={machine.label} />
          ))}
        </div>
      ) : props.loading ? (
        <SidebarLoading />
      ) : props.error ? (
        <div className="wb-side-error" role="alert">
          <p>{props.error}</p>
          <button type="button" className="wb-button" onClick={props.onRetry}>{t("update.card.tryAgain")}</button>
        </div>
      ) : (
        <>
          <section className="wb-side-section" aria-label={t("workspaceUi.copy21")}>
            <h3 className="wb-side-heading">{t("sidebar.nav.computers")}</h3>
            {props.machines.length === 0 ? (
              <p className="wb-hint">{t("workspaceUi.copy40")}</p>
            ) : (
              <ul className="wb-machine-list">
                {props.machines.map((machine) => (
                  <li key={machine.id} className="wb-machine">
                    <div className="wb-machine-head">
                      <span className="wb-machine-name">{machine.label}</span>
                      <span className="wb-machine-detail">{machine.detail}</span>
                    </div>
                    {machine.terminals.length === 0 ? (
                      <p className="wb-hint">{t("workspaceUi.copy47")}</p>
                    ) : (
                      <ul className="wb-terminal-list">
                        {machine.terminals.map((entry) => (
                          <li key={entry.terminal.id}>
                            <button
                              type="button"
                              className="wb-terminal-row"
                              data-open={entry.inPane ? "true" : "false"}
                              onClick={() => props.onPickTerminal(entry.terminal.id)}
                              title={`Show ${entry.terminal.id} in the focused pane`}
                            >
                              <span className="wb-terminal-kind">{entry.terminal.kind}</span>
                              <span className="wb-terminal-name">{entry.missionTitle ?? entry.terminal.id}</span>
                              {entry.terminal.closedAt ? <span className="wb-chip" data-tone="neutral">{t("task.closed")}</span> : null}
                              {entry.inPane ? <span className="wb-chip" data-tone="accent">{t("workspaceUi.copy22")}</span> : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="wb-side-section" aria-label={t("sidebar.nav.agents")}>
            <h3 className="wb-side-heading">{t("sidebar.nav.agents")}</h3>
            {props.agents.length === 0 ? (
              <p className="wb-hint">{t("workspaceUi.copy73")}</p>
            ) : (
              <ul className="wb-agent-list">
                {props.agents.map((agent) => {
                  const mine = props.missions.filter((mission) => mission.agent === agent.kind);
                  const active = mine.filter(isActive).length;
                  return (
                    <li key={agent.kind} className="wb-agent-row">
                      <span className="wb-agent-name">{agent.label}</span>
                      <span className="wb-agent-counts">
                        {active > 0 ? `${active} active` : "idle"}
                        {mine.length > active ? ` · ${mine.length - active} settled` : ""}
                      </span>
                      {mine.length === 0 ? null : (
                        <ul className="wb-agent-missions">
                          {mine.slice(0, 4).map((mission) => (
                            <li key={mission.id}>
                              <button type="button" className="wb-link-button" onClick={() => props.onOpenMission(mission.id)}>
                                <span className="wb-chip" data-tone={missionTone(mission.status)}>{missionLabel(mission.status)}</span>
                                <span>{mission.title}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="wb-side-section" aria-label={t("workspaceUi.copy84")}>
            <h3 className="wb-side-heading">{t("workspaceUi.copy84")}</h3>
            {props.missions.length === 0 ? (
              <p className="wb-hint">{t("workspaceUi.copy41")}</p>
            ) : (
              <ul className="wb-mission-list">
                {sortMissions(props.missions).map((mission) => (
                  <li key={mission.id}>
                    <button
                      type="button"
                      className="wb-terminal-row"
                      onClick={() => props.onOpenMission(mission.id)}
                      title={`Open ${mission.title}`}
                    >
                      <span className="wb-chip" data-tone={missionTone(mission.status)}>{missionLabel(mission.status)}</span>
                      <span className="wb-terminal-name">{mission.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </aside>
  );
}

function SidebarLoading() {
  return (
    <div className="wb-side-loading" aria-busy="true" aria-label={t("workspaceUi.copy23")}>
      {[0, 1, 2, 3].map((row) => <span key={row} className="wb-skeleton" />)}
    </div>
  );
}
