/** Mission status as the new pages show it: a dot tone and a word.
 *
 * The vocabulary is the protocol's (`packages/agent-protocol/mission-status.ts`);
 * nothing here invents a state the authority cannot enter. */

import type { MissionStatus } from "../../../packages/agent-protocol/mission-status.ts";
import { isTerminalMissionStatus } from "../../../packages/agent-protocol/mission-status.ts";

/** The skin token a status mark paints with. Kept to the app's own tones so a
 * dot reads the same in every surface. */
export type StatusTone = "accent" | "success" | "warning" | "danger" | "neutral";

export function missionStatusTone(status: MissionStatus): StatusTone {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
    case "cancelled":
      return "danger";
    case "waiting_input":
    case "waiting_children":
    case "interrupted":
      return "warning";
    case "running":
    case "resuming":
    case "provisioning":
      return "accent";
    case "queued":
      return "neutral";
  }
}

/** Whether a mission is still open, so a page knows to keep polling it and to
 * offer interrupt rather than resume. */
export function isOpen(status: MissionStatus): boolean {
  return !isTerminalMissionStatus(status);
}

export function statusLabel(status: MissionStatus): string {
  return status.replaceAll("_", " ");
}
