import { t } from "@/lib/i18n";
/** The workbench shell: machines on the left, mission tabs on top, a BSP grid
 * of real terminals in the middle, and the mission's own panel on the right.
 *
 * Every mutation goes to the mission authority with the revision this screen
 * last read, and the answer is a refetch, never a local guess. A terminal's
 * chip is a chip: mission state comes from the snapshot alone.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentDescriptor } from "../../../packages/agent-protocol/agents.ts";
import type { Mission } from "../../../packages/agent-protocol/mission.ts";
import type { TerminalRef } from "../../../packages/agent-protocol/terminal.ts";
import {
  apiClient,
  cancelMission,
  getAgents,
  getMissionHistory,
  getMissions,
  getTerminals,
  interruptMission,
  resumeMission,
  steerMission,
  useLiveEvents,
  type MissionHistoryResponse,
} from "../foundation/api.ts";

import { initialLease } from "./control-lease.ts";
import { EMPTY_LOG, mergeEntries, refetchFrom, replaceEntries, type LogView } from "./event-log.ts";
import { browserStorage, loadLayout, saveLayout, type LayoutState, type StorageLike } from "./layout-storage.ts";
import { MissionPanel, type MissionCommandKind } from "./MissionPanel.tsx";
import { MissionTabStrip, openTabs, pinnedMissions } from "./MissionTabs.tsx";
import { buildTree, neighbourMission, toSummary, type MissionNode } from "./mission-tree.ts";
import { PaneGrid, type PaneTerminalInfo } from "./PaneGrid.tsx";
import {
  assignTerminal,
  closePane,
  leaves,
  paneCount,
  setRatio,
  splitPane,
  type PaneNode,
} from "./pane-tree.ts";
import { StartTerminalDialog, type StartTerminalDialogProps } from "./StartTerminalDialog.tsx";
import { startTerminal, toolForAgent, type TerminalTool } from "./start-terminal.ts";
import { useTerminalRegistry } from "./terminal-registry.ts";
import { WorkbenchSidebar, groupMachines } from "./WorkbenchSidebar.tsx";
import "./workbench-shell.css";
import "./workbench-panel.css";

export interface WorkbenchProps {
  /** Injected in tests; the browser's own storage in the app. */
  readonly storage?: StorageLike | null;
}

