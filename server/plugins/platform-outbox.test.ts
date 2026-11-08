import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PlatformOutboxError, PlatformOutboxStore } from "./platform-outbox.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function store(): PlatformOutboxStore {
  const folder = mkdtempSync(join(tmpdir(), "eac-platform-outbox-"));
  folders.push(folder);
  return new PlatformOutboxStore(folder);
}

const reply = (patch: Partial<Parameters<PlatformOutboxStore["append"]>[0]> = {}) => ({
  accountId: "0f8a2d1e-1c3b-4a5f-8e6d-7a9b0c1d2e3f",
  conversationId: "conv-1",
  conversationKind: "direct" as const,
  text: "回复",
  threadId: "th_1",
  ...patch,
});

describe("platform outbox", () => {
  it("appends a reply, lists what came after the id a bridge last took, and ack removes exactly what it took", () => {
    const outbox = store();
    const first = outbox.append(reply());
    const second = outbox.append(reply({ conversationId: "conv-2" }));
    expect(outbox.list(first.accountId)).toHaveLength(2);
    expect(outbox.list(first.accountId, first.id)).toEqual([second]);

    expect(outbox.ack(first.accountId, [first.id])).toBe(1);
    expect(outbox.list(first.accountId)).toEqual([second]);
    // A repeated ack is a no-op, not an error: bridges retry.
    expect(outbox.ack(first.accountId, [first.id])).toBe(0);
    // Another account's message is never touched by this account's ack.
    const other = outbox.append(reply({ accountId: "1f8a2d1e-1c3b-4a5f-8e6d-7a9b0c1d2e3f" }));
    expect(outbox.ack(first.accountId, [other.id])).toBe(0);
    expect(outbox.list(other.accountId)).toHaveLength(1);
  });

  it("returns the same record for a repeated idempotency key instead of a second entry", () => {
    const outbox = store();
    const one = outbox.append(reply({ idempotencyKey: "evt-1" }));
    const again = outbox.append(reply({ idempotencyKey: "evt-1", text: "另一条" }));
    expect(again.id).toBe(one.id);
    expect(again.text).toBe(one.text);
    expect(outbox.list(one.accountId)).toHaveLength(1);
  });

  it("keeps the list per account even when conversation ids repeat", () => {
    const outbox = store();
    outbox.append(reply());
    const other = outbox.append(reply({ accountId: "1f8a2d1e-1c3b-4a5f-8e6d-7a9b0c1d2e3f" }));
    expect(outbox.list("0f8a2d1e-1c3b-4a5f-8e6d-7a9b0c1d2e3f").map((message) => message.id)).not.toContain(other.id);
  });

  it("persists across a new store reading the same data directory", () => {
    const folder = mkdtempSync(join(tmpdir(), "eac-platform-outbox-persist-"));
    folders.push(folder);
    const first = new PlatformOutboxStore(folder);
    const message = first.append(reply({ idempotencyKey: "evt-persist" }));
    const reopened = new PlatformOutboxStore(folder);
    expect(reopened.list(message.accountId)).toHaveLength(1);
    expect(reopened.get(message.id)?.text).toBe("回复");
  });

  it("refuses to grow past its cap instead of writing a file the next read would reject", () => {
    const outbox = store();
    const accountId = reply().accountId;
    for (let index = 0; index < 500; index += 1) {
      outbox.append(reply({ conversationId: `conv-${index}`, idempotencyKey: `msg-${index}` }));
    }
    expect(() => outbox.append(reply({ conversationId: "conv-overflow" }))).toThrow(PlatformOutboxError);
    expect(outbox.list(accountId)).toHaveLength(500);
    expect(outbox.ack(accountId, ["msg-1"])).toBe(1);
    expect(outbox.append(reply({ conversationId: "conv-overflow" })).conversationId).toBe("conv-overflow");
  });
});
