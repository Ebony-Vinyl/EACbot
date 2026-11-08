import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicKey } from "node:crypto";
import { z } from "zod";

import { PLUGIN_TRUST_TIERS, type PluginTrustTier } from "../../shared/plugins/catalog.ts";
import { writeFileAtomic } from "../atomic.ts";

const channelSchema = z.object({
  sourceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  name: z.string().trim().min(1).max(80),
  url: z.string().url().max(1_000).refine((value) => value.startsWith("https://"), "must use https"),
  keyId: z.string().max(80).regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  publicKeyPem: z.string().min(1).max(4_096),
  trust: z.enum(PLUGIN_TRUST_TIERS),
  enabled: z.boolean(),
  sequence: z.number().int().min(0),
  lastFetchedAt: z.string().datetime({ offset: true }).optional(),
  lastError: z.string().max(500).optional(),
}).strict();

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  channels: z.array(channelSchema).max(50),
  removedDefaults: z.array(z.string().max(80)).max(50).optional(),
}).strict();

export type PluginChannel = z.infer<typeof channelSchema>;
export type PluginChannelInput = Omit<PluginChannel, "enabled" | "sequence" | "lastFetchedAt" | "lastError" | "trust"> & { trust?: PluginTrustTier };

export class PluginChannelError extends Error {
  readonly code: "invalid" | "duplicate" | "not-found" | "corrupt";
  constructor(code: PluginChannelError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export class PluginChannelStore {
  readonly file: string;
  private channels: PluginChannel[] | null = null;
  private removedDefaults: string[] = [];
  private readonly now: () => string;

  constructor(dataDir: string, options: { now?: () => string } = {}) {
    this.file = join(dataDir, "plugins", "channels.json");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  list(): PluginChannel[] {
    return this.load().map((channel) => structuredClone(channel));
  }

  get(sourceId: string): PluginChannel | null {
    const channel = this.load().find((item) => item.sourceId === sourceId);
    return channel ? structuredClone(channel) : null;
  }

  /** Seed the built-in source when it is absent; a deliberate removal is remembered and is not resurrected. */
  ensureDefault(input: PluginChannelInput & { trust: PluginTrustTier }): PluginChannel | null {
    if (this.removedDefaults.includes(input.sourceId) || this.load().some((channel) => channel.sourceId === input.sourceId)) return null;
    try {
      return this.add(input);
    } catch (error) {
      if (error instanceof PluginChannelError && error.code === "duplicate") return null;
      throw error;
    }
  }

  add(input: PluginChannelInput): PluginChannel {
    const parsed = channelSchema.safeParse({
      ...input,
      trust: input.trust ?? "community",
      enabled: true,
      sequence: 0,
    });
    if (!parsed.success) throw new PluginChannelError("invalid", parsed.error.issues[0]?.message ?? "invalid channel");
    try {
      createPublicKey(parsed.data.publicKeyPem);
    } catch {
      throw new PluginChannelError("invalid", "the channel public key is unreadable");
    }
    const channels = this.load();
    if (channels.some((channel) => channel.sourceId === parsed.data.sourceId)) {
      throw new PluginChannelError("duplicate", `channel ${parsed.data.sourceId} already exists`);
    }
    this.removedDefaults = this.removedDefaults.filter((sourceId) => sourceId !== parsed.data.sourceId);
    channels.push(parsed.data);
    this.persist(channels);
    return structuredClone(parsed.data);
  }

  setEnabled(sourceId: string, enabled: boolean): PluginChannel {
    return this.mutate(sourceId, (channel) => ({ ...channel, enabled }));
  }

  accepted(sourceId: string, sequence: number): PluginChannel {
    return this.mutate(sourceId, (channel) => ({ ...channel, sequence, lastFetchedAt: this.now(), lastError: undefined }));
  }

  failed(sourceId: string, error: string): PluginChannel {
    return this.mutate(sourceId, (channel) => ({ ...channel, lastError: error.slice(0, 500) }));
  }

  remove(sourceId: string): PluginChannel {
    const channels = this.load();
    const index = channels.findIndex((channel) => channel.sourceId === sourceId);
    if (index < 0) throw new PluginChannelError("not-found", `no channel ${sourceId}`);
    const [removed] = channels.splice(index, 1);
    if (!this.removedDefaults.includes(sourceId)) this.removedDefaults.push(sourceId);
    this.persist(channels);
    return structuredClone(removed!);
  }

  private mutate(sourceId: string, change: (channel: PluginChannel) => PluginChannel): PluginChannel {
    const channels = this.load();
    const index = channels.findIndex((channel) => channel.sourceId === sourceId);
    if (index < 0) throw new PluginChannelError("not-found", `no channel ${sourceId}`);
    const next = change(channels[index]!);
    channels[index] = next;
    this.persist(channels);
    return structuredClone(next);
  }

  private load(): PluginChannel[] {
    if (this.channels) return this.channels.map((channel) => structuredClone(channel));
    if (!existsSync(this.file)) {
      this.channels = [];
      return [];
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new PluginChannelError("corrupt", "plugins/channels.json is not valid JSON");
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) throw new PluginChannelError("corrupt", "plugins/channels.json does not match schema version 1");
    this.channels = parsed.data.channels;
    this.removedDefaults = parsed.data.removedDefaults ?? [];
    return parsed.data.channels.map((channel) => structuredClone(channel));
  }

  private persist(channels: PluginChannel[]): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify({ schemaVersion: 1, channels, removedDefaults: this.removedDefaults }, null, 2) + "\n", { mode: 0o600 });
    this.channels = channels;
  }
}
