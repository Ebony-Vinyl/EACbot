import { t } from "@/lib/i18n";
/** How the workbench names states, and the one rule that keeps them apart.
 *
 * A mission's status comes from the mission authority's snapshot and from
 * nothing else. A terminal's own status (OSC 7501, process exit) is a chip on
 * that pane: it never becomes, or overrides, a mission status. The two
 * vocabularies are deliberately different types, so a terminal chip cannot be
 * passed where a mission status is expected.
 */

import type { MissionStatus } from "../../../packages/agent-protocol/mission-status.ts";
import { isTerminalMissionStatus } from "../../../packages/agent-protocol/mission-status.ts";
import type { Mission } from "../../../packages/agent-protocol/mission.ts";

export type ChipTone = "neutral" | "accent" | "success" | "warning" | "danger";

export type TerminalChipState = "idle" | "working" | "blocked" | "done" | "unknown";

export interface TerminalChip {
  readonly state: TerminalChipState;
  readonly label: string;
  readonly tone: ChipTone;
}

const TERMINAL_STATES = {
  idle: { label: "pluginUi.idle", tone: "neutral" },
  working: { label: "routines.goal.working", tone: "accent" },
  blocked: { label: "tasks.column.blocked", tone: "warning" },
  done: { label: "teamShare.done", tone: "success" },
  unknown: { label: "skills.sourceUnknown", tone: "neutral" },
} as const satisfies Readonly<Record<TerminalChipState, Omit<TerminalChip, "state">>>;

const TERMINAL_WORDS: Readonly<Record<TerminalChipState, readonly string[]>> = {
  idle: ["idle", "ready", "prompt", "waiting_for_input_idle"],
  working: ["working", "busy", "running", "thinking", "streaming", "tool"],
  blocked: ["blocked", "waiting", "needs_input", "needs-input", "needsinput", "approval", "question"],
  done: ["done", "finished", "complete", "completed", "succeeded", "success", "exited"],
  unknown: ["unknown"],
};

/** A terminal's own status as a chip. Words the program reports that this
 * build does not know become `unknown` rather than a guess. */
export function terminalChip(raw: string | null | undefined): TerminalChip {
  const word = (raw ?? "").trim().toLowerCase();
  if (word === "") return { state: "unknown", ...TERMINAL_STATES.unknown, label: t(TERMINAL_STATES.unknown.label) };
  for (const state of ["blocked", "working", "idle", "done"] as const) {
    if (TERMINAL_WORDS[state].includes(word)) return { state, ...TERMINAL_STATES[state], label: t(TERMINAL_STATES[state].label) };
  }
  return { state: "unknown", ...TERMINAL_STATES.unknown, label: t(TERMINAL_STATES.unknown.label) };
}

/** The chip for a stream that ended: a clean exit reads as done, anything
 * else as unknown, and the label says which. */
export function exitChip(info: { reason: string; exitCode?: number }): TerminalChip {
  const clean = info.exitCode === undefined || info.exitCode === 0;
  return clean
    ? { state: "done", label: t("workspaceUi.exited"), tone: "success" }
    : { state: "unknown", label: t("workspaceUi.exitCode", { code: info.exitCode! }), tone: "warning" };
}

const MISSION_LABELS = {
  queued: "workspaceUi.queued",
  provisioning: "workspaceUi.provisioning",
  running: "workspaceUi.running",
  waiting_input: "workspaceUi.waiting_input",
  waiting_children: "workspaceUi.waiting_children",
  interrupted: "workspaceUi.interrupted",
  resuming: "workspaceUi.resumingStatus",
  succeeded: "workspaceUi.succeeded",
  failed: "workspaceUi.failed",
  cancelled: "workspaceUi.cancelled",
} as const satisfies Readonly<Record<MissionStatus, string>>;

const MISSION_TONES: Readonly<Record<MissionStatus, ChipTone>> = {
  queued: "neutral",
  provisioning: "neutral",
  running: "accent",
  waiting_input: "warning",
  waiting_children: "accent",
  interrupted: "warning",
  resuming: "accent",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
};

export function missionLabel(status: MissionStatus): string {
  return t(MISSION_LABELS[status]);
}

export function missionTone(status: MissionStatus): ChipTone {
  return MISSION_TONES[status];
}

/** A mission that is waiting for a person is the one thing that goes above
 * everything else, whatever its age. */
export function needsInput(mission: Pick<Mission, "status">): boolean {
  return mission.status === "waiting_input";
}

/** Work is still moving: a person watching should expect updates. */
export function isActive(mission: Pick<Mission, "status">): boolean {
  return mission.status === "queued"
    || mission.status === "provisioning"
    || mission.status === "running"
    || mission.status === "waiting_input"
    || mission.status === "waiting_children"
    || mission.status === "resuming";
}

export function isSettled(mission: Pick<Mission, "status">): boolean {
  return isTerminalMissionStatus(mission.status);
}

const GROUP: Readonly<Record<"needs_input" | "active" | "paused" | "settled", number>> = {
  needs_input: 0,
  active: 1,
  paused: 2,
  settled: 3,
};

export function missionGroup(mission: Pick<Mission, "status">): keyof typeof GROUP {
  if (needsInput(mission)) return "needs_input";
  if (isActive(mission)) return "active";
  if (mission.status === "interrupted") return "paused";
  return "settled";
}

/**
 * The order a person scans: needs-input first, then live work, then paused,
 * then settled. Ties break on the most recently updated, and ids settle any
 * remaining tie so the order is stable across renders.
 */
export function sortMissions<T extends Pick<Mission, "id" | "status" | "updatedAt">>(missions: readonly T[]): T[] {
  return [...missions].sort((a, b) => {
    const group = GROUP[missionGroup(a)] - GROUP[missionGroup(b)];
    if (group !== 0) return group;
    const byTime = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (Number.isFinite(byTime) && byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });
}

/** The needs-input missions, for the pinned strip above the tabs. */
export function needsInputMissions<T extends Pick<Mission, "status">>(missions: readonly T[]): T[] {
  return missions.filter(needsInput);
}
