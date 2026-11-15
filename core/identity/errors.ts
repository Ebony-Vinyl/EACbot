/** Typed refusals from the identity layer. The HTTP layer maps each `code` to
 * a status and to the wire error envelope; nothing here knows about HTTP. */
export const IDENTITY_ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "pairing_unknown",
  "pairing_expired",
  "pairing_consumed",
  "pairing_exhausted",
  "session_expired",
  "session_revoked",
  "ticket_invalid",
  "ticket_expired",
  "ticket_used",
  "ticket_purpose_mismatch",
] as const;

export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number];

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
  }
}
