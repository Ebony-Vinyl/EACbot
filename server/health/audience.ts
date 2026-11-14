// Who may read a health sample. Health is private to one person by default: a sample reaches a turn only when
// that turn is the person's own, and never a room's or another member's. This is a pure rule so it is testable
// without a store, and so the one place it lives can be read in a minute.
import type { Audience } from "../audience.ts";
import { mayRead } from "../audience.ts";

/** A health row belongs to the person who recorded it. On a My Cloud that is the one owner. */
export type HealthOwner = "owner" | `member:${string}`;

export type HealthReadRefusal = "not_your_health" | "room_turn" | "unknown_audience";

/**
 * The read rule. A team Cloud may have several people, and a health row belongs to exactly one of them; a
 * turn that anyone else will read cannot see it, and neither can a room's turn even when the owner is in the room.
 */
export function mayReadHealth(owner: HealthOwner, turnAudience: Audience, turnPerson: string | null): { ok: true } | { ok: false; code: HealthReadRefusal; message: string } {
  if (owner === "owner") {
    // The owner's own health reaches the owner's own turns only: a team audience is everyone's.
    if (turnAudience !== "team") return { ok: false, code: "room_turn", message: "your health is private to you, and this turn is shared with someone else" };
    return { ok: true };
  }
  const person = owner.slice("member:".length);
  if (turnAudience === "team") {
    return { ok: false, code: "not_your_health", message: "health belongs to one person; this turn is shared with everyone" };
  }
  if (turnAudience.startsWith("room:")) {
    // A room's answer is read by whoever is in it, so even the owner's own health stays out.
    return { ok: false, code: "room_turn", message: "your health is private to you, and this turn is shared with someone else" };
  }
  if (turnPerson === null) return { ok: false, code: "unknown_audience", message: "this turn's person is not known, so its health cannot be read" };
  if (turnPerson !== person) return { ok: false, code: "not_your_health", message: "this is someone else's health" };
  return { ok: true };
}

/** The write rule: a turn writes health for its own person, into that person's private scope. */
export function mayWriteHealth(owner: HealthOwner, turnAudience: Audience, turnPerson: string | null): boolean {
  return mayReadHealth(owner, turnAudience, turnPerson).ok && (owner === "owner" ? turnAudience === "team" : true);
}

/**
 * Whether health may leave the host at all: a model call, a shared memory, a platform reply. Off unless the
 * person turned it on, because a summary of someone's sleep is still their sleep.
 */
export function healthMayLeaveHost(setting: { shareWithModels?: boolean } | undefined): boolean {
  return setting?.shareWithModels === true;
}

export { mayRead };
