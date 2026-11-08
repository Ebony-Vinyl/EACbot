import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PlatformAccountStore, PlatformAccountError } from "./platform-accounts.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function makeStore(now = "2026-11-08T00:00:00.000Z") {
  const folder = mkdtempSync(join(tmpdir(), "eac-platform-"));
  folders.push(folder);
  return { folder, store: new PlatformAccountStore(folder, { now: () => now }) };
}

function account(store: PlatformAccountStore) {
  return store.addAccount({ platform: "qq", externalAccountId: "bot-10001", displayName: "Daily QQ" });
}

function event(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId: "evt-1",
    platform: "qq",
    accountId,
    conversation: { id: "group-42", kind: "group" },
    sender: { id: "member-7", name: "seven" },
    receivedAt: "2026-11-08T00:00:01.000Z",
    text: "hello",
    ...overrides,
  };
}

describe("platform accounts and inbound routing", () => {
  it("persists accounts and refuses the same platform identity twice", () => {
    const { folder, store } = makeStore();
    const added = account(store);
    expect(added).toMatchObject({ platform: "qq", externalAccountId: "bot-10001", status: "connected" });
    expect(() => store.addAccount({ platform: "qq", externalAccountId: "bot-10001", displayName: "Again" }))
      .toThrow(PlatformAccountError);
    expect(new PlatformAccountStore(folder).listAccounts()).toMatchObject([{ accountId: added.accountId }]);
  });

  it("routes one event to one bot and consumes duplicates", () => {
    const { store } = makeStore();
    const qq = account(store);
    store.bind(qq.accountId, "bot-a", "existing");
    const first = store.resolveInbound(event(qq.accountId));
    expect(first).toMatchObject({ action: "delivered", botId: "bot-a", known: false });
    if (first.action === "delivered") {
      expect(first.principal).toMatchObject({ kind: "guest", personId: expect.stringContaining("guest") });
      expect(first.audienceId).toBe(`platform:qq:${qq.accountId}:group:group-42`);
    }
    expect(store.resolveInbound(event(qq.accountId))).toMatchObject({ action: "ignored", reason: "duplicate" });
  });

  it("maps the account owner from the host identity table, not from message content", () => {
    const { store } = makeStore();
    const qq = account(store);
    store.bind(qq.accountId, "bot-a", "dedicated");
    store.upsertIdentity(qq.accountId, { externalPersonId: "member-7", personId: "person-owner", role: "owner" });
    const routed = store.resolveInbound(event(qq.accountId));
    expect(routed).toMatchObject({ action: "delivered", known: true });
    if (routed.action === "delivered") expect(routed.principal).toMatchObject({ kind: "owner", personId: "person-owner" });
    expect(() => store.resolveInbound(event(qq.accountId, { eventId: "spoof", sender: { id: "member-8", role: "owner" } })))
      .toThrow(PlatformAccountError);
  });

  it("ignores echoes and paused accounts before any dispatch", () => {
    const { store } = makeStore();
    const qq = account(store);
    store.bind(qq.accountId, "bot-a", "existing");
    expect(store.resolveInbound(event(qq.accountId, { eventId: "echo-1", sender: { id: "bot-10001" } })))
      .toMatchObject({ action: "ignored", reason: "echo" });
    store.setStatus(qq.accountId, "expired");
    expect(store.resolveInbound(event(qq.accountId, { eventId: "paused-1" })))
      .toMatchObject({ action: "ignored", reason: "account-not-connected" });
    store.setStatus(qq.accountId, "connected");
    expect(store.resolveInbound(event(qq.accountId, { eventId: "after-1" }))).toMatchObject({ action: "delivered" });
  });

  it("uses a conversation override while other conversations keep the default bot", () => {
    const { store } = makeStore();
    const qq = account(store);
    store.bind(qq.accountId, "bot-a", "existing");
    store.setConversationRoute(qq.accountId, "group-42", "bot-b");
    expect(store.resolveInbound(event(qq.accountId, { eventId: "one" }))).toMatchObject({ action: "delivered", botId: "bot-b", overridden: true });
    expect(store.resolveInbound(event(qq.accountId, { eventId: "two", conversation: { id: "group-9", kind: "group" } })))
      .toMatchObject({ action: "delivered", botId: "bot-a", overridden: false });
  });

  it("reports unbound accounts and rejects a second binding", () => {
    const { store } = makeStore();
    const qq = account(store);
    expect(store.resolveInbound(event(qq.accountId))).toMatchObject({ action: "unbound" });
    store.bind(qq.accountId, "bot-a", "existing");
    expect(() => store.bind(qq.accountId, "bot-b", "existing")).toThrow(/already has a bot/);
    expect(store.unbind(qq.accountId)).toMatchObject({ botId: "bot-a" });
    expect(store.resolveInbound(event(qq.accountId, { eventId: "later" }))).toMatchObject({ action: "unbound" });
  });

  it("removes identities, bindings and routes with the account", () => {
    const { store } = makeStore();
    const qq = account(store);
    store.upsertIdentity(qq.accountId, { externalPersonId: "member-7", personId: "person-owner", role: "owner" });
    store.bind(qq.accountId, "bot-a", "existing");
    store.setConversationRoute(qq.accountId, "group-42", "bot-b");
    store.removeAccount(qq.accountId);
    expect(store.listAccounts()).toEqual([]);
    expect(store.identities(qq.accountId)).toEqual([]);
    expect(store.binding(qq.accountId)).toBeNull();
  });

  it("refuses an invalid event before touching routing state", () => {
    const { store } = makeStore();
    expect(() => store.resolveInbound({ eventId: "x" })).toThrow(PlatformAccountError);
    expect(() => store.setConversationRoute("missing", "c", "bot-a")).toThrow(/no such platform account/);
  });
});
