import type { Clock, Random } from "../crypto.ts";

/** A clock a test moves by hand, so expiry is asserted rather than slept. */
export class ManualClock implements Clock {
  #now: number;

  constructor(start = Date.parse("2026-01-01T00:00:00.000Z")) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  iso(): string {
    return new Date(this.#now).toISOString();
  }
}

/** Deterministic bytes: every call returns the next counter, so two runs of the
 * same test produce the same tokens and pairing code. */
export class CountingRandom implements Random {
  #next = 0;

  bytes(size: number): Uint8Array {
    const out = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      this.#next = (this.#next + 1) & 0xff;
      out[index] = this.#next;
    }
    return out;
  }
}
