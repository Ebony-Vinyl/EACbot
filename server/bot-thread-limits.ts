// How many threads one bot runs at once.
import { totalmem } from "node:os";

import { engineMemory } from "./engine-memory.ts";
import { positiveLimit } from "./limits.ts";

/** The per-bot thread ceiling when config.json says nothing (and the cap a "one thread per bot" plan still keeps for a bot's own children). */
export const MAX_CONCURRENT_BOT_THREADS = 16;
/** The most config.json "limits.botThreads" or "threads.maxConcurrentPerBot" may name. */
export const MAX_BOT_THREADS_SETTING = 1_024;
const DEFAULT_THREADS_FLOOR = 3, BYTES_PER_DEFAULT_THREAD = 2 * 1024 ** 3;

/** Where the memory gate runs it decides, so only the ceiling applies; elsewhere nothing protects the machine. */
export interface BotThreadsHost { memoryGate: boolean; totalBytes: number; oneThreadPerBot: boolean }
type SavedThreads = { threads?: { maxConcurrentPerBot?: number }; limits?: { botThreads?: number } };

/** config.json "limits.botThreads" raises the ceiling; absent keeps 16. */
const threadCeiling = (cfg: SavedThreads): number => positiveLimit(cfg.limits?.botThreads, MAX_CONCURRENT_BOT_THREADS);

export const botThreadsHost = (oneThreadPerBot = false): BotThreadsHost => ({ memoryGate: engineMemory.enabled, totalBytes: totalmem(), oneThreadPerBot });

export function defaultBotThreads(
  host: Pick<BotThreadsHost, "memoryGate" | "totalBytes"> = botThreadsHost(),
  ceiling: number = MAX_CONCURRENT_BOT_THREADS,
): number {
  if (host.memoryGate) return ceiling;
  return Math.min(ceiling, Math.max(DEFAULT_THREADS_FLOOR, Math.round(host.totalBytes / BYTES_PER_DEFAULT_THREAD)));
}

/** Separate work a person or a routine starts. A plan's limit outranks a saved number. */
export function maxConcurrentBotThreads(cfg: SavedThreads, host: BotThreadsHost = botThreadsHost()): number {
  if (host.oneThreadPerBot) return 1;
  return cfg.threads?.maxConcurrentPerBot ?? defaultBotThreads(host, threadCeiling(cfg));
}

/** Work a bot's own turn started (its own thread, a hand-off). That turn may be waiting on it, so a plan's limit never holds
 * it behind the turn that started it. */
export function maxConcurrentChildThreads(cfg: SavedThreads, host: BotThreadsHost = botThreadsHost()): number {
  return host.oneThreadPerBot ? MAX_CONCURRENT_BOT_THREADS : maxConcurrentBotThreads(cfg, host);
}

export function botThreadLimitText(cfg: SavedThreads, host: BotThreadsHost = botThreadsHost()): string {
  return host.oneThreadPerBot
    ? "Starter runs one thread at a time per bot — wait for it to finish, or move to a bigger plan to run more"
    : `this bot has reached its limit of ${maxConcurrentBotThreads(cfg, host)} parallel threads — wait for one to finish`;
}
