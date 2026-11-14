// The sign-ins a cloud health source holds, kept apart from config.json so an exported or synced config never
// carries a token. One record per source id; a record never follows its source to another provider.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import type { HealthOAuthProvider, HealthOAuthRecord } from "./adapters/oauth.ts";

const FILE = "health-cloud.json";

const tokensSchema = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1).optional(),
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
});

const recordSchema = z.object({
  provider: z.enum(["withings", "oura", "polar", "fitbit"]),
  sourceId: z.string().min(1).max(120),
  clientId: z.string().min(1),
  tokens: tokensSchema,
  redirectUri: z.string(),
  account: z.string().max(200).optional(),
  /** The last sync's resume point, so a restart does not re-read a year of history. */
  cursor: z.string().max(60).optional(),
  lastSyncAt: z.string().max(40).optional(),
});

const fileSchema = z.object({
  sources: z.record(z.string(), recordSchema).default({}),
});

export type HealthCloudRecord = z.infer<typeof recordSchema>;
type StoreFile = z.infer<typeof fileSchema>;

export class HealthCloudStore {
  private readonly file: string;

  constructor(options: { dataDir: string }) {
    this.file = join(options.dataDir, FILE);
  }

  get(sourceId: string): HealthCloudRecord | undefined {
    return this.read().sources[sourceId];
  }

  all(): HealthCloudRecord[] {
    return Object.values(this.read().sources);
  }

  put(record: HealthOAuthRecord & { cursor?: string; lastSyncAt?: string }): void {
    const data = this.read();
    const previous = data.sources[record.sourceId];
    data.sources[record.sourceId] = recordSchema.parse({
      ...record,
      ...(record.cursor === undefined && previous?.cursor ? { cursor: previous.cursor } : {}),
    });
    this.write(data);
  }

  /** Records the resume point without touching the tokens, so a sync never rewrites a fresh sign-in. */
  advance(sourceId: string, cursor: string, lastSyncAt: string): void {
    const data = this.read();
    const current = data.sources[sourceId];
    if (!current) return;
    data.sources[sourceId] = { ...current, cursor, lastSyncAt };
    this.write(data);
  }

  delete(sourceId: string): void {
    const data = this.read();
    if (!Object.hasOwn(data.sources, sourceId)) return;
    delete data.sources[sourceId];
    this.write(data);
  }

  providerOf(sourceId: string): HealthOAuthProvider | undefined {
    return this.get(sourceId)?.provider;
  }

  // Read through on every call: another process may have changed the file.
  private read(): StoreFile {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {}
    return { sources: {} };
  }

  private write(data: StoreFile): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
