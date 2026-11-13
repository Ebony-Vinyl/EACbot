import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemorySpaceStore } from "../memory-spaces/store.ts";
import { PlatformAccountStore } from "../plugins/platform-accounts.ts";
import { createMemoryContext, memoryReplayStart, memoryThreadReadable, mayRetainPrivateMemory, turnPluginIdentity, type PlatformTurnContext } from "./memory-context.ts";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function setup() {
  const folder = mkdtempSync(join(tmpdir(), "eac-memory-context-"));
  folders.push(folder);
  const memory = new MemorySpaceStore(folder);
  const accounts = new PlatformAccountStore(folder);
  const account = accounts.addAccount({ platform: "qq", externalAccountId: "self", displayName: "QQ" });
  accounts.upsertIdentity(account.accountId, { externalPersonId: "123", personId: "owner", role: "owner" });
  for (const audience of ["owner", "shared"] as const) {
    const spaceId = `${audience}-notes`;
    memory.create({ spaceId, name: audience, audience, members: [{ botId: "bot-a", access: "read-write" }, { botId: "bot-b", access: "read" }] });
    memory.writeEntry(spaceId, 1, { text: `${audience} fact`, sensitivity: "normal", provenance: { botId: "bot-a" }, principal: { kind: "owner", personId: "owner" } });
  }
  memory.writeEntry("shared-notes", 2, { text: "private medical fact", sensitivity: "private", provenance: { botId: "bot-a" }, principal: { kind: "owner", personId: "owner" } });
  const platform: PlatformTurnContext = { platform: "qq", accountId: account.accountId, conversation: { id: "group-1", kind: "group" }, sender: { id: "123" } };
  return { memory, accounts, account, platform, contexts: createMemoryContext({ memory, accounts }) };
}

describe("turn memory context", () => {
  it("uses the authenticated cloud principal and scopes confined plugin calls to their thread", () => {
    const { memory, accounts } = setup();
    const contexts = createMemoryContext({ memory, accounts, principalFor: () => ({ kind: "guest", personId: "cloud-guest" }) });
    expect(contexts.snapshot("bot-a").entries.map((entry) => entry.text)).toEqual(["shared fact"]);
    expect(turnPluginIdentity(contexts, "bot-a", "guest-thread", undefined, true)).toEqual({
      principalId: "cloud-guest", audienceId: "thread:guest-thread", autoGrant: false,
    });
  });
  it("uses the audience to filter even an owner's group message", () => {
    const { contexts, platform } = setup();
    const group = contexts.snapshot("bot-a", platform);
    expect(group.principal.kind).toBe("owner");
    expect(group.privateMemory).toBe(false);
    expect(group.entries.map((entry) => entry.text)).toEqual(["shared fact"]);
    expect(group.prompt).not.toContain("private medical fact");
    expect(contexts.snapshot("bot-c", platform).entries).toEqual([]);
    const direct = contexts.snapshot("bot-a", { ...platform, conversation: { id: "123", kind: "direct" } });
    expect(direct.privateMemory).toBe(true);
    expect(direct.entries).toHaveLength(3);
  });

  it("re-resolves identity, denies a guest's private notes and refuses a paused account", () => {
    const { contexts, accounts, platform, account } = setup();
    const direct = { ...platform, conversation: { id: "123", kind: "direct" as const } };
    const owner = contexts.snapshot("bot-a", direct);
    accounts.removeIdentity(account.accountId, "123");
    const guest = contexts.snapshot("bot-a", direct);
    expect(guest.principal.kind).toBe("guest");
    expect(guest.fingerprint).not.toBe(owner.fingerprint);
    expect(guest.entries.map((entry) => entry.text)).toEqual(["shared fact"]);
    accounts.setStatus(account.accountId, "unavailable");
    expect(() => contexts.snapshot("bot-a", direct)).toThrow(/paused/);
  });

  it("changes the replay boundary on revocation and deletion, preserving it for additions", () => {
    const { memory, contexts } = setup();
    const original = contexts.snapshot("bot-b");
    const saved = memoryReplayStart(undefined, original, "m1");
    memory.writeEntry("shared-notes", 3, { text: "new fact", sensitivity: "normal", provenance: { botId: "bot-a" }, principal: { kind: "owner", personId: "owner" } });
    expect(memoryReplayStart(saved, contexts.snapshot("bot-b"), "m2")).toEqual(saved);
    const entry = memory.entries("shared-notes", "bot-a", { kind: "owner", personId: "owner" })[0]!;
    memory.deleteEntry("shared-notes", 4, entry.entryId);
    expect(memoryThreadReadable(contexts, "bot-b", "thread-b", { memoryContext: saved }, true)).toBe(false);
    const deleted = contexts.snapshot("bot-b");
    expect(memoryReplayStart(saved, deleted, "m3").startMessageId).toBe("m3");
    memory.removeMember("shared-notes", 5, "bot-b");
    expect(contexts.snapshot("bot-b").prompt).not.toContain("shared-notes");
    expect(contexts.snapshot("bot-b").fingerprint).not.toBe(deleted.fingerprint);
  });

  it("keeps shared context from being copied into private derived memory", () => {
    const { contexts } = setup();
    const store = { botByThread: () => ({ id: "bot-a" }), taskByThread: () => ({}) } as unknown as Parameters<typeof mayRetainPrivateMemory>[1];
    expect(mayRetainPrivateMemory(contexts, store, "thread-a")).toBe(false);
  });

  it("notifies the host after persistence and stops after unsubscribe", () => {
    const { memory } = setup();
    let notifications = 0;
    let observedEpoch = 0;
    const unsubscribe = memory.subscribe(() => { notifications++; observedEpoch = memory.get("shared-notes")!.epoch; });
    memory.revoke("shared-notes", 3);
    unsubscribe();
    memory.revoke("shared-notes", 4);
    expect(notifications).toBe(1);
    expect(observedEpoch).toBe(1);
  });
});
