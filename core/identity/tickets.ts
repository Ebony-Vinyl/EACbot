import { randomToken, sha256Hex, type Clock, type Random } from "./crypto.ts";
import { IdentityError } from "./errors.ts";
import type { PermissionScope } from "./scopes.ts";

/** A browser's `EventSource` cannot set an Authorization header, and a
 * WebSocket constructor cannot either. Such a client therefore presents a
 * short-lived ticket in the query string instead of its device bearer.
 *
 * A ticket is bound to one purpose and one session, is single-use, and lives
 * only seconds: a URL ends up in proxy logs, browser history and crash dumps,
 * which is exactly why it must not be the durable credential. */
export const TICKET_PURPOSES = ["events", "terminal"] as const;

export type TicketPurpose = (typeof TICKET_PURPOSES)[number];

export const TICKET_TTL_MS = 30_000;

export function isTicketPurpose(value: unknown): value is TicketPurpose {
  return typeof value === "string" && (TICKET_PURPOSES as readonly string[]).includes(value);
}

export interface TicketGrant {
  readonly sessionId: string;
  readonly scope: PermissionScope;
  readonly purpose: TicketPurpose;
  /** The terminal a `terminal` ticket may attach to; absent for `events`. */
  readonly targetId?: string;
}

export interface IssuedTicket {
  readonly ticket: string;
  readonly expiresAt: number;
}

interface TicketRecord extends TicketGrant {
  readonly expiresAt: number;
}

export interface TicketStore {
  issue(grant: TicketGrant): IssuedTicket;
  /** Redeems a ticket exactly once. A second redemption of the same ticket is
   * a replay and is refused. */
  redeem(ticket: string, purpose: TicketPurpose): TicketGrant;
}

export class MemoryTicketStore implements TicketStore {
  readonly #clock: Clock;
  readonly #random: Random;
  readonly #ttlMs: number;
  readonly #live = new Map<string, TicketRecord>();
  /** Redeemed digests and the moment their refusal no longer matters. Bounded
   * by the same sweep as live tickets, so replay memory cannot grow forever. */
  readonly #redeemed = new Map<string, number>();

  constructor(options: { clock: Clock; random: Random; ttlMs?: number }) {
    this.#clock = options.clock;
    this.#random = options.random;
    this.#ttlMs = options.ttlMs ?? TICKET_TTL_MS;
  }

  issue(grant: TicketGrant): IssuedTicket {
    this.#sweep();
    const ticket = randomToken(this.#random, 24);
    const expiresAt = this.#clock.now() + this.#ttlMs;
    this.#live.set(sha256Hex(ticket), { ...grant, expiresAt });
    return { ticket, expiresAt };
  }

  redeem(ticket: string, purpose: TicketPurpose): TicketGrant {
    const digest = sha256Hex(ticket);
    if (this.#redeemed.has(digest)) throw new IdentityError("ticket_used", "the ticket was already redeemed");
    const record = this.#live.get(digest);
    if (!record) throw new IdentityError("ticket_invalid", "unknown ticket");
    this.#live.delete(digest);
    this.#redeemed.set(digest, record.expiresAt);
    if (this.#clock.now() >= record.expiresAt) throw new IdentityError("ticket_expired", "the ticket expired");
    if (record.purpose !== purpose) throw new IdentityError("ticket_purpose_mismatch", "the ticket is for another stream");
    return {
      sessionId: record.sessionId,
      scope: record.scope,
      purpose: record.purpose,
      ...(record.targetId !== undefined ? { targetId: record.targetId } : {}),
    };
  }

  #sweep(): void {
    const now = this.#clock.now();
    for (const [digest, record] of this.#live) {
      if (now >= record.expiresAt) this.#live.delete(digest);
    }
    for (const [digest, expiresAt] of this.#redeemed) {
      if (now >= expiresAt) this.#redeemed.delete(digest);
    }
  }
}