export function Workbench(props: WorkbenchProps = {}) {
  const storage = props.storage;
  const store = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage]);
  const [layout, setLayout] = useState<LayoutState>(() => loadLayout(store));
  const [missions, setMissions] = useState<readonly Mission[]>([]);
  const [terminals, setTerminals] = useState<readonly TerminalRef[]>([]);
  const [agents, setAgents] = useState<readonly AgentDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectionNote, setConnectionNote] = useState<string | null>(null);

  const [history, setHistory] = useState<LogView>(EMPTY_LOG);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [busy, setBusy] = useState<MissionCommandKind | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [nextMissions, nextTerminals, nextAgents, nextComputers] = await Promise.all([
        getMissions(),
        getTerminals(),
        getAgents(),
        readComputers(),
      ]);
      setMissions(nextMissions);
      setTerminals(nextTerminals);
      setAgents(nextAgents);
      setComputers(nextComputers);
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const live = useLiveEvents({
    onEvent: () => void load(),
    onResync: (reason) => {
      setConnectionNote(reason === undefined ? t("workspaceUi.copy68") : t("workspaceUi.refreshReason", { reason }));
      void load();
    },
  });

  useEffect(() => {
    saveLayout(store, layout);
  }, [layout, store]);

  const byId = useMemo(() => new Map(missions.map((mission) => [mission.id, mission])), [missions]);
  const summaries = useMemo(() => missions.map(toSummary), [missions]);
  const activeMission = layout.activeMissionId === null ? null : byId.get(layout.activeMissionId) ?? null;

  const tabs = useMemo(
    () => openTabs(layout.openMissionIds, new Map(summaries.map((summary) => [summary.id, summary])), layout.activeMissionId),
    [layout.openMissionIds, layout.activeMissionId, summaries],
  );
  const pinned = useMemo(() => pinnedMissions(summaries), [summaries]);
  const tree = useMemo<MissionNode<Mission>[]>(
    () => (activeMission ? buildTree(missions, activeMission.rootMissionId) : []),
    [missions, activeMission],
  );

  const paneTerminalIds = useMemo(
    () => leaves(layout.root).map((pane) => pane.terminalId).filter((id): id is string => id !== null),
    [layout.root],
  );
  const registry = useTerminalRegistry({ wanted: paneTerminalIds });

  const activeId = activeMission?.id ?? null;
  const activeRevision = activeMission?.revision ?? null;

  useEffect(() => {
    if (activeId === null) {
      setHistory(EMPTY_LOG);
      return undefined;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    getMissionHistory(activeId)
      .then((page: MissionHistoryResponse) => {
        if (!cancelled) setHistory(replaceEntries(page.events));
      })
      .catch((failure: unknown) => {
        if (!cancelled) setHistoryError(messageOf(failure));
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, activeRevision]);

  const resyncHistory = useCallback(async (): Promise<void> => {
    if (activeId === null) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const page = await getMissionHistory(activeId, { sinceSeq: refetchFrom(history) });
      setHistory(mergeEntries(history, page.events));
    } catch (failure) {
      setHistoryError(messageOf(failure));
    } finally {
      setHistoryLoading(false);
    }
  }, [activeId, history]);

  const openMission = useCallback((missionId: string): void => {
    setLayout((current) => ({
      ...current,
      openMissionIds: current.openMissionIds.includes(missionId) ? current.openMissionIds : [...current.openMissionIds, missionId],
      activeMissionId: missionId,
    }));
  }, []);

  const closeMission = useCallback((missionId: string): void => {
    setLayout((current) => {
      const open = current.openMissionIds.filter((id) => id !== missionId);
      const next = current.activeMissionId === missionId ? neighbourMission(current.openMissionIds, missionId) : current.activeMissionId;
      return { ...current, openMissionIds: open, activeMissionId: next !== null && open.includes(next) ? next : (open[0] ?? null) };
    });
  }, []);

  const pickTerminal = useCallback((terminalId: string): void => {
    setLayout((current) => {
      const paneId = current.focusedPaneId ?? leaves(current.root)[0]?.id ?? null;
      if (paneId === null) {
        return { ...current, root: { kind: "leaf", id: "pane-1", terminalId }, focusedPaneId: "pane-1" };
      }
      return { ...current, root: assignTerminal(current.root, paneId, terminalId) };
    });
  }, []);

  const focus = useCallback((paneId: string): void => {
    setLayout((current) => (current.focusedPaneId === paneId ? current : { ...current, focusedPaneId: paneId }));
  }, []);

  const split = useCallback((paneId: string, orientation: "horizontal" | "vertical"): void => {
    setLayout((current) => {
      const id = nextPaneId(current.root);
      const root = splitPane(current.root, paneId, id, orientation);
      return root === current.root ? current : { ...current, root, focusedPaneId: id };
    });
  }, []);

  const close = useCallback((paneId: string): void => {
    setLayout((current) => {
      const root = closePane(current.root, paneId);
      if (root === null) {
        return { ...current, root: { kind: "leaf", id: "pane-1", terminalId: null }, focusedPaneId: "pane-1", zoomedPaneId: null };
      }
      const remaining = leaves(root);
      return {
        ...current,
        root,
        focusedPaneId: current.focusedPaneId === paneId ? (remaining[0]?.id ?? null) : current.focusedPaneId,
        zoomedPaneId: current.zoomedPaneId === paneId ? null : current.zoomedPaneId,
      };
    });
  }, []);

  const ratio = useCallback((splitId: string, value: number): void => {
    setLayout((current) => ({ ...current, root: setRatio(current.root, splitId, value) }));
  }, []);

  const zoom = useCallback((paneId: string | null): void => {
    setLayout((current) => ({ ...current, zoomedPaneId: paneId }));
  }, []);

  const runCommand = useCallback(async (
    kind: MissionCommandKind,
    action: (missionId: string, revision: number) => Promise<unknown>,
  ): Promise<void> => {
    if (activeId === null || activeRevision === null) return;
    setBusy(kind);
    setCommandError(null);
    try {
      await action(activeId, activeRevision);
      await load();
    } catch (failure) {
      setCommandError(messageOf(failure));
    } finally {
      setBusy(null);
    }
  }, [activeId, activeRevision, load]);

  const machines = useMemo(() => groupMachines(missions, terminals, paneTerminalIds), [missions, terminals, paneTerminalIds]);
  /** The computers a terminal may start on come from the environment layer's
   * own list, not from the missions: a mission's `environment` is a reference
   * that a fixture may fill with a placeholder, and starting a terminal on a
   * placeholder id is a request the server can only refuse. */
  const [computers, setComputers] = useState<StartTerminalDialogProps["environments"]>([]);
  const environments = useMemo(() => {
    if (computers.length > 0) return computers;
    // Before the list arrives, fall back to what the missions name so the
    // dialog is never empty; the real list replaces it on the first read.
    const seen = new Map<string, string>();
    for (const mission of missions) seen.set(mission.environment.id, mission.environment.label);
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [computers, missions]);

  const startAgentTerminal = useCallback(async (request: { environmentId: string; tool: TerminalTool }): Promise<void> => {
    setStarting(true);
    setStartError(null);
    try {
      const terminal = await startTerminal({
        environmentId: request.environmentId,
        tool: request.tool,
        ...(activeMission !== null ? { missionId: activeMission.id } : {}),
        ...(activeMission?.activeRunId !== undefined ? { runId: activeMission.activeRunId } : {}),
      });
      await load();
      pickTerminal(terminal.id);
      setPicker(false);
    } catch (failure) {
      setStartError(messageOf(failure));
    } finally {
      setStarting(false);
    }
  }, [activeMission, load, pickTerminal]);

  const openAgentTerminal = useCallback((): void => {
    if (activeMission === null || toolForAgent(activeMission.agent) === null) {
      setStartError(null);
      setPicker(true);
      return;
    }
    void startAgentTerminal({ environmentId: activeMission.environment.id, tool: toolForAgent(activeMission.agent) as TerminalTool });
  }, [activeMission, startAgentTerminal]);
  const focusedTerminalId = leaves(layout.root).find((pane) => pane.id === layout.focusedPaneId)?.terminalId ?? null;

  const panes = useMemo(() => {
    const record: Record<string, PaneTerminalInfo> = {};
    for (const terminal of terminals) {
      const binding = registry.bindings[terminal.id];
      const mission = byId.get(terminal.missionId);
      record[terminal.id] = {
        terminalId: terminal.id,
        title: mission === undefined ? terminal.id : `${mission.title} · ${terminal.kind}`,
        missionTitle: mission?.title ?? null,
        connection: binding?.connection ?? null,
        lease: binding?.lease ?? initialLease(),
        error: null,
      };
    }
    return record;
  }, [terminals, registry.bindings, byId]);

  return (
    <div className="wb-shell" data-testid="workbench">
      <WorkbenchSidebar
        machines={machines}
        agents={agents}
        missions={missions}
        collapsed={layout.sidebarCollapsed}
        loading={loading}
        error={error}
        focusedTerminalId={focusedTerminalId}
        onToggle={() => setLayout((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }))}
        onPickTerminal={pickTerminal}
        onOpenMission={openMission}
        onRetry={() => {
          setLoading(true);
          void load();
        }}
      />

      <div className="wb-main">
        <MissionTabStrip
          open={tabs}
          activeId={layout.activeMissionId}
          needsInput={pinned}
          onSelect={(missionId) => setLayout((current) => ({ ...current, activeMissionId: missionId }))}
          onClose={closeMission}
          onOpen={openMission}
        />
        {connectionNote === null ? null : (
          <p className="wb-banner" role="status">
            {connectionNote}
            <button type="button" className="wb-link-button" onClick={() => setConnectionNote(null)}>{t("update.banner.dismiss")}</button>
          </p>
        )}
        <div className="wb-body">
          <PaneGrid
            root={layout.root}
            focusedPaneId={layout.focusedPaneId}
            zoomedPaneId={layout.zoomedPaneId}
            panes={panes}
            onFocus={focus}
            onRatio={ratio}
            onSplit={split}
            onClose={close}
            onZoom={zoom}
            onAcquire={registry.acquire}
            onRelease={registry.release}
            onRetry={registry.retry}
            onPickTerminal={() => {
              const first = terminals[0];
              if (first) pickTerminal(first.id);
            }}
            onStartTerminal={openAgentTerminal}
            empty={<p className="wb-hint">{t("workspaceUi.copy44")}</p>}
          />
          <MissionPanel
            mission={activeMission}
            tree={tree}
            history={history}
            historyLoading={historyLoading}
            historyError={historyError}
            busy={busy}
            commandError={commandError}
            canMutate={live.status !== "closed"}
            onSteer={(input) => void runCommand("steer", (id, revision) => steerMission(id, revision, input))}
            onInterrupt={() => void runCommand("interrupt", (id, revision) => interruptMission(id, revision))}
            onResume={() => void runCommand("resume", (id, revision) => resumeMission(id, revision))}
            onCancel={() => void runCommand("cancel", (id, revision) => cancelMission(id, revision))}
            onResync={() => void resyncHistory()}
            onSelect={openMission}
          />
        </div>
        <footer className="wb-status">
          <span className="wb-chip" data-tone={live.status === "open" ? "success" : live.status === "retrying" ? "warning" : "neutral"}>
            {live.status === "open" ? t("trace.live") : live.status === "retrying" ? t("workspaceUi.copy91") : live.status === "connecting" ? t("workspaceUi.copy89") : t("workspaceUi.offline")}
          </span>
          <span className="wb-hint">{paneCount(layout.root)} {paneCount(layout.root) === 1 ? "pane" : "panes"}</span>
          <button type="button" className="wb-link-button" onClick={openAgentTerminal}>{t("workspaceUi.copy11")}</button>
          <button type="button" className="wb-link-button" onClick={() => void load()}>{t("workspaces.refresh")}</button>
        </footer>
        {picker ? (
          <StartTerminalDialog
            mission={activeMission}
            environments={environments}
            busy={starting}
            error={startError}
            onStart={(request) => void startAgentTerminal(request)}
            onCancel={() => setPicker(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

function nextPaneId(root: PaneNode): string {
  const used = new Set(leaves(root).map((pane) => pane.id));
  let index = used.size + 1;
  while (used.has(`pane-${index}`)) index += 1;
  return `pane-${index}`;
}

async function readComputers(): Promise<StartTerminalDialogProps["environments"]> {
  const body = await apiClient().request<{
    environments: StartTerminalDialogProps["environments"];
  }>("/environments");
  return body.environments;
}

function messageOf(failure: unknown): string {
  if (failure instanceof Error && failure.message !== "") return failure.message;
  return t("workspaceUi.copy67");
}
