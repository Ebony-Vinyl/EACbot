// The quotas a person may raise in config.json under "limits", as the process holds them right now.
//
// Why this file exists: config.ts owns the schema, but the modules that enforce a quota (MCP servers, images per day,
// the attachment store, room posting, tool counts) are imported by config.ts, so they cannot import it back without an
// import cycle. config.ts mirrors the saved section here on every load and save instead; each quota module reads its
// own number from here. An absent key always means the old, hard-coded value, so an untouched config.json behaves
// exactly as it did before "limits" existed.

/** Write-hard caps that used to be fixed numbers. Every key is optional; absent keeps the pre-existing default. */
export interface QuotaLimits {
  /** How many bots one workspace may hold (was 100). */
  botsPerWorkspace?: number;
  /** The most parallel threads one bot may run (was 16). */
  botThreads?: number;
  /** Bytes the attachment library may hold (was 512 MB, or 8 GB on a Cloud home). */
  attachmentsMaxBytes?: number;
  /** Images bots may generate on this installation in one day (was 50). */
  imagesPerDay?: number;
  /** Tools one Chat Completions request may carry (was 128). */
  chatToolsPerRequest?: number;
  /** MCP servers one workspace may hold (was 20). */
  mcpServers?: number;
  /** Room posts one bot turn may make (was 3). */
  roomPostsPerTurn?: number;
  /** Room posts one bot may make in a minute (was 10). */
  roomPostsPerMinute?: number;
  /** Unanswered bot posts a room takes before it asks a person (was 2). */
  roomPostsWithoutReply?: number;
  /** Minutes a room stays closed after its bots answered each other in a loop (was 5). */
  roomBreakerMinutes?: number;
}

let effective: QuotaLimits = {};

/** Set by server/config.ts only, right after config.json is read or saved. */
export function setQuotaLimits(limits: QuotaLimits | undefined): void {
  effective = { ...limits };
}

/** The quotas in force now; empty until the first loadConfig(), which is the same thing as "all defaults". */
export function quotaLimits(): QuotaLimits {
  return effective;
}

/** A saved value when it is a positive whole number, else the fallback: a hand-edited file cannot lower a cap to zero. */
export function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
