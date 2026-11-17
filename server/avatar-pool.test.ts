import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUNDLED_AVATARS_DIR, avatarPoolDir, pickPoolAvatar } from "./avatar-pool.ts";
import { applyPoolAvatars, applyPoolAvatarsOnce, givePoolAvatar } from "./avatar-sweep.ts";
import type { BotRecord } from "./store.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "eac-avatar-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** A roster with the one method the sweep calls, recording what it was asked to write. */
function fakeStore(ids: string[], avatarUrl?: string) {
  const bots = ids.map((id) => ({ id, avatarUrl, avatarCrop: "circle" as const, resumeCursors: {} }) as unknown as BotRecord);
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  return {
    bots,
    patches,
    patchBot(id: string, patch: Record<string, unknown>) {
      const bot = bots.find((candidate) => candidate.id === id);
      if (!bot) return null;
      Object.assign(bot, patch);
      patches.push({ id, patch });
      return bot;
    },
  };
}

describe("the bundled pool", () => {
  it("ships faces with the app", () => {
    expect(avatarPoolDir(dataDir)).toBe(BUNDLED_AVATARS_DIR);
  });

  it("gives the same bot the same face every time", () => {
    const first = pickPoolAvatar(dataDir, "bot-stable");
    const second = pickPoolAvatar(dataDir, "bot-stable");
    expect(first?.bytes.equals(second!.bytes)).toBe(true);
  });

  it("spreads different bots across more than one face", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 40; index++) seen.add(pickPoolAvatar(dataDir, `bot-${index}`)?.bytes.toString("base64").slice(0, 24) ?? "");
    expect(seen.size).toBeGreaterThan(1);
  });

  it("lets the owner's own pool win once it holds pictures", () => {
    const own = join(dataDir, "avatar-pool");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "mine.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(avatarPoolDir(dataDir)).toBe(own);
    expect(pickPoolAvatar(dataDir, "any")?.mime).toBe("image/png");
  });

  it("ignores files that are not pictures", () => {
    const own = join(dataDir, "avatar-pool");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "notes.txt"), "not a picture");
    expect(avatarPoolDir(dataDir)).toBe(BUNDLED_AVATARS_DIR);
  });
});

describe("applyPoolAvatars", () => {
  it("replaces the face on every bot, including one that already had one", () => {
    const store = fakeStore(["a", "b", "c"], "/api/attachments/old.png");
    const result = applyPoolAvatars(store, dataDir);
    expect(result.changed).toBe(3);
    expect(result.failed).toBe(0);
    expect(store.bots.every((bot) => bot.avatarUrl !== "/api/attachments/old.png")).toBe(true);
    expect(store.bots.every((bot) => bot.avatarCrop === "circle")).toBe(true);
  });

  it("writes a stored attachment, not a pool filename", () => {
    const store = fakeStore(["a"]);
    applyPoolAvatars(store, dataDir);
    expect(store.bots[0]!.avatarUrl).toMatch(/^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|webp)$/);
  });

  it("gives one bot its face without touching the rest", () => {
    const store = fakeStore(["a", "b"]);
    expect(givePoolAvatar(store, dataDir, "a")).toBe(true);
    expect(store.bots[0]!.avatarUrl).toBeTruthy();
    expect(store.bots[1]!.avatarUrl).toBeUndefined();
  });
});

describe("applyPoolAvatarsOnce", () => {
  it("runs once and leaves a marker", () => {
    const store = fakeStore(["a"]);
    expect(applyPoolAvatarsOnce(store, dataDir)?.changed).toBe(1);
    expect(readFileSync(join(dataDir, "avatar-pool-applied"), "utf8")).toContain("pool");
  });

  it("does nothing on a later boot, so a face chosen by hand survives a restart", () => {
    const first = fakeStore(["a"]);
    applyPoolAvatarsOnce(first, dataDir);
    const chosen = "/api/attachments/chosen-by-hand.webp";
    first.patchBot("a", { avatarUrl: chosen });
    const later = fakeStore(["a"]);
    later.bots[0]!.avatarUrl = chosen;
    expect(applyPoolAvatarsOnce(later, dataDir)).toBeNull();
    expect(later.bots[0]!.avatarUrl).toBe(chosen);
    expect(later.patches).toHaveLength(0);
  });
});
