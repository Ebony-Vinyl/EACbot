/** Flow control for the terminal stream: the server grants a window, and the
 * workbench returns credit for bytes the terminal has actually drawn.
 *
 * Credit goes back after `Terminal.write`'s callback, never on receipt, so a
 * slow renderer slows the stream instead of dropping output. A repaint (a
 * `ready` or `resync`) starts a fresh screen, so bytes still being drawn are
 * not credited twice.
 */

import { INITIAL_CREDIT_BYTES } from "./terminal-transport.ts";

export interface CreditLedger {
  /** Bytes received and not yet credited. */
  readonly pending: number;
  /** The window the server granted, as this client counts it down. */
  readonly window: number;
}

export function newCreditLedger(initial = INITIAL_CREDIT_BYTES): CreditLedger {
  return { pending: 0, window: initial };
}

export function received(ledger: CreditLedger, bytes: number): CreditLedger {
  if (!Number.isFinite(bytes) || bytes <= 0) return ledger;
  return { pending: ledger.pending + Math.floor(bytes), window: Math.max(0, ledger.window - Math.floor(bytes)) };
}

/** Credits everything drawn so far and refills the window by that amount. */
export function drawn(ledger: CreditLedger): { ledger: CreditLedger; credit: number } {
  if (ledger.pending <= 0) return { ledger, credit: 0 };
  return { ledger: { pending: 0, window: ledger.window + ledger.pending }, credit: ledger.pending };
}

/** A new screen: uncredited bytes from the old one will never be drawn. */
export function repainted(ledger: CreditLedger, initial = INITIAL_CREDIT_BYTES): CreditLedger {
  return { pending: 0, window: Math.max(ledger.window, initial) };
}
