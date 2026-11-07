import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const mimeFor = (name: string): string | undefined => {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  return MIME_BY_EXT[name.slice(dot).toLowerCase()];
};

/** A fresh avatar for a new bot: an image from the owner's pool at DATA_DIR/avatar-pool (drop files there
 * to grow it), picked by a stable hash of the bot id so new bots spread across the pool. */
export function pickPoolAvatar(dataDir: string, botId: string): { bytes: Buffer; mime: string } | null {
  const dir = join(dataDir, "avatar-pool");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => Boolean(mimeFor(name))).sort();
  } catch {
    return null; // no pool (or unreadable): creation continues without an avatar
  }
  if (names.length === 0) return null;
  let hash = 0;
  for (const ch of botId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const name = names[hash % names.length];
  try {
    return { bytes: readFileSync(join(dir, name)), mime: mimeFor(name)! };
  } catch {
    return null;
  }
}
