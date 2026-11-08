import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ANNOUNCEMENTS_FILE, createAnnouncements } from "./announcements.ts";

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const input = { title: "Welcome", body: "Hello", level: "info" as const };

describe("createAnnouncements", () => {
  it("adds, lists, updates and removes, keeping the file in the data directory", () => {
    const at = mkdtempSync(join(tmpdir(), "eac-announcements-"));
    folders.push(at);
    const announcements = createAnnouncements(at, () => 1_000);
    const added = announcements.add(input);
    expect(added).toMatchObject({ title: "Welcome", body: "Hello", level: "info", source: "local", createdAt: 1_000, updatedAt: 1_000 });
    expect(announcements.list()).toHaveLength(1);
    expect(existsSync(join(at, ANNOUNCEMENTS_FILE))).toBe(true);

    const updated = announcements.update(added.id, { ...input, title: "Changed", level: "important", startsAt: 2_000, endsAt: 3_000 });
    expect(updated).toMatchObject({ title: "Changed", level: "important", startsAt: 2_000, endsAt: 3_000, createdAt: 1_000, updatedAt: 1_000 });
    expect(announcements.remove(added.id)).toBe(true);
    expect(announcements.remove(added.id)).toBe(false);
    expect(announcements.list()).toEqual([]);
    expect(() => announcements.update("missing", input)).toThrow(/no announcement/);
  });

  it("survives a restart and keeps an unknown file from taking over", () => {
    const at = mkdtempSync(join(tmpdir(), "eac-announcements-"));
    folders.push(at);
    const first = createAnnouncements(at);
    const added = first.add(input);
    expect(createAnnouncements(at).list()).toMatchObject([{ id: added.id, title: "Welcome" }]);

    const file = join(at, ANNOUNCEMENTS_FILE);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(stored.announcements[0])).not.toContain("source");
    expect(added.source).toBe("local");
  });
});
