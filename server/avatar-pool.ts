import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The faces the app ships with, so a fresh install has a pool before anyone adds their own. */
export const BUNDLED_AVATARS_DIR = fileURLToPath(new URL("./avatars", import.meta.url));

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

function picturesIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => Boolean(mimeFor(name))).sort();
  } catch {
    return [];
  }
}

/** The owner's own pool when it holds a picture, else the bundled one. */
export function avatarPoolDir(dataDir: string): string {
  const own = join(dataDir, "avatar-pool");
  return picturesIn(own).length > 0 ? own : BUNDLED_AVATARS_DIR;
}

/** A fresh avatar for a new bot: an image from the pool, picked by a stable hash of the bot id so new bots spread
 * across the pool. The owner's own pool wins once it holds pictures; otherwise the bundled faces are used. */
export function pickPoolAvatar(dataDir: string, botId: string): { bytes: Buffer; mime: string } | null {
  const dir = avatarPoolDir(dataDir);
  const names = picturesIn(dir);
  if (names.length === 0) return null; // no pool (or unreadable): creation continues without an avatar
  let hash = 0;
  for (const ch of botId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const name = names[hash % names.length];
  try {
    return { bytes: readFileSync(join(dir, name)), mime: mimeFor(name)! };
  } catch {
    return null;
  }
}
