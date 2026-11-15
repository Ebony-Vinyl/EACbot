/** The pane grid: a BSP tree drawn as flex panes with a draggable divider at
 * every split, and one real terminal per pane.
 *
 * Focus belongs to exactly one pane. A pane that is not focused still draws
 * its stream but takes no keystrokes, and its chrome says so. Zoom shows one
 * pane large while every other terminal stays mounted in a hidden slot: a
 * terminal is mounted exactly once, so no stream is written twice and no
 * screen is thrown away by opening or leaving zoom.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { describeLease, type LeaseState } from "./control-lease.ts";
import { adjacentPane, cyclePane, leaves, type PaneNode, type PaneRect } from "./pane-tree.ts";
import type { TerminalChip } from "./status.ts";
import type { TerminalConnection } from "./terminal-transport.ts";
import { TerminalSurface } from "./TerminalSurface.tsx";

export interface PaneTerminalInfo {
  readonly terminalId: string;
  readonly title: string;
  readonly missionTitle: string | null;
  /** Null while the stream is being asked for. */
  readonly connection: TerminalConnection | null;
  readonly lease: LeaseState;
  readonly error: string | null;
}

export interface PaneGridProps {
  readonly root: PaneNode;
  readonly focusedPaneId: string | null;
  readonly zoomedPaneId: string | null;
  readonly panes: Readonly<Record<string, PaneTerminalInfo>>;
  readonly onFocus: (paneId: string) => void;
  readonly onRatio: (splitId: string, ratio: number) => void;
  readonly onSplit: (paneId: string, orientation: "horizontal" | "vertical") => void;
  readonly onClose: (paneId: string) => void;
  readonly onZoom: (paneId: string | null) => void;
  readonly onAcquire: (terminalId: string) => void;
  readonly onRelease: (terminalId: string) => void;
  readonly onRetry: (terminalId: string) => void;
  readonly onPickTerminal: (paneId: string) => void;
  readonly onStartTerminal: () => void;
  readonly empty: ReactNode;
}

const DIVIDER = 8;

interface PaneActions {
  readonly onFocus: (paneId: string) => void;
  readonly onSplit: (paneId: string, orientation: "horizontal" | "vertical") => void;
  readonly onClose: (paneId: string) => void;
  readonly onZoom: (paneId: string | null) => void;
  readonly onAcquire: (terminalId: string) => void;
  readonly onRelease: (terminalId: string) => void;
  readonly onRetry: (terminalId: string) => void;
  readonly onPickTerminal: (paneId: string) => void;
  readonly onStartTerminal: () => void;
}

