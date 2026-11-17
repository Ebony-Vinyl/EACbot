/** Who may type into a terminal, as the workbench shows it.
 *
 * A viewer watches or controls. Watching is the safe default: an observer sees
 * every byte the program writes but cannot send input or resize, and the UI
 * says so rather than swallowing keystrokes. Only one viewer controls a
 * terminal at a time; when someone else has it, the workbench names them and
 * offers Take control, which is an explicit hand-off, not a silent steal.
 *
 * This is the UI's own model of a lease. The server enforces the real one
 * (`canControl` in the `ready` frame), and this model never claims control the
 * server did not grant.
 */

export type LeaseRole = "watch" | "control";

export type LeaseState =
  | { readonly kind: "watching" }
  | { readonly kind: "requesting" }
  | { readonly kind: "controlling"; readonly since: number }
  /** Someone else holds it; `holder` is their label when the server named one. */
  | { readonly kind: "held-by-other"; readonly holder: string }
  | { readonly kind: "released"; readonly reason: string }
  | { readonly kind: "denied"; readonly reason: string };

export interface LeaseSnapshot {
  readonly state: LeaseState;
  /** Only a controlling viewer may type or resize. */
  readonly canSend: boolean;
  readonly canAcquire: boolean;
  readonly role: LeaseRole;
}

export function initialLease(): LeaseState {
  return { kind: "watching" };
}

/** `true` only for a viewer that actually holds control. Every input path asks
 * this, so an observer cannot type through a stale component. */
export function maySendInput(state: LeaseState): boolean {
  return state.kind === "controlling";
}

export function mayResize(state: LeaseState): boolean {
  return state.kind === "controlling";
}

export function describeLease(state: LeaseState): LeaseSnapshot {
  return {
    state,
    canSend: maySendInput(state),
    canAcquire: state.kind === "watching" || state.kind === "released" || state.kind === "held-by-other" || state.kind === "denied",
    role: state.kind === "controlling" ? "control" : "watch",
  };
}

export type LeaseAction =
  | { readonly type: "request" }
  | { readonly type: "granted"; readonly since: number }
  | { readonly type: "held-by-other"; readonly holder: string }
  | { readonly type: "release" }
  | { readonly type: "revoked"; readonly reason: string }
  | { readonly type: "denied"; readonly reason: string };

/** The lease transitions. Anything not listed is ignored rather than forced,
 * so a late message cannot grant control the person did not ask for. */
export function reduceLease(state: LeaseState, action: LeaseAction): LeaseState {
  switch (action.type) {
    case "request":
      return state.kind === "controlling" || state.kind === "requesting" ? state : { kind: "requesting" };
    case "granted":
      return state.kind === "requesting" || state.kind === "held-by-other" || state.kind === "denied"
        ? { kind: "controlling", since: action.since }
        : state;
    case "held-by-other":
      return state.kind === "controlling" ? state : { kind: "held-by-other", holder: action.holder };
    case "release":
      return state.kind === "controlling" ? { kind: "watching" } : state;
    case "revoked":
      return state.kind === "controlling" ? { kind: "released", reason: action.reason } : state;
    case "denied":
      return { kind: "denied", reason: action.reason };
  }
}

/** What a person reads. Kept beside the transitions so a new state cannot ship
 * without words. */
export function leaseCopy(state: LeaseState): { title: string; detail: string } {
  switch (state.kind) {
    case "watching":
      return { title: "Watching", detail: "You can see this terminal. Type nothing until you take control." };
    case "requesting":
      return { title: "Taking control…", detail: "Waiting for the terminal to hand control over." };
    case "controlling":
      return { title: "In control", detail: "Keystrokes and size changes go to this terminal." };
    case "held-by-other":
      return { title: `${state.holder} is in control`, detail: "You are watching. Take control to type here." };
    case "released":
      return { title: "Control ended", detail: state.reason };
    case "denied":
      return { title: "Control was refused", detail: state.reason };
  }
}
