import type { MissionLogEntry } from "../../packages/agent-protocol/events.ts";
import type { Mission, MissionTreeNode } from "../../packages/agent-protocol/mission.ts";
import type { MissionRuntime } from "../missions/runtime.ts";
import type { MissionPort } from "../http/ports.ts";

/** Bridges the HTTP layer to `MissionRuntime`. Every read comes from the
 * runtime's own store and every write goes through `execute`, so a route can
 * never hold a mission copy that disagrees with the authority. */
export function missionPort(runtime: MissionRuntime): MissionPort {
  return {
    execute: (command) => runtime.execute(command),
    getMission: (id: string): Mission | undefined => runtime.store.getMission(id),
    listMissions: (): Mission[] => runtime.store.listMissions(),
    missionTree: (rootMissionId: string): MissionTreeNode | undefined => runtime.store.missionTree(rootMissionId),
    events: (missionId: string, options?: { sinceSeq?: number; limit?: number }): MissionLogEntry[] =>
      runtime.log.events(missionId, options ?? {}),
  };
}
