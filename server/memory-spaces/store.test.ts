import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemorySpaceStore, MemorySpaceError } from "./store.ts";
import type { MemoryRequestPrincipal } from "../../shared/plugins/memory-spaces.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const owner: MemoryRequestPrincipal = { kind: "owner", personId: "person-owner" };
const guest: MemoryRequestPrincipal = { kind: "guest", personId: "person-guest" };

function makeStore(now = "2026-11-08T00:00:00.000Z") {
  const folder = mkdtempSync(join(tmpdir(), "eac-memory-space-"));
  folders.push(folder);
  return { folder, store: new MemorySpaceStore(folder, { now: () => now }) };
}

function sharedSpace(store: MemorySpaceStore) {
  return store.create({
    spaceId: "taste",
    name: "Taste",
    audience: "shared",
    members: [{ botId: "bot-a", access: "read-write" }, { botId: "bot-b", access: "read" }],
  });
}

describe("shared memory spaces", () => {
  it("writes with a revision, reads only as a member, and refuses read-only writers", () => {
    const { folder, store } = makeStore();
    const space = sharedSpace(store);
    const entry = store.writeEntry("taste", space.revision, {
      text: "prefers jazz in the morning",
      sensitivity: "normal",
      provenance: { botId: "bot-a", platform: "bilibili", conversationId: "dm-1" },
      principal: owner,
    });
    expect(entry).toMatchObject({ spaceId: "taste", revision: 2, epoch: 0 });
    expect(store.entries("taste", "bot-b", owner)).toMatchObject([{ text: "prefers jazz in the morning" }]);
    expect(() => store.writeEntry("taste", 2, {
      text: "read-only cannot write",
      sensitivity: "normal",
      provenance: { botId: "bot-b" },
      principal: owner,
    })).toThrow(/only read/);
    expect(new MemorySpaceStore(folder).get("taste")).toMatchObject({ revision: 2 });
  });

  it("never lets a guest read an owner-only space or a private entry", () => {
    const { store } = makeStore();
    store.create({ spaceId: "health", name: "Health", audience: "owner", members: [{ botId: "bot-a", access: "read-write" }] });
    expect(store.entries("health", "bot-a", guest)).toEqual([]);
    const shared = sharedSpace(store);
    store.writeEntry("taste", shared.revision, {
      text: "private note",
      sensitivity: "private",
      provenance: { botId: "bot-a" },
      principal: owner,
    });
    expect(store.entries("taste", "bot-a", guest)).toEqual([]);
    expect(store.entries("taste", "bot-a", owner)).toMatchObject([{ text: "private note" }]);
  });

  it("refuses a guest write even for a read-write membership", () => {
    const { store } = makeStore();
    const space = sharedSpace(store);
    expect(() => store.writeEntry("taste", space.revision, {
      text: "a group member tries to change the owner's taste",
      sensitivity: "normal",
      provenance: { botId: "bot-a", platform: "qq", conversationId: "group-1" },
      principal: guest,
    })).toThrow(/only the owner/);
  });

  it("rejects stale revisions instead of overwriting a concurrent change", () => {
    const { store } = makeStore();
    const space = sharedSpace(store);
    const first = store.writeEntry("taste", space.revision, {
      text: "one", sensitivity: "normal", provenance: { botId: "bot-a" }, principal: owner,
    });
    expect(first.revision).toBe(2);
    expect(() => store.writeEntry("taste", space.revision, {
      text: "two", sensitivity: "normal", provenance: { botId: "bot-a" }, principal: owner,
    })).toThrow(MemorySpaceError);
    expect(store.entries("taste", "bot-a", owner)).toHaveLength(1);
  });

  it("raises the epoch and blocks reads when a member is removed", () => {
    const { store } = makeStore();
    const space = sharedSpace(store);
    store.writeEntry("taste", space.revision, {
      text: "kept by the remaining member", sensitivity: "normal", provenance: { botId: "bot-a" }, principal: owner,
    });
    const updated = store.removeMember("taste", 2, "bot-b");
    expect(updated).toMatchObject({ revision: 3, epoch: 1 });
    expect(store.entries("taste", "bot-b", owner)).toEqual([]);
    expect(store.entries("taste", "bot-a", owner)).toMatchObject([{ text: "kept by the remaining member" }]);
  });

  it("hides a deleted entry from retrieval and keeps its tombstone", () => {
    const { store } = makeStore();
    const space = sharedSpace(store);
    const entry = store.writeEntry("taste", space.revision, {
      text: "forget this", sensitivity: "normal", provenance: { botId: "bot-a" }, principal: owner,
    });
    const deleted = store.deleteEntry("taste", 2, entry.entryId);
    expect(deleted.entry.deletedAt).toBeDefined();
    expect(store.entries("taste", "bot-a", owner)).toEqual([]);
    expect(() => store.writeEntry("taste", 2, {
      text: "stale", sensitivity: "normal", provenance: { botId: "bot-a" }, principal: owner,
    })).toThrow(/revision 3/);
  });

  it("exports only what the requesting bot may see", () => {
    const { store } = makeStore();
    const space = sharedSpace(store);
    store.writeEntry("taste", space.revision, {
      text: "shared fact", sensitivity: "normal", provenance: { botId: "bot-a" }, principal: owner,
    });
    const exported = store.exportSpace("taste", "bot-b", owner);
    expect(exported.entries.map((entry) => entry.text)).toEqual(["shared fact"]);
  });
});
