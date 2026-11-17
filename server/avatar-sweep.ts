// Every bot wears a face from the pool the app ships with. The sweep runs once per data directory: the marker it
// leaves is what makes it a one-time change, so a later restart, redeploy or upgrade never undoes a face someone has
// since chosen by hand.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { saveImage } from "./attachments.ts";
import { pickPoolAvatar } from "./avatar-pool.ts";
import { botAvatarUrlFromStoredPath } from "../shared/bot-avatar.ts";
import type { BotRecord } from "./store.ts";

const MARKER = "avatar-pool-applied";

/** What the sweep needs from the store: the roster, and the one field it writes. */
export interface AvatarSweepStore {
  bots: BotRecord[];
  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null;
}

export interface AvatarSweepResult {
  changed: number;
  failed: number;
}

/**
 * Gives a bot a face from the pool: stored as an attachment, so the picture outlives the pool entry and needs no
 * second copy. False when the pool is empty or the picture could not be stored.
 */
export function givePoolAvatar(store: AvatarSweepStore, dataDir: string, botId: string): boolean {
  const pool = pickPoolAvatar(dataDir, botId);
  if (!pool) return false;
  try {
    const url = botAvatarUrlFromStoredPath(saveImage(pool.bytes, pool.mime).path);
    if (!url) return false;
    return Boolean(store.patchBot(botId, { avatarUrl: url, avatarCrop: "circle" }));
  } catch {
    return false;
  }
}

/** Puts a pool face on every bot in the roster, replacing whatever it wore. */
export function applyPoolAvatars(store: AvatarSweepStore, dataDir: string): AvatarSweepResult {
  const result: AvatarSweepResult = { changed: 0, failed: 0 };
  for (const bot of store.bots) {
    if (givePoolAvatar(store, dataDir, bot.id)) result.changed += 1;
    else result.failed += 1;
  }
  return result;
}

/** Runs {@link applyPoolAvatars} once for this data directory; later boots see the marker and do nothing. */
export function applyPoolAvatarsOnce(store: AvatarSweepStore, dataDir: string): AvatarSweepResult | null {
  const marker = join(dataDir, MARKER);
  if (existsSync(marker)) return null;
  const result = applyPoolAvatars(store, dataDir);
  try {
    writeFileSync(marker, "Every bot took a face from the app's own pool.\n", { mode: 0o600 });
  } catch {}
  return result;
}
