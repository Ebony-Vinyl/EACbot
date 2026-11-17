// The host's side of the platform boards: ask the plugin that serves a platform for its snapshot, check it
// against the shared contract, and hand the route a value it can draw. Nothing here knows what a platform is:
// a board is whatever its plugin answers, so a new platform needs no change in this file.
import { platformBoardSchema, platformSummarySchema, type PlatformBoard, type PlatformSummary } from "../../shared/plugins/boards.ts";
import { PLATFORM_IDS, type PlatformId } from "../../shared/plugins/accounts.ts";
import type { PluginRegistry } from "./registry.ts";

/** A board changes at the pace of a person reading it; a minute keeps the plugin off the hot path. */
const CACHE_MS = 60_000;
const BOARD_TIMEOUT_MS = 8_000;

export type PlatformBoardErrorCode = "not-found" | "runtime-unavailable" | "invalid" | "failed";

export class PlatformBoardError extends Error {
  readonly code: PlatformBoardErrorCode;
  constructor(code: PlatformBoardErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The installation that serves a platform, and whether it can answer right now. */
export interface PlatformBinding {
  installationId: string;
  pluginId: string;
  label: string;
  active: boolean;
  transports: string[];
}

export interface PlatformBoardHostDeps {
  registry: PluginRegistry;
  /** The supervisor's `call`; absent when this build cannot run process plugins. */
  call?(installationId: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  now?(): number;
}

interface CacheEntry {
  board: PlatformBoard;
  at: number;
}

export interface PlatformBoardHost {
  bindings(): PlatformBinding[];
  binding(platform: PlatformId): PlatformBinding | null;
  board(platform: PlatformId, options?: { refresh?: boolean }): Promise<PlatformBoard>;
  summary(platform: PlatformId, options?: { refresh?: boolean }): Promise<PlatformSummary>;
  summaries(options?: { refresh?: boolean }): Promise<PlatformSummary[]>;
  /** Runs a board action through the plugin's `operate` method; the plugin still decides what it may do. */
  operate(platform: PlatformId, action: string, params: unknown): Promise<unknown>;
  /** The plugin's own audit trail, newest last. */
  audit(platform: PlatformId, limit?: number): Promise<unknown[]>;
  forget(installationId?: string): void;
}

export function createPlatformBoardHost(deps: PlatformBoardHostDeps): PlatformBoardHost {
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();

  function bindings(): PlatformBinding[] {
    const found: PlatformBinding[] = [];
    for (const plugin of deps.registry.list()) {
      const record = deps.registry.store.get(plugin.installationId);
      const declared = record?.manifest.contributes.platform;
      if (!declared) continue;
      found.push({
        installationId: plugin.installationId,
        pluginId: plugin.pluginId,
        label: declared.label,
        active: plugin.state === "active",
        transports: [...declared.transports],
      });
    }
    // An active installation wins over a disabled one for the same platform.
    return found.sort((a, b) => Number(b.active) - Number(a.active) || a.installationId.localeCompare(b.installationId));
  }

  function binding(platform: PlatformId): PlatformBinding | null {
    return bindings().find((entry) => deps.registry.store.get(entry.installationId)?.manifest.contributes.platform?.id === platform) ?? null;
  }

  function bindingFor(platform: PlatformId): PlatformBinding {
    const found = binding(platform);
    if (!found) throw new PlatformBoardError("not-found", `No plugin serves ${platform}. Install and activate one from Extensions.`);
    return found;
  }

  async function board(platform: PlatformId, options: { refresh?: boolean } = {}): Promise<PlatformBoard> {
    const target = bindingFor(platform);
    if (!target.active) throw new PlatformBoardError("runtime-unavailable", `${target.label} is installed but not active. Activate it to see its board.`);
    const cached = cache.get(target.installationId);
    if (!options.refresh && cached && now() - cached.at < CACHE_MS) return cached.board;
    if (!deps.call) throw new PlatformBoardError("runtime-unavailable", "This build cannot run plugin processes, so there is no live board.");
    let answer: unknown;
    try {
      answer = await deps.call(target.installationId, "board", { platform }, BOARD_TIMEOUT_MS);
    } catch (error) {
      throw new PlatformBoardError("failed", error instanceof Error ? error.message : String(error));
    }
    const parsed = platformBoardSchema.safeParse(answer);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join(".") ?? "";
      throw new PlatformBoardError("invalid", `the board does not match the contract: ${path ? `${path}: ` : ""}${first?.message ?? "unknown field"}`);
    }
    if (parsed.data.platform !== platform) {
      throw new PlatformBoardError("invalid", `the plugin answered a ${parsed.data.platform} board for ${platform}`);
    }
    cache.set(target.installationId, { board: parsed.data, at: now() });
    return parsed.data;
  }

  async function summary(platform: PlatformId, options: { refresh?: boolean } = {}): Promise<PlatformSummary> {
    if (!PLATFORM_IDS.includes(platform)) throw new PlatformBoardError("not-found", `${platform} is not a platform this host knows.`);
    const target = binding(platform);
    if (!target) {
      return platformSummarySchema.parse({
        platform, label: platform, installationId: null, live: false, account: null, headline: [],
        state: "missing", blocked: [],
        error: "No plugin serves this platform yet.",
      });
    }
    const manifest = deps.registry.store.get(target.installationId)?.manifest.contributes.platform;
    const label = manifest?.label ?? target.label;
    if (!target.active) {
      return platformSummarySchema.parse({
        platform, label, installationId: target.installationId, live: false, account: null, headline: [],
        state: "installed-disabled", blocked: [],
        error: `${label} is installed but not active.`,
      });
    }
    try {
      const snapshot = await board(platform, options);
      const blocked = snapshot.capability
        .filter((entry) => entry.state === "unavailable")
        .map((entry) => ({ id: entry.id, label: entry.label, reason: entry.reason ?? "not available" }));
      return platformSummarySchema.parse({
        platform, label, installationId: target.installationId, live: true,
        account: snapshot.account, headline: snapshot.headline, state: "ready", blocked,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return platformSummarySchema.parse({
        platform, label, installationId: target.installationId, live: false, account: null, headline: [],
        state: error instanceof PlatformBoardError && error.code === "runtime-unavailable" ? "unavailable" : "failed",
        blocked: [], error: message.slice(0, 400),
      });
    }
  }

  async function summaries(options: { refresh?: boolean } = {}): Promise<PlatformSummary[]> {
    return Promise.all(PLATFORM_IDS.map((platform) => summary(platform, options)));
  }

  async function operate(platform: PlatformId, action: string, params: unknown): Promise<unknown> {
    const target = bindingFor(platform);
    if (!target.active) throw new PlatformBoardError("runtime-unavailable", `${target.label} is installed but not active.`);
    if (!deps.call) throw new PlatformBoardError("runtime-unavailable", "This build cannot run plugin processes.");
    try {
      const answer = await deps.call(target.installationId, "operate", { platform, action, params }, 120_000);
      cache.delete(target.installationId);
      return answer;
    } catch (error) {
      throw new PlatformBoardError("failed", error instanceof Error ? error.message : String(error));
    }
  }

  async function audit(platform: PlatformId, limit = 50): Promise<unknown[]> {
    const target = bindingFor(platform);
    if (!target.active) throw new PlatformBoardError("runtime-unavailable", `${target.label} is installed but not active.`);
    if (!deps.call) throw new PlatformBoardError("runtime-unavailable", "This build cannot run plugin processes.");
    const answer = await deps.call(target.installationId, "audit", { platform, limit }, BOARD_TIMEOUT_MS);
    return Array.isArray(answer) ? answer : [];
  }

  function forget(installationId?: string): void {
    if (installationId) cache.delete(installationId);
    else cache.clear();
  }

  return { bindings, binding, board, summary, summaries, operate, audit, forget };
}
