// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalControl } from "../foundation/api.ts";
import { TerminalSurface } from "./TerminalSurface.tsx";
import type { ConnectionState, TerminalConnection, TerminalEvent } from "./terminal-transport.ts";

/** A connection whose frames a test sends. It records what the surface did,
 * so the lifecycle is asserted on calls rather than on pixels. */
class FakeConnection implements TerminalConnection {
  readonly terminalId = "term-1";
  readonly sent: Uint8Array[] = [];
  readonly credited: number[] = [];
  readonly resized: Array<[number, number]> = [];
  closed = false;
  state: ConnectionState = { kind: "live", canControl: true };
  canControl = true;
  #data = new Set<(bytes: Uint8Array) => void>();
  #events = new Set<(event: TerminalEvent) => void>();

  open(): void {}
  resize(cols: number, rows: number): boolean {
    this.resized.push([cols, rows]);
    return true;
  }
  send(bytes: Uint8Array): boolean {
    this.sent.push(bytes);
    return true;
  }
  acknowledge(bytes: number): void {
    this.credited.push(bytes);
  }
  retry(): void {}
  close(): void {
    this.closed = true;
  }
  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.#data.add(listener);
    return () => this.#data.delete(listener);
  }
  onEvent(listener: (event: TerminalEvent) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }
  get dataListeners(): number {
    return this.#data.size;
  }
  get eventListeners(): number {
    return this.#events.size;
  }
  feed(bytes: Uint8Array): void {
    for (const listener of this.#data) listener(bytes);
  }
  emit(event: TerminalEvent): void {
    for (const listener of this.#events) listener(event);
  }
  control(control: TerminalControl): void {
    if (control.type === "ready") {
      this.canControl = control.canControl;
      this.state = { kind: "live", canControl: control.canControl };
    }
    this.emit({ type: "repaint" });
  }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "400px";
  host.style.height = "200px";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const tick = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

interface Mounted {
  readonly connection: FakeConnection;
  readonly chip: ReturnType<typeof vi.fn<() => void>>;
  readonly title: ReturnType<typeof vi.fn<() => void>>;
  readonly focus: ReturnType<typeof vi.fn<() => void>>;
}

async function mount(options: { canSend?: boolean; focused?: boolean } = {}): Promise<Mounted> {
  const connection = new FakeConnection();
  const chip = vi.fn();
  const title = vi.fn();
  const focus = vi.fn();
  await act(async () => {
    root.render(h(TerminalSurface, {
      connection,
      canSend: options.canSend ?? true,
      focused: options.focused ?? true,
      onChip: chip,
      onTitle: title,
      onFocusChange: focus,
      label: "Terminal",
    }));
  });
  await tick();
  return { connection, chip, title, focus };
}

const textarea = (): HTMLTextAreaElement | null => host.querySelector(".xterm-helper-textarea");

describe("the terminal surface", () => {
  it("changes the font size without replacing the native connection", async () => {
    const { connection, chip, title, focus } = await mount();
    const screen = host.querySelector(".xterm");
    await act(async () => root.render(h(TerminalSurface, { connection, canSend: true, focused: true, onChip: chip, onTitle: title, onFocusChange: focus, label: "Terminal", fontSize: 18 })));
    expect(host.querySelector(".xterm")).toBe(screen);
    expect(connection.dataListeners).toBe(1);
    expect(connection.closed).toBe(false);
  });

  it("subscribes to the connection on mount and releases it on unmount", async () => {
    const { connection } = await mount();
    expect(connection.dataListeners).toBe(1);
    expect(connection.eventListeners).toBe(1);
    act(() => root.unmount());
    expect(connection.dataListeners).toBe(0);
    expect(connection.eventListeners).toBe(0);
    expect(connection.closed).toBe(false);
    root = createRoot(host);
  });

  it("draws the bytes it is given and credits them once drawn", async () => {
    const { connection } = await mount();
    act(() => connection.feed(new Uint8Array([0x68, 0x69])));
    await tick();
    expect(connection.credited.reduce((sum, bytes) => sum + bytes, 0)).toBe(2);
  });

  it("clears the screen on a repaint boundary and does not re-credit old bytes", async () => {
    const { connection } = await mount();
    act(() => connection.feed(new Uint8Array([1, 2, 3])));
    await tick();
    const before = connection.credited.length;
    act(() => connection.emit({ type: "repaint" }));
    await tick();
    expect(connection.credited.length).toBe(before);
    act(() => connection.feed(new Uint8Array([4, 5])));
    await tick();
    expect(connection.credited.at(-1)).toBe(2);
  });

  it("reports a status word as a chip and a title as the title", async () => {
    const { connection, chip, title } = await mount();
    act(() => connection.emit({ type: "status", status: "working" }));
    act(() => connection.emit({ type: "title", title: "npm test" }));
    expect(chip).toHaveBeenCalledWith(expect.objectContaining({ state: "working" }));
    expect(title).toHaveBeenCalledWith("npm test");
  });

  it("reports an exit with its code as a chip", async () => {
    const { connection, chip } = await mount();
    act(() => connection.emit({ type: "exit", reason: "exited", exitCode: 2 }));
    expect(chip).toHaveBeenCalledWith(expect.objectContaining({ label: "Exited 2" }));
  });

  it("closes xterm's own input path for a watcher", async () => {
    const { connection } = await mount({ canSend: false });
    const area = textarea();
    expect(area).not.toBeNull();
    expect(host.querySelector('[data-can-send="false"]')).not.toBeNull();
    act(() => {
      area!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      area!.dispatchEvent(new KeyboardEvent("keypress", { key: "a", bubbles: true }));
      area!.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
    });
    expect(connection.sent).toHaveLength(0);
  });

  it("passes a keystroke through when the person holds control", async () => {
    const { connection } = await mount({ canSend: true });
    const area = textarea();
    act(() => {
      area!.focus();
      area!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", keyCode: 65, bubbles: true } as KeyboardEventInit));
      area!.dispatchEvent(new KeyboardEvent("keypress", { key: "a", keyCode: 97, bubbles: true } as KeyboardEventInit));
    });
    expect(connection.sent.length).toBeGreaterThan(0);
    expect(connection.sent[0]?.[0]).toBe(0x61);
  });

  it("marks the pane focused and tells the caller when its textarea takes focus", async () => {
    const { focus } = await mount({ focused: false });
    expect(host.querySelector('[data-focused="false"]')).not.toBeNull();
    act(() => textarea()?.dispatchEvent(new FocusEvent("focus")));
    expect(focus).toHaveBeenCalledWith(true);
  });

  it("keeps the stream open when only its canSend flag changes", async () => {
    const { connection } = await mount({ canSend: true });
    await act(async () => {
      root.render(h(TerminalSurface, {
        connection,
        canSend: false,
        focused: true,
        onChip: vi.fn(),
        onTitle: vi.fn(),
        onFocusChange: vi.fn(),
        label: "Terminal",
      }));
    });
    await tick();
    expect(connection.dataListeners).toBe(1);
    expect(host.querySelector('[data-can-send="false"]')).not.toBeNull();
  });
});
