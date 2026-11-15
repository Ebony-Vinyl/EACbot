import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface Clock {
  now(): number;
}

export interface Random {
  bytes(size: number): Uint8Array;
}

export const systemClock: Clock = { now: () => Date.now() };

export const systemRandom: Random = { bytes: (size) => randomBytes(size) };

/** Unambiguous characters only: no I, O, 0 or 1, so a code read off a screen
 * cannot be mistyped into another valid code. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomToken(random: Random, byteLength = 32): string {
  return Buffer.from(random.bytes(byteLength)).toString("base64url");
}

export function pairingCode(random: Random, length = 8): string {
  const bytes = random.bytes(length);
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[(bytes[index] ?? 0) % CODE_ALPHABET.length];
  }
  return code;
}

export function formatPairingCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function normalizePairingCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/gu, "");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two digests. Both sides are always 32 bytes,
 * so the length check leaks nothing about the compared secret. */
export function digestsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
