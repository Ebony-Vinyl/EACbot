/** Layout persistence: the pane tree, focus, zoom and open tabs survive a
 * reload.
 *
 * Storage is best-effort. A browser with storage disabled, a quota error or a
 * payload written by an older build all fall back to the default layout rather
 * than leaving a blank workbench: a broken layout is not worth an error page.
 */

import { clampRatio, leaves, nodeIds, type PaneNode, type PaneOrientation } from "./pane-tree.ts";

export const LAYOUT_STORAGE_KEY = "eacbot.next.workbench.layout";
export const LAYOUT_VERSION = 1;

export interface LayoutState {
  readonly root: PaneNode;
  readonly focusedPaneId: string | null;
  readonly zoomedPaneId: string | null;
  /** Tabs the person has open, in strip order; the first is selected. */
  readonly openMissionIds: readonly string[];
  readonly activeMissionId: string | null;
  readonly sidebarCollapsed: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function defaultLayout(): LayoutState {
  return {
    root: { kind: "leaf", id: "pane-1", terminalId: null },
    focusedPaneId: "pane-1",
    zoomedPaneId: null,
    openMissionIds: [],
    activeMissionId: null,
    sidebarCollapsed: false,
  };
}

const ORIENTATIONS: readonly PaneOrientation[] = ["horizontal", "vertical"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNode(value: unknown, depth = 0): PaneNode | null {
  if (!isRecord(value) || depth > 32) return null;
  const id = value.id;
  if (typeof id !== "string" || id.length === 0) return null;
  if (value.kind === "leaf") {
    const terminalId = value.terminalId;
    if (terminalId !== null && terminalId !== undefined && typeof terminalId !== "string") return null;
    return { kind: "leaf", id, terminalId: typeof terminalId === "string" ? terminalId : null };
  }
  if (value.kind !== "split") return null;
  if (!ORIENTATIONS.includes(value.orientation as PaneOrientation)) return null;
  const first = readNode(value.first, depth + 1);
  const second = readNode(value.second, depth + 1);
  if (!first || !second) return null;
  const ratio = typeof value.ratio === "number" ? clampRatio(value.ratio) : 0.5;
  return { kind: "split", id, orientation: value.orientation as PaneOrientation, ratio, first, second };
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Parses a stored payload. Anything inconsistent yields the default layout,
 * and a stored focus or zoom that names no pane is dropped. */
export function parseLayout(raw: string | null): LayoutState {
  if (raw === null || raw.trim() === "") return defaultLayout();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return defaultLayout();
  }
  if (!isRecord(parsed) || parsed.version !== LAYOUT_VERSION) return defaultLayout();
  const root = readNode(parsed.root);
  if (!root) return defaultLayout();
  const ids = new Set(nodeIds(root));
  const focusedPaneId = typeof parsed.focusedPaneId === "string" && ids.has(parsed.focusedPaneId)
    ? parsed.focusedPaneId
    : (leaves(root)[0]?.id ?? null);
  const zoomedPaneId = typeof parsed.zoomedPaneId === "string" && ids.has(parsed.zoomedPaneId)
    ? parsed.zoomedPaneId
    : null;
  const openMissionIds = [...new Set(readStrings(parsed.openMissionIds))];
  const activeMissionId = typeof parsed.activeMissionId === "string" && openMissionIds.includes(parsed.activeMissionId)
    ? parsed.activeMissionId
    : (openMissionIds[0] ?? null);
  return {
    root,
    focusedPaneId,
    zoomedPaneId,
    openMissionIds,
    activeMissionId,
    sidebarCollapsed: parsed.sidebarCollapsed === true,
  };
}

export function serializeLayout(state: LayoutState): string {
  return JSON.stringify({
    version: LAYOUT_VERSION,
    root: state.root,
    focusedPaneId: state.focusedPaneId,
    zoomedPaneId: state.zoomedPaneId,
    openMissionIds: state.openMissionIds,
    activeMissionId: state.activeMissionId,
    sidebarCollapsed: state.sidebarCollapsed,
  });
}

export function loadLayout(storage: StorageLike | null | undefined): LayoutState {
  if (!storage) return defaultLayout();
  try {
    return parseLayout(storage.getItem(LAYOUT_STORAGE_KEY));
  } catch {
    return defaultLayout();
  }
}

/** Writes the layout. Returns false when the browser refused, so a caller can
 * say "this will not be remembered" instead of pretending it saved. */
export function saveLayout(storage: StorageLike | null | undefined, state: LayoutState): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, serializeLayout(state));
    return true;
  } catch {
    return false;
  }
}

/** The browser's storage, or null where there is none (tests, SSR). */
export function browserStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}
