import type { AgentDescriptor, AgentKind, ModelCatalogEntry, ModelRef } from "../../packages/agent-protocol/agents.ts";
import type { AgentCatalogPort } from "../http/ports.ts";
import type { ModelCatalogReading } from "../agents/catalog.ts";

export interface AgentCatalogOptions {
  readonly describe: (kind: AgentKind) => AgentDescriptor | undefined;
  readonly models?: (kind: AgentKind) => ModelCatalogEntry[] | undefined;
  readonly kinds: readonly AgentKind[];
}

/** Reads agent descriptors from whatever registry the composition supplies.
 * A missing catalog is reported as missing rather than as an empty list,
 * because "this engine lists no models" and "this engine cannot list models"
 * are different answers. */
export class AgentCatalog implements AgentCatalogPort {
  readonly #options: AgentCatalogOptions;

  constructor(options: AgentCatalogOptions) {
    this.#options = options;
  }

  list(): AgentDescriptor[] {
    const descriptors: AgentDescriptor[] = [];
    for (const kind of this.#options.kinds) {
      const descriptor = this.#options.describe(kind);
      if (descriptor) descriptors.push(descriptor);
    }
    return descriptors;
  }

  get(kind: AgentKind): AgentDescriptor | undefined {
    return this.#options.describe(kind);
  }

  models(kind: AgentKind): ModelCatalogEntry[] | undefined {
    return this.#options.models?.(kind);
  }
}

export interface ProbedAgentCatalogOptions {
  /** Kinds this composition actually configured, in the order they were written. */
  readonly kinds: readonly AgentKind[];
  readonly describe: (kind: AgentKind) => AgentDescriptor | undefined;
  /** Reads one kind's catalog from the engine itself. It must resolve to an
   * `unknown` reading rather than throw; a rejection is reported the same way. */
  readonly probe: (kind: AgentKind) => Promise<ModelCatalogReading>;
  /** The model an instance starts on when a caller names none. */
  readonly defaultModel?: (kind: AgentKind) => ModelRef | undefined;
  /** Milliseconds since the epoch; injected so a test's TTL is deterministic. */
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly onProbeError?: (kind: AgentKind, error: unknown) => void;
}

interface CachedReading {
  readonly reading: ModelCatalogReading;
  readonly at: number;
}

export const DEFAULT_CATALOG_TTL_MS = 5 * 60_000;

/** Descriptors from the real registry, plus each kind's model catalog as the
 * engine answered it.
 *
 * The port is synchronous, so this class keeps the last reading and refreshes
 * it in the background when a reader asks and the reading is stale. A probe
 * that failed is remembered as `unknown` with its reason; it is never turned
 * into a model list, and `models()` answers `undefined` for it so the HTTP
 * layer can say `reported: false` instead of an empty catalog. */
export class ProbedAgentCatalog implements AgentCatalogPort {
  readonly #options: ProbedAgentCatalogOptions;
  readonly #readings = new Map<AgentKind, CachedReading>();
  readonly #inflight = new Map<AgentKind, Promise<ModelCatalogReading>>();

  constructor(options: ProbedAgentCatalogOptions) {
    this.#options = options;
  }

  list(): AgentDescriptor[] {
    const descriptors: AgentDescriptor[] = [];
    for (const kind of this.#options.kinds) {
      const descriptor = this.#descriptor(kind);
      if (descriptor) descriptors.push(descriptor);
    }
    return descriptors;
  }

  get(kind: AgentKind): AgentDescriptor | undefined {
    if (!this.#options.kinds.includes(kind)) return undefined;
    return this.#descriptor(kind);
  }

  /** `undefined` means this kind's catalog has not been read or could not be
   * read. It never stands in for "the engine listed nothing". */
  models(kind: AgentKind): ModelCatalogEntry[] | undefined {
    const cached = this.#readings.get(kind);
    if (this.#isStale(kind)) void this.refresh(kind);
    if (!cached) return undefined;
    return catalogEntries(kind, cached.reading);
  }

  /** The last reading, including the reason an engine could not be read. */
  reading(kind: AgentKind): ModelCatalogReading | undefined {
    return this.#readings.get(kind)?.reading;
  }

  defaultModel(kind: AgentKind): ModelRef | undefined {
    return this.#options.defaultModel?.(kind);
  }

  /** Re-reads one kind, sharing an in-flight probe with every concurrent caller. */
  refresh(kind: AgentKind, options: { readonly force?: boolean } = {}): Promise<ModelCatalogReading> {
    const running = this.#inflight.get(kind);
    if (running) return running;
    if (options.force !== true && !this.#isStale(kind) && this.#readings.has(kind)) {
      return Promise.resolve(this.#readings.get(kind)!.reading);
    }
    const probe = this.#probe(kind);
    this.#inflight.set(kind, probe);
    return probe;
  }
  /** Re-reads every configured kind. The first caller does the work; a second
   * caller joins the same probes instead of starting more processes. */
  async refreshAll(): Promise<void> {
    await Promise.all(this.#options.kinds.map((kind) => this.refresh(kind, { force: true })));
  }

  #descriptor(kind: AgentKind): AgentDescriptor | undefined {
    const descriptor = this.#options.describe(kind);
    if (!descriptor) return undefined;
    const models = this.models(kind);
    return models === undefined ? { ...descriptor, models: [] } : { ...descriptor, models };
  }

  #isStale(kind: AgentKind): boolean {
    const cached = this.#readings.get(kind);
    if (!cached) return true;
    const now = (this.#options.now ?? Date.now)();
    return now - cached.at >= (this.#options.ttlMs ?? DEFAULT_CATALOG_TTL_MS);
  }

  async #probe(kind: AgentKind): Promise<ModelCatalogReading> {
    let reading: ModelCatalogReading;
    try {
      reading = await this.#options.probe(kind);
    } catch (error) {
      this.#options.onProbeError?.(kind, error);
      reading = { state: "unknown", agentId: kind, reason: describeError(error) };
    }
    this.#readings.set(kind, { reading, at: (this.#options.now ?? Date.now)() });
    this.#inflight.delete(kind);
    return reading;
  }
}

/** The wire's model entries for one reading, or `undefined` when the engine did
 * not report a catalog. A model id is `provider/model`, which is the form the
 * bridge splits back into the engine's own pair. */
export function catalogEntries(kind: AgentKind, reading: ModelCatalogReading): ModelCatalogEntry[] | undefined {
  if (reading.state !== "reported") return undefined;
  return reading.options.map((option) => ({
    ref: {
      agent: kind,
      model: `${option.ref.providerId}/${option.ref.modelId}`,
      ...(option.label !== "" ? { label: option.label } : {}),
    },
  }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
