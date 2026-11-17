/**
 * The only file in this feature that knows how `src/next/foundation` answers.
 *
 * Foundation owns the bearer session, the request envelope and the live
 * notification stream. Everything here is an adapter onto the four states a
 * screen renders — loading, ready, unauthorized, error — so a change in how a
 * request is authorised never reaches a view.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentDescriptor, ModelCatalogEntry } from "../../../packages/agent-protocol/agents.ts";
import type { Mission, MissionTreeNode } from "../../../packages/agent-protocol/mission.ts";
import type { MissionLogEntry } from "../../../packages/agent-protocol/events.ts";
import { apiClient, isApiError } from "../foundation/http.ts";
import type { Notification } from "../foundation/notifications.ts";
import { useLiveEvents } from "../foundation/use-live-events.ts";
import type { EnvironmentRecord, EnvironmentTestResult, Loadable, LiveNotification, NewEnvironment } from "./port.ts";

/** A failed request, with the facts a person can act on: whether the session
 * is gone, whether the revision they saw is stale, and what the server said. */
export class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

export function requestErrorOf(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  if (isApiError(error)) return new RequestError(error.message, error.status, error.code);
  return new RequestError(error instanceof Error ? error.message : "请求没有到达服务器", 0, "network_error");
}

/** What to say when an action fails. A stale revision is the one refusal a
 * person resolves by reloading, so it says so instead of "try again". */
export function actionFailureMessage(error: unknown): string {
  const failure = requestErrorOf(error);
  if (failure.status === 401) return "登录已失效，请重新配对这个设备。";
  if (failure.status === 403) return "这个设备没有修改任务的权限。";
  if (failure.code === "revision_conflict" || failure.status === 409) return "这个任务已被其他地方修改，请重新载入后再试。";
  if (failure.code === "already_settled") return "这个操作已经完成，不需要再做一次。";
  if (failure.code === "capability_missing") return "该 Agent 不支持这个操作。";
  if (failure.status === 404) return "这个任务已经不存在了。";
  if (failure.status === 0) return `无法连接服务器：${failure.message}`;
  return failure.message;
}

/** One read, with a stable retry that starts a new attempt. `load: null` means
 * the screen has nothing to ask for yet and stays loading. */
export function useResource<T>(load: (() => Promise<T>) | null, deps: readonly unknown[]): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const generation = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const run = useCallback(() => {
    const mine = ++generation.current;
    const current = loader.current;
    if (current === null) {
      setState({ status: "loading" });
      return;
    }
    setState((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
    current().then(
      (data) => {
        if (mine === generation.current) setState({ status: "ready", data, refresh: run });
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        const failure = requestErrorOf(error);
        setState(
          failure.status === 401
            ? { status: "unauthorized" }
            : { status: "error", message: actionFailureMessage(error), retry: run },
        );
      },
    );
  }, []);

  // The dependency list is the caller's, spread so a new mission id or cursor
  // starts a fresh read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(run, [run, ...deps]);

  return state;
}

/** Reads through foundation's client, so the bearer and the error envelope
 * are the same ones every other workbench request uses. */
export function request<T>(path: string): Promise<T> {
  return apiClient().request<T>(path);
}

export function useMissions(): Loadable<readonly Mission[]> {
  return useResource<readonly Mission[]>(async () => (await request<{ missions: Mission[] }>("/missions")).missions, []);
}

export function useMission(missionId: string | null): Loadable<Mission> {
  return useResource<Mission>(
    missionId === null ? null : async () => (await request<{ mission: Mission }>(`/missions/${encodeURIComponent(missionId)}`)).mission,
    [missionId],
  );
}

export function useMissionTree(missionId: string | null): Loadable<MissionTreeNode> {
  return useResource<MissionTreeNode>(
    missionId === null ? null : async () => (await request<{ tree: MissionTreeNode }>(`/missions/${encodeURIComponent(missionId)}/tree`)).tree,
    [missionId],
  );
}

export interface HistoryPage {
  readonly events: readonly MissionLogEntry[];
  readonly nextSeq: number;
}

export function useMissionHistory(missionId: string | null, sinceSeq?: number): Loadable<HistoryPage> {
  const query = sinceSeq !== undefined && sinceSeq > 0 ? `?since=${sinceSeq}` : "";
  return useResource<HistoryPage>(
    missionId === null ? null : () => request<HistoryPage>(`/missions/${encodeURIComponent(missionId)}/history${query}`),
    [missionId, sinceSeq],
  );
}

export function useAgents(): Loadable<readonly AgentDescriptor[]> {
  return useResource<readonly AgentDescriptor[]>(async () => (await request<{ agents: AgentDescriptor[] }>("/agents")).agents, []);
}

export interface AgentModels {
  readonly models: readonly ModelCatalogEntry[];
  readonly reported: boolean;
}

export function useAgentModels(kind: string | null): Loadable<AgentModels> {
  return useResource<AgentModels>(
    kind === null
      ? null
      : async () => {
          const body = await request<{ models: ModelCatalogEntry[]; reported: boolean }>(`/agents/${encodeURIComponent(kind)}/models`);
          return { models: body.models, reported: body.reported };
        },
    [kind],
  );
}

export function useEnvironments(): Loadable<readonly EnvironmentRecord[]> {
  return useResource<readonly EnvironmentRecord[]>(
    async () => (await request<{ environments: EnvironmentRecord[] }>("/environments")).environments,
    [],
  );
}

/** Subscribes to the live stream for the calling component's lifetime. A
 * resync arrives as a notification too, because a gap means the view may be
 * wrong and the only safe answer is to read the snapshot again. */
export function useNotifications(handler: (notification: LiveNotification) => void): { readonly status: string } {
  const latest = useRef(handler);
  latest.current = handler;
  const state = useLiveEvents({
    onEvent: (notification: Notification) => latest.current(notification),
    onResync: () => latest.current({ kind: "stream.resync" }),
  });
  return { status: state.status };
}

/** Environments. Creating one records where a credential lives, never the
 * credential; the route takes connection facts only. */
export const environmentActions = {
  create(input: NewEnvironment): Promise<EnvironmentRecord> {
    return apiClient()
      .request<{ environment: EnvironmentRecord }>("/environments", { method: "POST", body: { ...input } })
      .then((body) => body.environment);
  },
  test(id: string): Promise<EnvironmentTestResult> {
    return apiClient().request<EnvironmentTestResult>(`/environments/${encodeURIComponent(id)}/test`, { method: "POST", body: {} });
  },
  remove(id: string): Promise<void> {
    return apiClient().request<void>(`/environments/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};