export function PaneGrid(props: PaneGridProps) {
  const { root, focusedPaneId, zoomedPaneId, panes } = props;
  const [box, setBox] = useState<PaneRect>({ x: 0, y: 0, width: 0, height: 0 });
  const [dragging, setDragging] = useState<string | null>(null);
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const measure = (): void => setBox({ x: 0, y: 0, width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const actions: PaneActions = {
    onFocus: props.onFocus,
    onSplit: props.onSplit,
    onClose: props.onClose,
    onZoom: props.onZoom,
    onAcquire: props.onAcquire,
    onRelease: props.onRelease,
    onRetry: props.onRetry,
    onPickTerminal: props.onPickTerminal,
    onStartTerminal: props.onStartTerminal,
  };

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!event.altKey && !event.metaKey) return;
    const focus = (paneId: string | null): void => {
      if (paneId !== null) props.onFocus(paneId);
    };
    const shortcuts: Record<string, () => void> = {
      ArrowLeft: () => focus(focusedPaneId === null ? null : adjacentPane(root, focusedPaneId, "left", box, DIVIDER)),
      ArrowRight: () => focus(focusedPaneId === null ? null : adjacentPane(root, focusedPaneId, "right", box, DIVIDER)),
      ArrowUp: () => focus(focusedPaneId === null ? null : adjacentPane(root, focusedPaneId, "up", box, DIVIDER)),
      ArrowDown: () => focus(focusedPaneId === null ? null : adjacentPane(root, focusedPaneId, "down", box, DIVIDER)),
      "[": () => focus(focusedPaneId === null ? null : cyclePane(root, focusedPaneId, -1)),
      "]": () => focus(focusedPaneId === null ? null : cyclePane(root, focusedPaneId, 1)),
      "\\": () => focusedPaneId !== null && props.onSplit(focusedPaneId, "horizontal"),
      "-": () => focusedPaneId !== null && props.onSplit(focusedPaneId, "vertical"),
      Enter: () => (zoomedPaneId === null ? focusedPaneId !== null && props.onZoom(focusedPaneId) : props.onZoom(null)),
    };
    const run = shortcuts[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  }, [box, focusedPaneId, props, root, zoomedPaneId]);

  const order = leaves(root).map((pane) => pane.id);
  if (order.length === 0) return <div className="wb-panes wb-panes-empty">{props.empty}</div>;

  if (zoomedPaneId !== null && order.includes(zoomedPaneId)) {
    const node = leaves(root).find((pane) => pane.id === zoomedPaneId);
    return (
      <div ref={host} className="wb-panes" data-zoomed="true" onKeyDown={onKeyDown} data-testid="pane-grid">
        <div className="wb-zoom-bar">
          <button
            type="button"
            className="wb-icon-button"
            onClick={() => props.onFocus(cyclePane(root, zoomedPaneId, -1) ?? zoomedPaneId)}
            title="Previous pane"
          >
            ‹
          </button>
          <span className="wb-zoom-label">{node?.terminalId ? panes[node.terminalId]?.title ?? "Terminal" : "Terminal"}</span>
          <button
            type="button"
            className="wb-icon-button"
            onClick={() => props.onFocus(cyclePane(root, zoomedPaneId, 1) ?? zoomedPaneId)}
            title="Next pane"
          >
            ›
          </button>
          <button type="button" className="wb-button" onClick={() => props.onZoom(null)}>Leave zoom</button>
        </div>
        <div className="wb-zoom-body">
          <PaneFrame
            paneId={zoomedPaneId}
            terminalId={node?.terminalId ?? null}
            info={node?.terminalId ? panes[node.terminalId] : undefined}
            focused={focusedPaneId === zoomedPaneId}
            actions={actions}
          />
        </div>
        <div className="wb-offscreen" aria-hidden="true">
          {order.filter((paneId) => paneId !== zoomedPaneId).map((paneId) => {
            const other = leaves(root).find((pane) => pane.id === paneId);
            return (
              <PaneFrame
                key={paneId}
                paneId={paneId}
                terminalId={other?.terminalId ?? null}
                info={other?.terminalId ? panes[other.terminalId] : undefined}
                focused={false}
                actions={actions}
                inert
              />
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div ref={host} className="wb-panes" data-zoomed="false" onKeyDown={onKeyDown} data-testid="pane-grid">
      <PaneNodeView
        node={root}
        panes={panes}
        focusedPaneId={focusedPaneId}
        actions={actions}
        onRatio={props.onRatio}
        dragging={dragging}
        onDragStart={setDragging}
        onDragEnd={() => setDragging(null)}
      />
    </div>
  );
}

interface NodeViewProps {
  readonly node: PaneNode;
  readonly panes: Readonly<Record<string, PaneTerminalInfo>>;
  readonly focusedPaneId: string | null;
  readonly actions: PaneActions;
  readonly onRatio: (splitId: string, ratio: number) => void;
  readonly dragging: string | null;
  readonly onDragStart: (splitId: string) => void;
  readonly onDragEnd: () => void;
}

function PaneNodeView(props: NodeViewProps): React.ReactElement {
  const { node } = props;
  if (node.kind === "leaf") {
    return (
      <PaneFrame
        paneId={node.id}
        terminalId={node.terminalId}
        info={node.terminalId === null ? undefined : props.panes[node.terminalId]}
        focused={props.focusedPaneId === node.id}
        actions={props.actions}
      />
    );
  }
  return (
    <div className="wb-split" data-orientation={node.orientation} role="group" aria-label={node.orientation === "horizontal" ? "Panes side by side" : "Panes stacked"}>
      <div className="wb-split-child" style={{ flex: `0 0 ${node.ratio * 100}%` }}>
        <PaneNodeView {...props} node={node.first} />
      </div>
      <Divider
        splitId={node.id}
        orientation={node.orientation}
        ratio={node.ratio}
        dragging={props.dragging === node.id}
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
        onRatio={props.onRatio}
      />
      <div className="wb-split-child" style={{ flex: `0 0 ${(1 - node.ratio) * 100}%` }}>
        <PaneNodeView {...props} node={node.second} />
      </div>
    </div>
  );
}

interface DividerProps {
  readonly splitId: string;
  readonly orientation: "horizontal" | "vertical";
  readonly ratio: number;
  readonly dragging: boolean;
  readonly onDragStart: (splitId: string) => void;
  readonly onDragEnd: () => void;
  readonly onRatio: (splitId: string, ratio: number) => void;
}

function Divider({ splitId, orientation, ratio, dragging, onDragStart, onDragEnd, onRatio }: DividerProps) {
  const horizontal = orientation === "horizontal";

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onDragStart(splitId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect) return;
    onRatio(splitId, horizontal ? (event.clientX - rect.left) / Math.max(1, rect.width) : (event.clientY - rect.top) / Math.max(1, rect.height));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const delta = horizontal
      ? event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0
      : event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (delta === 0) return;
    event.preventDefault();
    onRatio(splitId, ratio + delta);
  };

  return (
    <div
      className="wb-divider"
      role="separator"
      tabIndex={0}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-label={horizontal ? "Resize panes side by side" : "Resize stacked panes"}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={12}
      aria-valuemax={88}
      data-dragging={dragging ? "true" : "false"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
      onKeyDown={onKeyDown}
      style={{ flex: `0 0 ${DIVIDER}px`, ...(dragging ? { cursor: horizontal ? "col-resize" : "row-resize" } : {}) }}
    />
  );
}

interface PaneFrameProps {
  readonly paneId: string;
  readonly terminalId: string | null;
  readonly info: PaneTerminalInfo | undefined;
  readonly focused: boolean;
  readonly actions: PaneActions;
  readonly style?: CSSProperties;
  /** A pane kept mounted off screen while another is zoomed. */
  readonly inert?: boolean;
}

function PaneFrame({ paneId, terminalId, info, focused, actions, style, inert = false }: PaneFrameProps): React.ReactElement {
  const [title, setTitle] = useState<string | null>(null);
  const [chip, setChip] = useState<TerminalChip | null>(null);
  const lease = info ? describeLease(info.lease) : null;
  const connection = info?.connection ?? null;
  const held = info?.lease.kind === "held-by-other" ? info.lease.holder : null;

  return (
    <section
      className="wb-pane"
      style={style}
      data-focused={focused ? "true" : "false"}
      data-testid={`pane-${paneId}`}
      aria-label={info?.title ?? "Terminal pane"}
      aria-hidden={inert ? "true" : undefined}
      onPointerDown={inert ? undefined : () => actions.onFocus(paneId)}
    >
      <header className="wb-pane-head">
        <button
          type="button"
          className="wb-pane-title"
          onClick={() => actions.onFocus(paneId)}
          aria-current={focused ? "true" : undefined}
          tabIndex={inert ? -1 : 0}
          title={info ? `${info.title} · ${info.missionTitle ?? "no mission"}` : "No terminal"}
        >
          <span className="wb-pane-name">{title ?? info?.title ?? "No terminal"}</span>
          {info?.missionTitle ? <span className="wb-pane-mission">{info.missionTitle}</span> : null}
        </button>
        <div className="wb-pane-badges">
          {chip ? <span className="wb-chip" data-tone={chip.tone}>{chip.label}</span> : null}
          {lease ? <span className="wb-chip" data-tone={lease.canSend ? "accent" : "neutral"}>{lease.canSend ? "In control" : "Watching"}</span> : null}
        </div>
        <div className="wb-pane-actions">
          {terminalId !== null && lease ? (
            lease.canSend ? (
              <button type="button" className="wb-icon-button" onClick={() => actions.onRelease(terminalId)} title="Stop controlling this terminal" tabIndex={inert ? -1 : 0}>
                Release
              </button>
            ) : (
              <button type="button" className="wb-icon-button" onClick={() => actions.onAcquire(terminalId)} title="Take control of this terminal" tabIndex={inert ? -1 : 0}>
                Take control
              </button>
            )
          ) : null}
          <button type="button" className="wb-icon-button" onClick={() => actions.onSplit(paneId, "horizontal")} title="Split right" tabIndex={inert ? -1 : 0}>⇥</button>
          <button type="button" className="wb-icon-button" onClick={() => actions.onSplit(paneId, "vertical")} title="Split down" tabIndex={inert ? -1 : 0}>⇩</button>
          <button type="button" className="wb-icon-button" onClick={() => actions.onZoom(paneId)} title="Zoom this pane" tabIndex={inert ? -1 : 0}>⤢</button>
          <button type="button" className="wb-icon-button" onClick={() => actions.onClose(paneId)} title="Close this pane" tabIndex={inert ? -1 : 0}>✕</button>
        </div>
      </header>

      {terminalId === null ? (
        <div className="wb-pane-body wb-pane-placeholder">
          <p>This pane has no terminal yet.</p>
          <div className="wb-command-row">
            <button type="button" className="wb-button" onClick={() => actions.onPickTerminal(paneId)} tabIndex={inert ? -1 : 0}>Pick a terminal</button>
            <button type="button" className="wb-button" onClick={actions.onStartTerminal} tabIndex={inert ? -1 : 0}>Open agent terminal</button>
          </div>
        </div>
      ) : info?.error ? (
        <div className="wb-pane-body wb-pane-error" role="alert">
          <p>{info.error}</p>
          <button type="button" className="wb-button" onClick={() => actions.onRetry(terminalId)} tabIndex={inert ? -1 : 0}>Retry</button>
        </div>
      ) : connection ? (
        <div className="wb-pane-body">
          <TerminalSurface
            connection={connection}
            canSend={lease?.canSend ?? false}
            focused={focused && (lease?.canSend ?? false)}
            onChip={setChip}
            onTitle={setTitle}
            onFocusChange={() => actions.onFocus(paneId)}
            label={info?.title ?? "Terminal"}
          />
          {lease && !lease.canSend ? (
            <div className="wb-pane-note" role="note">
              <p>{held === null ? "You are watching this terminal." : `${held} is in control.`}</p>
              <p className="wb-hint">Typing and resizing are off until you take control.</p>
              <button type="button" className="wb-button" onClick={() => actions.onAcquire(terminalId)} tabIndex={inert ? -1 : 0}>Take control</button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="wb-pane-body wb-pane-placeholder" aria-busy="true">
          <p>Connecting…</p>
        </div>
      )}
    </section>
  );
}
