/**
 * Who may type into a terminal and who may only watch.
 *
 * `observe` viewers never type or resize (herdr-core 0.1.21, `docs/api.md`,
 * "Attach streams"). The core enforces this too; this class keeps a browser
 * session from believing it has control it does not, and lets a person take
 * control back from an agent without dropping the stream.
 */

import { TransportError } from "./protocol.ts";

export type LeaseRole = "control" | "observe";

export interface LeaseHolder {
  readonly id: string;
  readonly role: LeaseRole;
  readonly sinceMs: number;
}

export interface LeaseOptions {
  /** Called when a holder loses control, with why. */
  readonly onRevoked?: (holder: LeaseHolder, reason: string) => void;
}

export class ControlLease {
  #onRevoked: ((holder: LeaseHolder, reason: string) => void) | undefined;
  #holders = new Map<string, LeaseHolder>();
  #controllerId: string | null = null;
  #revokedReason: string | null = null;

  constructor(options: LeaseOptions = {}) {
    this.#onRevoked = options.onRevoked;
  }

  /** Everyone attached, controller first, in the order they took a role. */
  get holders(): LeaseHolder[] {
    return [...this.#holders.values()];
  }

  get controller(): LeaseHolder | null {
    return this.#controllerId === null ? null : (this.#holders.get(this.#controllerId) ?? null);
  }

  /** Why the last control was taken away, for the next caller to report. */
  get revokedReason(): string | null {
    return this.#revokedReason;
  }

  attach(id: string, role: LeaseRole, nowMs = Date.now()): LeaseHolder {
    if (id === "") throw new TransportError("a lease holder needs an id");
    const existing = this.#holders.get(id);
    if (existing) {
      if (existing.role === role) return existing;
      return this.#grant(id, role, nowMs);
    }
    return this.#grant(id, role, nowMs);
  }

  detach(id: string): void {
    if (!this.#holders.delete(id)) return;
    if (this.#controllerId === id) this.#controllerId = null;
  }

  /** Takes control from whoever had it. Observers may not hold control. */
  take(id: string, nowMs = Date.now()): LeaseHolder {
    const holder = this.#holders.get(id);
    if (!holder) throw new TransportError(`no viewer ${id} to give control to`);
    return this.#grant(id, "control", nowMs);
  }

  /**
   * Drops the current controller back to observing, keeping its stream. Returns
   * the holder whose control ended, or null when nobody had it.
   */
  revoke(reason: string): LeaseHolder | null {
    const controller = this.controller;
    if (!controller) return null;
    this.#holders.set(controller.id, { ...controller, role: "observe" });
    this.#controllerId = null;
    this.#revokedReason = reason;
    this.#onRevoked?.(controller, reason);
    return controller;
  }

  /** Whether this holder may type or resize. */
  canControl(id: string): boolean {
    return this.#controllerId === id;
  }

  /** Throws unless this holder may type. */
  assertCanInput(id: string): void {
    if (!this.canControl(id)) {
      throw new TransportError(`viewer ${id} may watch but not type: it does not hold control`);
    }
  }

  /** Throws unless this holder may resize. Observers never set the size. */
  assertCanResize(id: string): void {
    if (!this.canControl(id)) {
      throw new TransportError(`viewer ${id} may watch but not resize: it does not hold control`);
    }
  }

  #grant(id: string, role: LeaseRole, nowMs: number): LeaseHolder {
    if (role === "control" && this.#controllerId !== null && this.#controllerId !== id) {
      const previous = this.#holders.get(this.#controllerId);
      if (previous) {
        this.#holders.set(previous.id, { ...previous, role: "observe" });
        this.#onRevoked?.(previous, `control taken by ${id}`);
      }
    }
    const holder: LeaseHolder = { id, role, sinceMs: nowMs };
    this.#holders.set(id, holder);
    if (role === "control") {
      this.#controllerId = id;
      this.#revokedReason = null;
    } else if (this.#controllerId === id) {
      this.#controllerId = null;
    }
    return holder;
  }
}
