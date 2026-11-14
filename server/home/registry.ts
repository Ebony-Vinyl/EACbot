// The home domain's entity index. Adapters own transports; this owns what the person sees: which adapters
// answered, what each can do, and a snapshot the view and the tools read. A failing adapter is reported as
// such and never takes the others down with it.
import type { HomeAdapter, HomeAdapterSummary, HomeEntity, HomeSnapshot, HomeZone } from "../../shared/home.ts";

export interface HomeRegistryOptions {
  adapters: readonly HomeAdapter[];
  now?: () => string;
  /** How long a snapshot is reused, so a chatty UI does not poll every vendor on every keystroke. */
  cacheMs?: number;
}

const DEFAULT_CACHE_MS = 15_000;

interface CacheEntry {
  at: number;
  status: HomeAdapterSummary["status"];
  reason?: string;
  zones: HomeZone[];
  entities: HomeEntity[];
}

/** The adapters' entity index, with a short cache and per-adapter failure isolation. */
export class HomeRegistry {
  private readonly adapters = new Map<string, HomeAdapter>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => string;
  private readonly cacheMs: number;

  constructor(options: HomeRegistryOptions) {
    for (const adapter of options.adapters) {
      if (this.adapters.has(adapter.adapterId)) throw new Error(`two home adapters claim ${adapter.adapterId}`);
      this.adapters.set(adapter.adapterId, adapter);
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  }

  adapter(adapterId: string): HomeAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  list(): HomeAdapterSummary[] {
    return [...this.adapters.values()].map((adapter) => {
      const cached = this.cache.get(adapter.adapterId);
      return {
        adapterId: adapter.adapterId,
        label: adapter.label,
        kind: adapter.kind,
        status: cached?.status ?? "ready",
        ...(cached?.reason ? { statusReason: cached.reason } : {}),
        entityCount: cached?.entities.length ?? 0,
        ...(cached ? { lastSeenAt: new Date(cached.at).toISOString() } : {}),
        controllable: adapter.controllable,
      };
    });
  }

  private async refresh(adapter: HomeAdapter, force: boolean): Promise<CacheEntry> {
    const cached = this.cache.get(adapter.adapterId);
    if (!force && cached && Date.now() - cached.at < this.cacheMs) return cached;
    try {
      const snapshot = await adapter.snapshot();
      const entry: CacheEntry = {
        at: Date.now(),
        status: snapshot.status,
        ...(snapshot.reason ? { reason: snapshot.reason } : {}),
        zones: snapshot.zones,
        entities: snapshot.entities,
      };
      this.cache.set(adapter.adapterId, entry);
      return entry;
    } catch (error) {
      // An adapter that throws is unreachable, not a reason to fail the whole home.
      const entry: CacheEntry = {
        at: Date.now(), status: "unreachable",
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        zones: cached?.zones ?? [], entities: (cached?.entities ?? []).map((entity) => ({ ...entity, available: false })),
      };
      this.cache.set(adapter.adapterId, entry);
      return entry;
    }
  }

  async snapshot(options: { force?: boolean } = {}): Promise<HomeSnapshot> {
    const entries = await Promise.all([...this.adapters.values()].map(async (adapter) => [adapter.adapterId, await this.refresh(adapter, options.force ?? false)] as const));
    const zones: HomeZone[] = [];
    const entities: HomeEntity[] = [];
    const seen = new Set<string>();
    for (const [, entry] of entries) {
      for (const zone of entry.zones) if (!seen.has(`z:${zone.zone}`)) { seen.add(`z:${zone.zone}`); zones.push(zone); }
      for (const entity of entry.entities) if (!seen.has(entity.entityId)) { seen.add(entity.entityId); entities.push(entity); }
    }
    entities.sort((a, b) => (a.zone ?? "~").localeCompare(b.zone ?? "~") || a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
    return { adapters: this.list(), zones: zones.sort((a, b) => a.name.localeCompare(b.name)), entities, at: this.now() };
  }

  async entity(entityId: string): Promise<HomeEntity | null> {
    const adapterId = entityId.slice(0, entityId.indexOf(":"));
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return null;
    const entry = await this.refresh(adapter, false);
    return entry.entities.find((entity) => entity.entityId === entityId) ?? null;
  }

  /** Drops the cached snapshot, so the next read goes to the adapters. */
  invalidate(adapterId?: string): void {
    if (adapterId) this.cache.delete(adapterId);
    else this.cache.clear();
  }

  async dispose(): Promise<void> {
    this.cache.clear();
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.dispose?.().catch(() => {})));
  }
}
