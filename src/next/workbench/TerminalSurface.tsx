/** The xterm surface: it draws the bytes a connection reports and sends what a
 * person types back through that same connection.
 *
 * Nothing here knows the WebSocket contract, and nothing here decides who may
 * type: `connection.send` refuses input from a watcher and `canSend` is what
 * the chrome shows. Colours come from the app's CSS tokens, and the background
 * stays transparent so the skin and its translucency show through. */

import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { newCreditLedger, drawn, received, repainted } from "./credit.ts";
import { exitChip, terminalChip, type TerminalChip } from "./status.ts";
import type { TerminalConnection } from "./terminal-transport.ts";

/** Read through `getComputedStyle`, so a skin change and a light/dark switch
 * both reach the terminal without this file naming a colour. */
function themeFrom(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  const token = (name: string): string | undefined => style.getPropertyValue(name).trim() || undefined;
  const ink = token("--color-ink");
  const accent = token("--color-accent");
  return {
    // Transparent: the surface below carries the skin, so glass and a picture
    // behind the workbench stay visible through the grid.
    background: "transparent",
    ...(ink ? { foreground: ink, cursor: ink, cursorAccent: token("--color-inset") } : {}),
    ...(accent ? { selectionBackground: token("--color-menu-active") } : {}),
  };
}

function fontSizeFrom(element: HTMLElement): number {
  const raw = Number.parseFloat(getComputedStyle(element).getPropertyValue("--workbench-terminal-font-size"));
  return Number.isFinite(raw) && raw > 0 ? raw : 12;
}

export interface TerminalSurfaceProps {
  readonly connection: TerminalConnection;
  /** A watcher draws every byte but may not type, so xterm's own input path is
   * closed too, not only the send gate. */
  readonly canSend: boolean;
  readonly focused: boolean;
  readonly onChip: (chip: TerminalChip | null) => void;
  readonly onTitle: (title: string | null) => void;
  readonly onFocusChange: (focused: boolean) => void;
  readonly label: string;
}

export function TerminalSurface({ connection, canSend, focused, onChip, onTitle, onFocusChange, label }: TerminalSurfaceProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const [ready, setReady] = useState(false);
  const callbacks = useRef({ onChip, onTitle, onFocusChange });
  callbacks.current = { onChip, onTitle, onFocusChange };

  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const term = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: getComputedStyle(element).getPropertyValue("--font-mono").trim() || undefined,
      fontSize: fontSizeFrom(element),
      scrollback: 5_000,
      theme: themeFrom(element),
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(element);
    terminal.current = term;
    setReady(true);

    const encoder = new TextEncoder();
    const input = term.onData((data) => {
      connection.send(encoder.encode(data));
    });
    const binary = term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let index = 0; index < data.length; index += 1) bytes[index] = data.charCodeAt(index) & 0xff;
      connection.send(bytes);
    });
    const focus = term.textarea
      ? attachFocus(term.textarea, (focusedNow) => callbacks.current.onFocusChange(focusedNow))
      : () => {};

    let ledger = newCreditLedger();
    const write = (bytes: Uint8Array): void => {
      ledger = received(ledger, bytes.byteLength);
      term.write(bytes, () => {
        const credited = drawn(ledger);
        ledger = credited.ledger;
        if (credited.credit > 0) connection.acknowledge(credited.credit);
      });
    };

    const offData = connection.onData(write);
    const offEvents = connection.onEvent((event) => {
      switch (event.type) {
        case "repaint":
          // The next bytes are a whole screen, so the old one goes first and
          // bytes still queued for it are never credited twice.
          term.reset();
          ledger = repainted(ledger);
          return;
        case "title":
          callbacks.current.onTitle(event.title);
          return;
        case "status":
          callbacks.current.onChip(terminalChip(event.status));
          return;
        case "exit":
          callbacks.current.onChip(
            event.exitCode === undefined ? exitChip({ reason: event.reason }) : exitChip({ reason: event.reason, exitCode: event.exitCode }),
          );
          return;
        default:
          return;
      }
    });

    const fitNow = (): void => {
      if (!host.current || host.current.clientWidth === 0 || host.current.clientHeight === 0) return;
      try {
        addon.fit();
      } catch {
        // A pane collapsed to zero cannot be fitted; the next resize fits it.
      }
      if (term.cols > 0 && term.rows > 0) connection.resize(term.cols, term.rows);
    };

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fitNow);
    if (observer) observer.observe(element);
    globalThis.addEventListener?.("resize", fitNow);

    return () => {
      offData();
      offEvents();
      input.dispose();
      binary.dispose();
      focus();
      observer?.disconnect();
      globalThis.removeEventListener?.("resize", fitNow);
      term.dispose();
      terminal.current = null;
      setReady(false);
    };
  }, [connection]);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.disableStdin = !canSend;
  }, [canSend, ready]);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    if (focused) term.focus();
    else if (term.textarea && term.textarea === term.textarea.ownerDocument.activeElement) term.blur();
  }, [focused, ready]);

  return (
    <div
      ref={host}
      className="wb-terminal"
      role="group"
      aria-label={label}
      data-testid="terminal-surface"
      data-focused={focused ? "true" : "false"}
      data-can-send={canSend ? "true" : "false"}
    />
  );
}

/** Keyboard focus and pointer focus are tracked apart: a person reading with
 * the mouse has not handed their keyboard to the terminal, and the chrome says
 * which one it has. */
function attachFocus(textarea: HTMLElement, onChange: (focused: boolean) => void): () => void {
  let pointerDown = false;
  const down = (): void => void (pointerDown = true);
  const up = (): void => void (pointerDown = false);
  const enter = (): void => onChange(true);
  const leave = (): void => {
    if (!pointerDown) onChange(false);
  };
  textarea.addEventListener("focus", enter);
  textarea.addEventListener("blur", leave);
  textarea.addEventListener("pointerdown", down);
  textarea.addEventListener("pointerup", up);
  return () => {
    textarea.removeEventListener("focus", enter);
    textarea.removeEventListener("blur", leave);
    textarea.removeEventListener("pointerdown", down);
    textarea.removeEventListener("pointerup", up);
  };
}
