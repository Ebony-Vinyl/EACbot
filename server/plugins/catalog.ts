import { createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import {
  catalogEnvelopeSchema,
  catalogPayloadSchema,
  TRUST_RANK,
  type CatalogEntry,
  type CatalogPayload,
  type CatalogRevocation,
  type CatalogEnvelope,
  type PluginTrustTier,
} from "../../shared/plugins/catalog.ts";
import { canonicalJson } from "./manifest-digest.ts";

export interface CatalogKey {
  publicKey: string | KeyObject;
  trust: PluginTrustTier;
}

export interface CatalogVerifyOptions {
  keys: Readonly<Record<string, CatalogKey>>;
  now: Date;
  minimumSequence?: number;
}

export type CatalogVerifyCode =
  | "invalid-envelope"
  | "unknown-key"
  | "invalid-key"
  | "bad-signature"
  | "invalid-payload"
  | "not-yet-valid"
  | "expired"
  | "stale-sequence"
  | "trust-escalation"
  | "range-too-long";

export type CatalogVerification =
  | { ok: true; payload: CatalogPayload; keyId: string; trust: PluginTrustTier }
  | { ok: false; code: CatalogVerifyCode; error: string };

const MAX_LIFETIME_MS = 90 * 24 * 60 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;

function parseIssued(value: string): number {
  return Date.parse(value);
}

export function verifyCatalog(envelope: unknown, options: CatalogVerifyOptions): CatalogVerification {
  const parsedEnvelope = catalogEnvelopeSchema.safeParse(envelope);
  if (!parsedEnvelope.success) return { ok: false, code: "invalid-envelope", error: "the catalog envelope is malformed" };
  const value: CatalogEnvelope = parsedEnvelope.data;
  const key = options.keys[value.keyId];
  if (!key) return { ok: false, code: "unknown-key", error: `the catalog key ${value.keyId} is not trusted` };

  let publicKey: KeyObject;
  try {
    publicKey = typeof key.publicKey === "string" ? createPublicKey(key.publicKey) : key.publicKey;
  } catch {
    return { ok: false, code: "invalid-key", error: `the catalog key ${value.keyId} is unreadable` };
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(value.signature, "base64url");
  } catch {
    return { ok: false, code: "bad-signature", error: "the catalog signature is not valid base64url" };
  }
  const data = Buffer.from(canonicalJson(value.payload));
  try {
    if (!verify(null, data, publicKey, signature)) {
      return { ok: false, code: "bad-signature", error: "the catalog signature does not match its payload" };
    }
  } catch {
    return { ok: false, code: "bad-signature", error: "the catalog signature could not be checked" };
  }

  const parsedPayload = catalogPayloadSchema.safeParse(value.payload);
  if (!parsedPayload.success) return { ok: false, code: "invalid-payload", error: "the catalog payload is malformed" };
  const payload = parsedPayload.data;
  const issuedAt = parseIssued(payload.issuedAt);
  const expiresAt = parseIssued(payload.expiresAt);
  const now = options.now.getTime();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    return { ok: false, code: "invalid-payload", error: "the catalog lifetime is invalid" };
  }
  if (issuedAt > now + CLOCK_SKEW_MS) return { ok: false, code: "not-yet-valid", error: "the catalog is not valid yet" };
  if (expiresAt <= now) return { ok: false, code: "expired", error: "the catalog has expired" };
  if (expiresAt - issuedAt > MAX_LIFETIME_MS) return { ok: false, code: "range-too-long", error: "the catalog lifetime is longer than 90 days" };
  if (options.minimumSequence !== undefined && payload.sequence < options.minimumSequence) {
    return { ok: false, code: "stale-sequence", error: "the catalog sequence is older than the last accepted one" };
  }
  for (const entry of payload.entries) {
    if (TRUST_RANK[entry.review.tier] > TRUST_RANK[key.trust]) {
      return { ok: false, code: "trust-escalation", error: `key ${value.keyId} cannot publish a ${entry.review.tier} entry` };
    }
  }
  return { ok: true, payload, keyId: value.keyId, trust: key.trust };
}

/** A revocation naming only the plugin revokes every version; a version or artifact digest narrows it. */
export function catalogRevocation(
  payload: CatalogPayload,
  entry: Pick<CatalogEntry, "pluginId" | "version">,
  artifactSha256?: string,
): CatalogRevocation | null {
  return payload.revoked.find((revocation) =>
    revocation.pluginId === entry.pluginId
    && (revocation.version === undefined || revocation.version === entry.version)
    && (revocation.artifactSha256 === undefined || (artifactSha256 !== undefined && revocation.artifactSha256 === artifactSha256))
  ) ?? null;
}

export function catalogArtifact(
  payload: CatalogPayload,
  pluginId: string,
  version: string,
  platform: string,
): CatalogEntry["artifacts"][number] | null {
  const entry = payload.entries.find((candidate) => candidate.pluginId === pluginId && candidate.version === version);
  return entry?.artifacts.find((artifact) => artifact.platform === platform) ?? null;
}
