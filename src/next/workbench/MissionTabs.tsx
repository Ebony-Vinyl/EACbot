import { t } from "@/lib/i18n";
/** The mission tabs: what is open, which one is showing, and the strip of
 * missions waiting for a person above them.
 *
 * The pinned strip is the one thing that outranks the tab order. It is built
 * from the mission snapshot, so a mission leaves it the moment the authority
 * says it is no longer waiting for input, not when a terminal looks quiet.
 */

import { needsInput, sortMissions, missionLabel, missionTone } from "./status.ts";
import type { MissionSummary } from "../../../packages/agent-protocol/mission.ts";

export interface MissionTabStripProps {
  readonly open: readonly MissionSummary[];
  readonly activeId: string | null;
  readonly needsInput: readonly MissionSummary[];
  readonly onSelect: (missionId: string) => void;
  readonly onClose: (missionId: string) => void;
  readonly onOpen: (missionId: string) => void;
}

export function MissionTabStrip({ open, activeId, needsInput: pinned, onSelect, onClose, onOpen }: MissionTabStripProps) {
  return (
    <div className="wb-tabs">
      {pinned.length === 0 ? null : (
        <div className="wb-pinned" role="region" aria-label={t("workspaceUi.copy26")}>
          <span className="wb-pinned-label">{t("needsYou.title")}</span>
          <ul className="wb-pinned-list">
            {pinned.map((mission) => (
              <li key={mission.id}>
                <button
                  type="button"
                  className="wb-pinned-item"
                  onClick={() => onOpen(mission.id)}
                  title={`Open ${mission.title}`}
                >
                  <span className="wb-chip" data-tone={missionTone(mission.status)}>{missionLabel(mission.status)}</span>
                  <span className="wb-pinned-title">{mission.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="wb-tab-strip" role="tablist" aria-label={t("workspaceUi.copy27")}>
        {open.length === 0 ? (
          <p className="wb-hint wb-tab-empty">{t("workspaceUi.copy42")}</p>
        ) : (
          open.map((mission) => {
            const selected = mission.id === activeId;
            return (
              <div key={mission.id} className="wb-tab" data-active={selected ? "true" : "false"}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  className="wb-tab-label"
                  onClick={() => onSelect(mission.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                    event.preventDefault();
                    const at = open.findIndex((entry) => entry.id === mission.id);
                    const step = event.key === "ArrowRight" ? 1 : -1;
                    const next = open[(at + step + open.length) % open.length];
                    if (next) onSelect(next.id);
                  }}
                >
                  <span className="wb-chip" data-tone={missionTone(mission.status)}>{missionLabel(mission.status)}</span>
                  <span className="wb-tab-title">{mission.title}</span>
                </button>
                <button
                  type="button"
                  className="wb-tab-close"
                  aria-label={`Close ${mission.title}`}
                  onClick={() => onClose(mission.id)}
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** The pinned strip's content, newest need first, so a person sees the latest
 * request at the left edge. */
export function pinnedMissions(missions: readonly MissionSummary[]): MissionSummary[] {
  return sortMissions(missions.filter(needsInput));
}

/** The tab list in the order a person opened it, with the active one kept even
 * when the snapshot no longer holds it (a mission can settle while open). */
export function openTabs(openIds: readonly string[], byId: ReadonlyMap<string, MissionSummary>, activeId: string | null): MissionSummary[] {
  const tabs: MissionSummary[] = [];
  for (const id of openIds) {
    const mission = byId.get(id);
    if (mission) tabs.push(mission);
  }
  if (activeId !== null && !tabs.some((tab) => tab.id === activeId)) {
    const active = byId.get(activeId);
    if (active) tabs.unshift(active);
  }
  return tabs;
}
