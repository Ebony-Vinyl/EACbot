import { z } from "zod";

import { parseSemVer } from "./semver.ts";

export const PLUGIN_TRUST_TIERS = ["official", "reviewed", "community"] as const;
export type PluginTrustTier = (typeof PLUGIN_TRUST_TIERS)[number];

export const TRUST_RANK: Readonly<Record<PluginTrustTier, number>> = { community: 0, reviewed: 1, official: 2 };

const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 hex digest");
const exactVersion = z.string().max(120).refine((value) => parseSemVer(value) !== null, "must be an exact SemVer version");
const platform = z.string().regex(/^[a-z0-9]+-[a-z0-9]+$/, "must be an OS-arch pair");
const httpsUrl = z.string().url().max(1_000).refine((value) => value.startsWith("https://"), "must use https");

export const catalogArtifactSchema = z.object({
  platform,
  url: httpsUrl,
  sha256,
  size: z.number().int().min(1).max(512 * 1024 * 1024),
}).strict();

export const catalogEntrySchema = z.object({
  pluginId: z.string().max(100).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}$/),
  version: exactVersion,
  manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().max(500).optional(),
  artifacts: z.array(catalogArtifactSchema).min(1).max(12),
  review: z.object({
    tier: z.enum(PLUGIN_TRUST_TIERS),
    checkedAt: timestamp.optional(),
  }).strict(),
}).strict();

export const catalogRevocationSchema = z.object({
  pluginId: z.string().max(100),
  version: exactVersion.optional(),
  artifactSha256: sha256.optional(),
  reason: z.string().trim().min(1).max(500),
  revokedAt: timestamp,
}).strict();

export const catalogPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  sequence: z.number().int().min(0),
  issuedAt: timestamp,
  expiresAt: timestamp,
  entries: z.array(catalogEntrySchema).max(500),
  revoked: z.array(catalogRevocationSchema).max(1_000),
}).strict().superRefine((payload, context) => {
  const keys = new Set<string>();
  for (const entry of payload.entries) {
    const key = `${entry.pluginId}@${entry.version}`;
    if (keys.has(key)) context.addIssue({ code: "custom", path: ["entries"], message: `duplicate catalog entry: ${key}` });
    keys.add(key);
    const platforms = entry.artifacts.map((artifact) => artifact.platform);
    if (new Set(platforms).size !== platforms.length) {
      context.addIssue({ code: "custom", path: ["entries"], message: `duplicate artifact platform in ${key}` });
    }
  }
});

export const catalogEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  keyId: z.string().max(80).regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  algorithm: z.literal("ed25519"),
  payload: z.unknown(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{40,200}$/),
}).strict();

export type CatalogArtifact = z.infer<typeof catalogArtifactSchema>;
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export type CatalogRevocation = z.infer<typeof catalogRevocationSchema>;
export type CatalogPayload = z.infer<typeof catalogPayloadSchema>;
export type CatalogEnvelope = z.infer<typeof catalogEnvelopeSchema>;

export function catalogEntryKey(entry: Pick<CatalogEntry, "pluginId" | "version">): string {
  return `${entry.pluginId}@${entry.version}`;
}
