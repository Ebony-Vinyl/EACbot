// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialLease, type LeaseState } from "./control-lease.ts";
import { leaf, split, type PaneNode } from "./pane-tree.ts";
import { PaneGrid, type PaneTerminalInfo } from "./PaneGrid.tsx";
import type { ConnectionState, TerminalConnection, TerminalEvent } from "./terminal-transport.ts";

class SilentConnection implements TerminalConnection {
  readonly terminalId: string;
  readonly state: ConnectionState = { kind: "live", canControl: false };
  readonly canControl = false;
  constructor(terminalId: string) {
    this.terminalId = terminalId;
  }
  open(): void {}
  resize(): boolean { return false; }
  send(): boolean { return false; }
  acknowledge(): void {}
  retry(): void {}
  close(): void {}
  onData(): () => void { return () => {}; }
  onEvent(): () => void { return () => {}; }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const info = (terminalId: string, lease: LeaseState): PaneTerminalInfo => ({
  terminalId,
  title: `Terminal ${terminalId}`,
  missionTitle: "A mission",
  connection: new SilentConnection(terminalId),
  lease,
  error: null,
});

const actions = () => ({
  onFocus: vi.fn(),
  onRatio: vi.fn(),
  onSplit: vi.fn(),
  onClose: vi.fn(),
  onZoom: vi.fn(),
  onAcquire: vi.fn(),
  onRelease: vi.fn(),
  onRetry: vi.fn(),
  onPickTerminal: vi.fn(),
  onStartTerminal: vi.fn(),
});

async function render(rootNode: PaneNode, panes: Record<string, PaneTerminalInfo>, focused = "p1"): Promise<ReturnType<typeof actions>> {
  const spies = actions();
  await act(async () => {
    root.render(h(PaneGrid, {
      root: rootNode,
      focusedPaneId: focused,
      zoomedPaneId: null,
      panes,
      ...spies,
      empty: h("p", null, "No panes"),
    }));
  });
  return spies;
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll("button")].find((candidate) => (candidate.textContent ?? "").includes(label));

describe("the pane grid", () => {
  it("draws a real terminal for each pane that has one", async () => {
    await render(split("s", "horizontal", leaf("p1", "t1"), leaf("p2", "t2")), { t1: info("t1", initialLease()), t2: info("t2", initialLease()) });
    expect(host.querySelectorAll('[data-testid="terminal-surface"]')).toHaveLength(2);
  });

  it("marks exactly one pane focused", async () => {
    await render(split("s", "horizontal", leaf("p1", "t1"), leaf("p2", "t2")), { t1: info("t1", initialLease()), t2: info("t2", initialLease()) });
    expect(host.querySelectorAll('[data-focused="true"]')).toHaveLength(1);
  });

  it("says a watcher cannot type and offers to take control", async () => {
    const spies = await render(leaf("p1", "t1"), { t1: info("t1", initialLease()) });
    expect(host.textContent).toContain("You are watching this terminal.");
    expect(host.textContent).toContain("Typing and resizing are off");
    await act(async () => button("Take control")?.click());
    expect(spies.onAcquire).toHaveBeenCalledWith("t1");
  });

  it("names whoever else holds control", async () => {
    await render(leaf("p1", "t1"), { t1: info("t1", { kind: "held-by-other", holder: "Ada's phone" }) });
    expect(host.textContent).toContain("Ada's phone is in control.");
  });

  it("offers Release only while this viewer holds control", async () => {
    await render(leaf("p1", "t1"), { t1: info("t1", { kind: "controlling", since: 1 }) });
    expect(button("Release")).toBeDefined();
    expect(host.textContent).not.toContain("Typing and resizing are off");
  });

  it("splits, closes and zooms through its own actions", async () => {
    const spies = await render(leaf("p1", "t1"), { t1: info("t1", initialLease()) });
    await act(async () => button("⇥")?.click());
    expect(spies.onSplit).toHaveBeenCalledWith("p1", "horizontal");
    await act(async () => button("⇩")?.click());
    expect(spies.onSplit).toHaveBeenCalledWith("p1", "vertical");
    await act(async () => button("✕")?.click());
    expect(spies.onClose).toHaveBeenCalledWith("p1");
    await act(async () => button("⤢")?.click());
    expect(spies.onZoom).toHaveBeenCalledWith("p1");
  });

  it("says a pane has no terminal and offers a picker", async () => {
    const spies = await render(leaf("p1", null), {});
    expect(host.textContent).toContain("This pane has no terminal yet.");
    await act(async () => button("Pick a terminal")?.click());
    expect(spies.onPickTerminal).toHaveBeenCalledWith("p1");
  });

  it("shows a failure with a Retry instead of a dead screen", async () => {
    const spies = await render(leaf("p1", "t1"), { t1: { ...info("t1", initialLease()), connection: null, error: "the stream failed" } });
    expect(host.textContent).toContain("the stream failed");
    await act(async () => button("Retry")?.click());
    expect(spies.onRetry).toHaveBeenCalledWith("t1");
  });

  it("shows a connecting state while the stream is asked for", async () => {
    await render(leaf("p1", "t1"), { t1: { ...info("t1", initialLease()), connection: null, error: null } });
    expect(host.textContent).toContain("Connecting…");
  });

  it("exposes every divider as a keyboard-adjustable separator", async () => {
    const spies = await render(split("s", "horizontal", leaf("p1", "t1"), leaf("p2", "t2")), { t1: info("t1", initialLease()), t2: info("t2", initialLease()) });
    const divider = host.querySelector('[role="separator"]') as HTMLElement;
    expect(divider).not.toBeNull();
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    await act(async () => {
      divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(spies.onRatio).toHaveBeenCalledWith("s", 0.52);
  });

  it("keeps the other terminals mounted while one is zoomed", async () => {
    await act(async () => {
      root.render(h(PaneGrid, {
        root: split("s", "horizontal", leaf("p1", "t1"), leaf("p2", "t2")),
        focusedPaneId: "p1",
        zoomedPaneId: "p1",
        panes: { t1: info("t1", initialLease()), t2: info("t2", initialLease()) },
        ...actions(),
        empty: null,
      }));
    });
    // One on screen, one mounted off screen: a terminal is never unmounted by
    // opening zoom, so no stream is dropped and no screen is lost.
    expect(host.querySelectorAll('[data-testid="terminal-surface"]')).toHaveLength(2);
    expect(host.textContent).toContain("Leave zoom");
  });

  it("does not draw a terminal for a pane with no connection", async () => {
    await render(leaf("p1", "t1"), { t1: { ...info("t1", initialLease()), connection: null } });
    expect(host.querySelectorAll('[data-testid="terminal-surface"]')).toHaveLength(0);
  });

  it("shows the chip a connection reports", async () => {
    const listeners = new Set<(event: TerminalEvent) => void>();
    const connection: TerminalConnection = {
      terminalId: "t1",
      state: { kind: "live", canControl: false },
      canControl: false,
      open: () => {},
      resize: () => false,
      send: () => false,
      acknowledge: () => {},
      retry: () => {},
      close: () => {},
      onData: () => () => {},
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    await render(leaf("p1", "t1"), { t1: { ...info("t1", initialLease()), connection } });
    await act(async () => {
      for (const listener of listeners) listener({ type: "status", status: "working" });
    });
    expect(host.textContent).toContain("Working");
  });
});
