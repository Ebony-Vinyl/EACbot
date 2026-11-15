/** What the workbench reads from `/api/v1`, refreshed by the live stream.
 *
 * The stream is a hint, not a state feed: a notification says a mission moved,
 * and the answer is to read the authoritative snapshot again. A `resync`
 * forces the same refetch, because a gap means the view may be wrong. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDescriptor } from "../../packages/agent-protocol/agents.ts";
import type { Mission } from "../../packages/agent-protocol/mission.ts";
import { apiClient, getAgents, getMissions, useAuth } from "./foundation/api.ts";
import { authToken, isApiError, type ApiError } from "./foundation/http.ts";
import { useLiveEvents, type LiveEventsState } from "./foundation/use-live-events.ts";

/** A computer as `GET /api/v1/environments` reports it: the environment layer's
 * own record (`core/environments/types.ts`), which is a different shape from
 * the protocol's `EnvironmentRef`. The record names where to connect; it never
 * carries a key or a password. */
export interface ComputerRecord {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly status: string;
  readonly hostKeyFingerprint?: string;
}

export interface WorkbenchData {
  readonly agents: readonly AgentDescriptor[];
  readonly missions: readonly Mission[];
  readonly computers: readonly ComputerRecord[];
  readonly loading: boolean;
  readonly error: ApiError | null;
  readonly live: LiveEventsState;
  readonly refresh: () => void;
}

/** One distinct computer per id, from the environments the missions themselves
 * name. Used when the environments route has nothing yet, so a task's own
 * record still says what it runs on. */
export function computersOf(missions: readonly Mission[]): readonly ComputerRecord[] {
  const seen = new Map<string, ComputerRecord>();
  for (const mission of missions) {
    const environment = mission.environment;
    if (seen.has(environment.id)) continue;
    seen.set(environment.id, {
      id: environment.id,
      label: environment.label,
      host: environment.host ?? "",
      port: environment.port ?? 22,
      user: environment.user ?? "",
      status: "unknown",
    });
  }
  return [...seen.values()];
}

export function useWorkbenchData(): WorkbenchData {
  const auth = useAuth();
  const paired = auth.status === "paired" ? auth.token : null;
  const [agents, setAgents] = useState<readonly AgentDescriptor[]>([]);
  const [missions, setMissions] = useState<readonly Mission[]>([]);
  const [computers, setComputers] = useState<readonly ComputerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (authToken() === null) {
      setLoading(false);
      return;
    }
    const mine = ++generation.current;
    setLoading(true);
    try {
      const [nextAgents, nextMissions, nextComputers] = await Promise.all([
        getAgents(),
        getMissions(),
        readComputers(),
      ]);
      if (mine !== generation.current) return;
      setAgents(nextAgents);
      setMissions(nextMissions);
      setComputers(nextComputers.length > 0 ? nextComputers : computersOf(nextMissions));
      setError(null);
    } catch (caught) {
      if (mine !== generation.current) return;
      setError(isApiError(caught) ? caught : null);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  /** Pairing is the moment the token exists, so the first read that can succeed
   * is the one after it: a refetch keyed on the token is what turns an empty
   * shell into the person's own data. */
  useEffect(() => {
    void load();
  }, [load, paired]);

  const live = useLiveEvents({
    onEvent: () => void load(),
    onResync: () => void load(),
  });

  return { agents, missions, computers, loading, error, live, refresh: () => void load() };
}

/** `GET /api/v1/environments` returns each record with a `lastTest` beside it.
 * Only the connection facts the shell shows are kept. */
async function readComputers(): Promise<readonly ComputerRecord[]> {
  const body = await apiClient().request<{
    environments: readonly (Partial<ComputerRecord> & { readonly id: string; readonly label: string })[];
  }>("/environments");
  return body.environments.map((record) => ({
    id: record.id,
    label: record.label,
    host: record.host ?? "",
    port: record.port ?? 22,
    user: record.user ?? "",
    status: record.status ?? "unknown",
    ...(record.hostKeyFingerprint !== undefined ? { hostKeyFingerprint: record.hostKeyFingerprint } : {}),
  }));
}

export type MissionSort = "recent" | "title" | "status";

export function sortedMissions(missions: readonly Mission[], sort: MissionSort): readonly Mission[] {
  const copy = [...missions];
  if (sort === "title") return copy.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === "status") return copy.sort((a, b) => a.status.localeCompare(b.status) || a.title.localeCompare(b.title));
  return copy.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
