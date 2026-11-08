import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PlatformAccountStore } from "../plugins/platform-accounts.ts";
import { MemorySpaceStore } from "../memory-spaces/store.ts";
import { createPlatformRoutes, type PlatformRouteBots } from "./platforms.ts";
import { dispatchRoutes } from "./table.ts";

const owner = { kind: "session", session: { id: "s1" }, via: "bearer", scopes: ["admin", "client"] } as unknown as RequestAuth;
const client = { ...owner, scopes: ["client"] } as unknown as RequestAuth;
const folders: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function serve() {
  const folder = mkdtempSync(join(tmpdir(), "eac-platform-routes-"));
  folders.push(folder);
  const accounts = new PlatformAccountStore(folder);
  const memory = new MemorySpaceStore(folder);
  const bots = new Map<string, string>();
  const existingBots = new Set(["bot-a", "bot-b"]);
  let next = 0;
  const fake: PlatformRouteBots = {
    has: (id) => existingBots.has(id),
    bindingOf: (id) => {
      const accountId = bots.get(id);
      return accountId ? { accountId } : null;
    },
    createDedicated: (input) => {
      const id = `bot_${++next}`;
      existingBots.add(id);
      bots.set(id, input.accountId);
      return id;
    },
    bind: (id, binding) => {
      if (!existingBots.has(id)) return false;
      if (binding) bots.set(id, binding.accountId);
      else bots.delete(id);
      return true;
    },
    remove: (id) => existingBots.delete(id) && bots.delete(id),
  };
  bots.set("bot-a", "");
  bots.set("bot-b", "");
  const route = createPlatformRoutes({ accounts, memory, bots: fake, mayManage: (auth) => auth.kind === "loopback" || auth.scopes.includes("admin") });
  let auth = owner;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "next route" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, accounts, memory, bots, setAuth: (next: RequestAuth) => { auth = next; } };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("/api/platforms and /api/memory-spaces", () => {
  it("is owner/admin only", async () => {
    const { base, setAuth } = await serve();
    setAuth(client);
    expect((await call(base, "GET", "/api/platforms/accounts")).status).toBe(403);
    expect((await call(base, "GET", "/api/memory-spaces")).status).toBe(403);
  });

  it("connects an account, creates a dedicated bot and routes an event", async () => {
    const { base, bots } = await serve();
    const created = await call(base, "POST", "/api/platforms/accounts", {
      platform: "qq", externalAccountId: "10001", displayName: "Daily QQ", capabilities: ["messages"],
    });
    expect(created.status).toBe(200);
    const account = created.body.account as { accountId: string };
    const bound = await call(base, "POST", `/api/platforms/accounts/${account.accountId}/bind`, {
      mode: "dedicated", name: "QQ Helper",
    });
    expect(bound.status).toBe(200);
    expect(bound.body).toMatchObject({ created: true, botId: "bot_1" });
    expect(bots.get("bot_1")).toBe(account.accountId);

    const identified = await call(base, "POST", `/api/platforms/accounts/${account.accountId}/identities`, {
      externalPersonId: "member-7", personId: "person-owner", role: "owner",
    });
    expect(identified.status).toBe(200);
    const event = {
      eventId: "evt-1", platform: "qq", accountId: account.accountId,
      conversation: { id: "group-1", kind: "group" }, sender: { id: "member-7" },
      receivedAt: "2026-11-08T00:00:00.000Z", text: "hi",
    };
    const routed = await call(base, "POST", "/api/platforms/inbound", event);
    expect(routed.status).toBe(200);
    expect(routed.body.route).toMatchObject({ action: "delivered", botId: "bot_1", known: true });
    expect((await call(base, "POST", "/api/platforms/inbound", event)).body.route).toMatchObject({ action: "ignored", reason: "duplicate" });
  });

  it("binds an existing bot and refuses a bot that already answers another account", async () => {
    const { base } = await serve();
    const first = await call(base, "POST", "/api/platforms/accounts", { platform: "qq", externalAccountId: "1", displayName: "One" });
    const second = await call(base, "POST", "/api/platforms/accounts", { platform: "bilibili", externalAccountId: "2", displayName: "Two" });
    expect((await call(base, "POST", `/api/platforms/accounts/${(first.body.account as { accountId: string }).accountId}/bind`, { mode: "existing", botId: "bot-a" })).status).toBe(200);
    expect((await call(base, "POST", `/api/platforms/accounts/${(second.body.account as { accountId: string }).accountId}/bind`, { mode: "existing", botId: "bot-a" })).status).toBe(409);
  });

  it("unbinds without deleting the bot", async () => {
    const { base, bots } = await serve();
    const created = await call(base, "POST", "/api/platforms/accounts", { platform: "qq", externalAccountId: "1", displayName: "One" });
    const accountId = (created.body.account as { accountId: string }).accountId;
    await call(base, "POST", `/api/platforms/accounts/${accountId}/bind`, { mode: "dedicated" });
    expect((await call(base, "DELETE", `/api/platforms/accounts/${accountId}/bind`)).status).toBe(200);
    expect(bots.has("bot_1")).toBe(false);
    expect((await call(base, "GET", "/api/platforms/accounts")).body.accounts).toHaveLength(1);
  });

  it("creates a shared space, writes as the owner and filters a guest read", async () => {
    const { base } = await serve();
    const created = await call(base, "POST", "/api/memory-spaces", {
      spaceId: "taste", name: "Taste", audience: "shared",
      members: [{ botId: "bot-a", access: "read-write" }, { botId: "bot-b", access: "read" }],
    });
    expect(created.status).toBe(200);
    const space = created.body.space as { revision: number };
    const written = await call(base, "POST", "/api/memory-spaces/taste/entries", {
      revision: space.revision, botId: "bot-a", text: "likes jazz", sensitivity: "normal",
      provenance: { platform: "bilibili", conversationId: "dm-1" },
    });
    expect(written.status).toBe(200);
    expect((await call(base, "GET", "/api/memory-spaces/taste?botId=bot-b&principal=guest&personId=person-guest")).body.entries)
      .toMatchObject([{ text: "likes jazz" }]);
    const privateEntry = await call(base, "POST", "/api/memory-spaces/taste/entries", {
      revision: 2, botId: "bot-a", text: "private", sensitivity: "private",
    });
    expect(privateEntry.status).toBe(200);
    expect((await call(base, "GET", "/api/memory-spaces/taste?botId=bot-a&principal=guest&personId=person-guest")).body.entries)
      .toMatchObject([{ text: "likes jazz" }]);
    expect((await call(base, "GET", "/api/memory-spaces/taste?botId=bot-a&principal=owner&personId=person-owner")).body.entries)
      .toHaveLength(2);
  });

  it("rejects a stale revision and a non-member", async () => {
    const { base } = await serve();
    await call(base, "POST", "/api/memory-spaces", {
      spaceId: "taste", name: "Taste", audience: "shared", members: [{ botId: "bot-a", access: "read-write" }],
    });
    expect((await call(base, "POST", "/api/memory-spaces/taste/entries", { revision: 99, botId: "bot-a", text: "x", sensitivity: "normal" })).status).toBe(409);
    expect((await call(base, "POST", "/api/memory-spaces/taste/entries", { revision: 1, botId: "bot-b", text: "x", sensitivity: "normal" })).status).toBe(403);
  });

  it("leaves other API paths to the next route", async () => {
    const { base } = await serve();
    expect(await (await fetch(`${base}/api/not-platforms`)).json()).toEqual({ from: "next route" });
  });
});
