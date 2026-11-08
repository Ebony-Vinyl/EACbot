export const PLUGIN_STATES = [
  "discovered",
  "downloaded",
  "verified",
  "installed-disabled",
  "starting",
  "active",
  "stopping",
  "disabled",
  "blocked",
  "failed",
  "revoked",
] as const;

export type PluginState = (typeof PLUGIN_STATES)[number];

/** `active` means its contributions are registered, not that a process is necessarily healthy. */
const TRANSITIONS: Record<PluginState, readonly PluginState[]> = {
  discovered: ["downloaded", "failed", "revoked"],
  downloaded: ["verified", "failed", "revoked"],
  verified: ["installed-disabled", "failed", "revoked"],
  "installed-disabled": ["starting", "disabled", "blocked", "failed", "revoked"],
  starting: ["active", "blocked", "failed", "stopping", "revoked"],
  active: ["stopping", "failed", "blocked", "revoked"],
  stopping: ["disabled", "failed", "revoked"],
  disabled: ["starting", "installed-disabled", "failed", "revoked"],
  blocked: ["starting", "disabled", "installed-disabled", "failed", "revoked"],
  failed: ["starting", "disabled", "installed-disabled", "revoked"],
  revoked: [],
};

export function canTransitionPlugin(from: PluginState, to: PluginState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface PluginTransitionResult {
  ok: true;
  state: PluginState;
}

export interface PluginTransitionError {
  ok: false;
  code: "INVALID_TRANSITION";
  error: string;
}

export function transitionPluginState(from: PluginState, to: PluginState): PluginTransitionResult | PluginTransitionError {
  if (!canTransitionPlugin(from, to)) {
    return { ok: false, code: "INVALID_TRANSITION", error: `cannot move a plugin from ${from} to ${to}` };
  }
  return { ok: true, state: to };
}
