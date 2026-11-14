import type { AuthMode } from "./agents.ts";

/** An opaque reference to a credential held by the environment agent. A value
 * of this type is a handle, never key material. */
export type CredentialRef = string & { readonly __credentialRef: unique symbol };

export type EnvironmentKind = "ssh" | "local";

/** The user-owned computer a mission runs on. It carries a credential handle,
 * a pinned host-key fingerprint and a base URL at most: never a private key,
 * password or token body. */
export interface EnvironmentRef {
  readonly id: string;
  readonly label: string;
  readonly kind: EnvironmentKind;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly authMode: AuthMode;
  readonly credentialRef?: CredentialRef;
  readonly baseUrl?: string;
  readonly hostKeyFingerprint?: string;
}

/** Fields that must never be persisted on an EnvironmentRef or anywhere a
 * mission record is stored. */
export const SECRET_FIELD_NAMES = [
  "privateKey",
  "privateKeyPath",
  "keyBody",
  "password",
  "passphrase",
  "token",
  "apiKey",
  "secret",
  "clientSecret",
  "refreshToken",
] as const;

export type SecretFieldName = (typeof SECRET_FIELD_NAMES)[number];
