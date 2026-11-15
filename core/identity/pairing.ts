import { digestsMatch, formatPairingCode, normalizePairingCode, pairingCode, sha256Hex, type Clock, type Random } from "./crypto.ts";
import { IdentityError } from "./errors.ts";

/** How long a printed pairing code stays redeemable, and how many wrong
 * guesses burn it. A code is worth 32^8 combinations, but a device that is
 * not the one the person is pairing should never get unlimited tries. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 10;

export interface PairingCodeView {
  /** The plaintext code, returned once so the local terminal can print it. It
   * is never stored: only its digest is kept. */
  readonly code: string;
  readonly expiresAt: number;
}

export interface ActivePairing {
  readonly expiresAt: number;
  readonly remainingAttempts: number;
}

interface PendingPairing {
  readonly digest: string;
  readonly expiresAt: number;
  attempts: number;
}

export class PairingCodes {
  readonly #clock: Clock;
  readonly #random: Random;
  readonly #ttlMs: number;
  readonly #maxAttempts: number;
  #pending: PendingPairing | undefined;

  constructor(options: { clock: Clock; random: Random; ttlMs?: number; maxAttempts?: number }) {
    this.#clock = options.clock;
    this.#random = options.random;
    this.#ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
    this.#maxAttempts = options.maxAttempts ?? PAIRING_MAX_ATTEMPTS;
  }

  /** Replaces any previous code: only the most recently printed one works, so
   * an old terminal scrollback cannot be replayed. */
  issue(): PairingCodeView {
    const code = pairingCode(this.#random);
    const expiresAt = this.#clock.now() + this.#ttlMs;
    this.#pending = { digest: sha256Hex(normalizePairingCode(code)), expiresAt, attempts: 0 };
    return { code: formatPairingCode(code), expiresAt };
  }

  active(): ActivePairing | undefined {
    const pending = this.#live();
    if (!pending) return undefined;
    return { expiresAt: pending.expiresAt, remainingAttempts: this.#maxAttempts - pending.attempts };
  }

  /** Consumes the code. Every rejection path is constant-time in the code
   * itself: the digest comparison happens before any branch on expiry, so a
   * wrong code and an expired code take the same work. */
  redeem(input: string): { expiresAt: number } {
    const pending = this.#pending;
    if (!pending) throw new IdentityError("pairing_unknown", "no pairing code is active");
    const matches = digestsMatch(pending.digest, sha256Hex(normalizePairingCode(input)));
    const expired = this.#clock.now() >= pending.expiresAt;
    if (!matches) {
      pending.attempts += 1;
      if (pending.attempts >= this.#maxAttempts) this.#pending = undefined;
      throw expired
        ? new IdentityError("pairing_expired", "the pairing code expired")
        : new IdentityError("pairing_unknown", "the pairing code does not match");
    }
    if (expired) {
      this.#pending = undefined;
      throw new IdentityError("pairing_expired", "the pairing code expired");
    }
    this.#pending = undefined;
    return { expiresAt: pending.expiresAt };
  }

  clear(): void {
    this.#pending = undefined;
  }

  #live(): PendingPairing | undefined {
    const pending = this.#pending;
    if (!pending) return undefined;
    if (this.#clock.now() >= pending.expiresAt) return undefined;
    return pending;
  }
}
