import type { Clock, Random } from "./crypto.ts";
import { systemClock, systemRandom } from "./crypto.ts";
import { IdentityError } from "./errors.ts";
import { PairingCodes, type ActivePairing, type PairingCodeView } from "./pairing.ts";
import { isPermissionScope, scopeSatisfies, type PermissionScope } from "./scopes.ts";
import { DeviceSessions, type DeviceSession, type IssuedSession } from "./sessions.ts";
import { MemoryTicketStore, isTicketPurpose, type IssuedTicket, type TicketPurpose, type TicketStore } from "./tickets.ts";

/** The scope a paired phone or browser gets. `owner` is deliberately not the
 * default: pairing is how a device gets in, not how it gains the right to
 * change the user's computers. */
export const PAIRED_DEVICE_SCOPE: PermissionScope = "device";

export interface IdentityOptions {
  readonly clock?: Clock;
  readonly random?: Random;
  readonly tickets?: TicketStore;
  readonly pairingTtlMs?: number;
  readonly pairingMaxAttempts?: number;
  readonly sessionTtlMs?: number;
  readonly ticketTtlMs?: number;
}

export interface PairRequest {
  readonly code: string;
  readonly label: string;
  /** A loopback peer may ask for `owner`; anything else is clamped to the
   * paired-device scope. The transport decides this, never the body. */
  readonly loopback?: boolean;
  readonly requestedScope?: PermissionScope;
}

export interface AuthenticatedCaller {
  readonly session: DeviceSession;
  readonly scope: PermissionScope;
}

/** Everything that decides who a request is. It owns no transport and no
 * mission state: a route asks it for a caller, then asks the mission layer to
 * act. */
export class IdentityService {
  readonly #pairing: PairingCodes;
  readonly #sessions: DeviceSessions;
  readonly #tickets: TicketStore;

  constructor(options: IdentityOptions = {}) {
    const clock = options.clock ?? systemClock;
    const random = options.random ?? systemRandom;
    this.#pairing = new PairingCodes({
      clock,
      random,
      ...(options.pairingTtlMs !== undefined ? { ttlMs: options.pairingTtlMs } : {}),
      ...(options.pairingMaxAttempts !== undefined ? { maxAttempts: options.pairingMaxAttempts } : {}),
    });
    this.#sessions = new DeviceSessions({
      clock,
      random,
      ...(options.sessionTtlMs !== undefined ? { ttlMs: options.sessionTtlMs } : {}),
    });
    this.#tickets =
      options.tickets ??
      new MemoryTicketStore({ clock, random, ...(options.ticketTtlMs !== undefined ? { ttlMs: options.ticketTtlMs } : {}) });
  }

  issuePairingCode(): PairingCodeView {
    return this.#pairing.issue();
  }

  activePairing(): ActivePairing | undefined {
    return this.#pairing.active();
  }

  clearPairing(): void {
    this.#pairing.clear();
  }

  pair(request: PairRequest): IssuedSession {
    if (request.label.trim().length === 0) throw new IdentityError("forbidden", "a device label is required");
    this.#pairing.redeem(request.code);
    const scope = this.#pairedScope(request);
    return this.#sessions.issue({ label: request.label.trim(), scope });
  }

  /** Reads an `Authorization: Bearer <token>` header. Anything else is
   * unauthenticated: no query token, no cookie, no `?access_token=`. */
  authenticateHeader(header: string | undefined): AuthenticatedCaller {
    const token = bearerFrom(header);
    if (token === undefined) throw new IdentityError("unauthenticated", "a bearer token is required");
    const session = this.#sessions.authenticate(token);
    return { session, scope: session.scope };
  }

  authenticateToken(token: string | undefined): AuthenticatedCaller {
    if (token === undefined || token.length === 0) throw new IdentityError("unauthenticated", "a bearer token is required");
    const session = this.#sessions.authenticate(token);
    return { session, scope: session.scope };
  }

  require(caller: AuthenticatedCaller, required: PermissionScope): void {
    if (!scopeSatisfies(caller.scope, required)) {
      throw new IdentityError("forbidden", `this call needs the ${required} scope`);
    }
  }

  listSessions(): DeviceSession[] {
    return this.#sessions.list();
  }

  revokeSession(id: string): void {
    if (!this.#sessions.revoke(id)) throw new IdentityError("forbidden", "no such device session");
  }

  revokeAllSessions(): void {
    this.#sessions.revokeAll();
  }

  issueTicket(caller: { readonly sessionId: string; readonly scope: PermissionScope }, purpose: TicketPurpose, targetId?: string): IssuedTicket {
    if (!isTicketPurpose(purpose)) throw new IdentityError("forbidden", "unknown ticket purpose");
    return this.#tickets.issue({
      sessionId: caller.sessionId,
      scope: caller.scope,
      purpose,
      ...(targetId !== undefined ? { targetId } : {}),
    });
  }

  redeemTicket(ticket: string, purpose: TicketPurpose): { sessionId: string; scope: PermissionScope; targetId?: string } {
    const grant = this.#tickets.redeem(ticket, purpose);
    this.#sessions.assertActive(grant.sessionId);
    return {
      sessionId: grant.sessionId,
      scope: grant.scope,
      ...(grant.targetId !== undefined ? { targetId: grant.targetId } : {}),
    };
  }

  #pairedScope(request: PairRequest): PermissionScope {
    if (request.requestedScope === undefined) return PAIRED_DEVICE_SCOPE;
    if (!isPermissionScope(request.requestedScope)) throw new IdentityError("forbidden", "unknown scope");
    if (request.requestedScope === "owner" && request.loopback !== true) {
      throw new IdentityError("forbidden", "only a loopback pairing may claim the owner scope");
    }
    return request.requestedScope;
  }
}

const BEARER = /^Bearer +([A-Za-z0-9._~+/=-]{16,512})$/u;

export function bearerFrom(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = BEARER.exec(header.trim());
  return match?.[1];
}
