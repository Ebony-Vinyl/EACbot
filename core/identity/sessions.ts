import { sha256Hex, type Clock, type Random } from "./crypto.ts";
import { randomToken } from "./crypto.ts";
import { IdentityError } from "./errors.ts";
import type { PermissionScope } from "./scopes.ts";

export const DEVICE_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

/** A paired device. The bearer token that authenticates it exists only in the
 * device's own storage and in the digest held here. */
export interface DeviceSession {
  readonly id: string;
  readonly label: string;
  readonly scope: PermissionScope;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
}

export interface IssuedSession {
  readonly session: DeviceSession;
  readonly token: string;
}

interface SessionRecord {
  readonly digest: string;
  readonly id: string;
  readonly label: string;
  readonly scope: PermissionScope;
  readonly createdAt: number;
  lastUsedAt: number;
  readonly expiresAt: number;
  revokedAt?: number;
}

/** Sessions live in memory: a restart revokes every device and asks for a new
 * pairing code, which is the behaviour a person can observe and reason about. */
export class DeviceSessions {
  readonly #clock: Clock;
  readonly #random: Random;
  readonly #ttlMs: number;
  readonly #byDigest = new Map<string, SessionRecord>();
  readonly #digestById = new Map<string, string>();

  constructor(options: { clock: Clock; random: Random; ttlMs?: number }) {
    this.#clock = options.clock;
    this.#random = options.random;
    this.#ttlMs = options.ttlMs ?? DEVICE_SESSION_TTL_MS;
  }

  issue(input: { label: string; scope: PermissionScope }): IssuedSession {
    const token = randomToken(this.#random);
    const now = this.#clock.now();
    const record: SessionRecord = {
      digest: sha256Hex(token),
      id: randomToken(this.#random, 12),
      label: input.label,
      scope: input.scope,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + this.#ttlMs,
    };
    this.#byDigest.set(record.digest, record);
    this.#digestById.set(record.id, record.digest);
    return { session: view(record), token };
  }

  /** Resolves a bearer token. An unknown, expired or revoked token all raise
   * the same `unauthenticated` refusal, so a caller cannot probe which. */
  authenticate(token: string): DeviceSession {
    const record = this.#byDigest.get(sha256Hex(token));
    if (!record) throw new IdentityError("unauthenticated", "unknown device token");
    const now = this.#clock.now();
    if (record.revokedAt !== undefined) throw new IdentityError("session_revoked", "the device session was revoked");
    if (now >= record.expiresAt) throw new IdentityError("session_expired", "the device session expired");
    record.lastUsedAt = now;
    return view(record);
  }

  get(id: string): DeviceSession | undefined {
    const digest = this.#digestById.get(id);
    const record = digest ? this.#byDigest.get(digest) : undefined;
    return record ? view(record) : undefined;
  }

  /** Refuses a session that is gone, revoked or expired. A ticket redeems
   * through this, so revoking a device also ends the streams it had open. */
  assertActive(id: string): void {
    const digest = this.#digestById.get(id);
    const record = digest ? this.#byDigest.get(digest) : undefined;
    if (!record) throw new IdentityError("unauthenticated", "unknown device session");
    if (record.revokedAt !== undefined) throw new IdentityError("session_revoked", "the device session was revoked");
    if (this.#clock.now() >= record.expiresAt) throw new IdentityError("session_expired", "the device session expired");
  }

  list(): DeviceSession[] {
    return [...this.#byDigest.values()].map(view);
  }

  /** Revoking is idempotent: revoking twice reports the same final state. */
  revoke(id: string): boolean {
    const digest = this.#digestById.get(id);
    if (!digest) return false;
    const record = this.#byDigest.get(digest);
    if (!record) return false;
    if (record.revokedAt === undefined) record.revokedAt = this.#clock.now();
    return true;
  }

  revokeAll(): void {
    const now = this.#clock.now();
    for (const record of this.#byDigest.values()) {
      if (record.revokedAt === undefined) record.revokedAt = now;
    }
  }

  count(): number {
    return this.#byDigest.size;
  }
}

function view(record: SessionRecord): DeviceSession {
  return {
    id: record.id,
    label: record.label,
    scope: record.scope,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
  };
}
