import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";

import { MemorySpaceStore } from "../memory-spaces/store.ts";
import { PlatformAccountStore } from "../plugins/platform-accounts.ts";
import { createMemoryContext, type PlatformTurnContext } from "../host/memory-context.ts";
import { writeSharedMemory } from "./shared-memory.ts";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

it("allows an identified owner to write a shared space from a group and refuses a guest or stale revision", () => {
  const folder = mkdtempSync(join(tmpdir(), "eac-shared-memory-route-"));
  folders.push(folder);
  const memory = new MemorySpaceStore(folder);
  const accounts = new PlatformAccountStore(folder);
  const account = accounts.addAccount({ platform: "qq", externalAccountId: "999", displayName: "QQ" });
  accounts.upsertIdentity(account.accountId, { externalPersonId: "123", personId: "owner", role: "owner" });
  memory.create({ spaceId: "taste", name: "Taste", audience: "shared", members: [{ botId: "bot-a", access: "read-write" }] });
  const platform: PlatformTurnContext = { platform: "qq", accountId: account.accountId, conversation: { kind: "group", id: "456" }, sender: { id: "123" } };
  const contexts = createMemoryContext({ memory, accounts });
  let status = 0;
  const context = { res: {} as ServerResponse, json: (_res: ServerResponse, code: number) => { status = code; } };
  const write = (body: Record<string, unknown>) => writeSharedMemory(body, context, { memory, snapshot: contexts.snapshot("bot-a", platform), platform, botId: "bot-a", enabled: true });
  write({ spaceId: "taste", expectedRevision: 1, action: "append", text: "likes jazz" });
  expect(status).toBe(200);
  expect(memory.entries("taste", "bot-a", { kind: "owner", personId: "owner" })[0]!.provenance.conversationId).toBe("456");
  write({ spaceId: "taste", expectedRevision: 1, action: "append", text: "stale" });
  expect(status).toBe(409);
  accounts.removeIdentity(account.accountId, "123");
  write({ spaceId: "taste", expectedRevision: 2, action: "append", text: "guest" });
  expect(status).toBe(403);
});
