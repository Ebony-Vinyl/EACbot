import { useSyncExternalStore } from "react";

export const LIVE2D_KEY = "eac-live2d-enabled";
export const LIVE2D_MODEL_KEY = "eac-live2d-model";
export const DEFAULT_CHARACTER = "/characters/k01/";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

let enabled: boolean | undefined;
const listeners = new Set<() => void>();

function current(): boolean {
  if (enabled !== undefined) return enabled;
  try {
    return storage()?.getItem(LIVE2D_KEY) === "1";
  } catch {
    return false;
  }
}

function model(): string {
  try {
    return storage()?.getItem(LIVE2D_MODEL_KEY) || DEFAULT_CHARACTER;
  } catch {
    return DEFAULT_CHARACTER;
  }
}

export function setLive2dEnabled(value: boolean): void {
  enabled = value;
  try {
    storage()?.setItem(LIVE2D_KEY, value ? "1" : "0");
  } catch {
    // private browsing: the choice stays session-only
  }
  notify();
}

export function useLive2dEnabled(): boolean {
  return useSyncExternalStore(subscribe, current);
}

export function useLive2dModel(): string {
  return useSyncExternalStore(subscribe, model);
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
