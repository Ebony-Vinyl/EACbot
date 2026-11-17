// Which of the two left-hand surfaces the window shows: the list of bots, or the board of conversations. They take the
// same space, so they alternate rather than stack — opening one closes the other.

import { useSyncExternalStore } from "react";

export const SHELL_VIEWS = ["sidebar", "board"] as const;
export type ShellView = (typeof SHELL_VIEWS)[number];

const KEY = "eacbot.shellView";
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function read(): ShellView {
  try {
    const stored = storage()?.getItem(KEY);
    return SHELL_VIEWS.includes(stored as ShellView) ? (stored as ShellView) : "sidebar";
  } catch {
    return "sidebar";
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function setShellView(view: ShellView): void {
  try {
    storage()?.setItem(KEY, view);
  } catch {}
  notify();
}

/** Shows one surface, or swaps to the other: the pair never share the window. */
export function toggleShellView(view: ShellView): void {
  setShellView(read() === view ? (view === "sidebar" ? "board" : "sidebar") : view);
}

export function useShellView(): ShellView {
  return useSyncExternalStore(subscribe, read, () => "sidebar" as const);
}
