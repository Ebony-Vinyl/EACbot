import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PluginChannelError, PluginChannelStore } from "./channel-store.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const input = (sourceId = "community") => ({
  sourceId,
  name: "EAC Community",
  url: "https://plugins.example.com/catalog.json",
  keyId: "community-key",
  publicKeyPem: pem,
});

function store() {
  const folder = mkdtempSync(join(tmpdir(), "eac-plugin-channels-"));
  folders.push(folder);
  return { folder, channels: new PluginChannelStore(folder) };
}

describe("plugin channel store", () => {
  it("adds a community channel, persists its sequence and reloads it", () => {
    const { folder, channels } = store();
    expect(channels.add(input())).toMatchObject({ sourceId: "community", trust: "community", sequence: 0, enabled: true });
    channels.accepted("community", 4);
    expect(new PluginChannelStore(folder).get("community")).toMatchObject({ sequence: 4, lastFetchedAt: expect.any(String) });
  });

  it("refuses duplicate channels and malformed keys", () => {
    const { channels } = store();
    channels.add(input());
    expect(() => channels.add(input())).toThrow(/already exists/);
    expect(() => channels.add({ ...input("broken"), sourceId: "broken", publicKeyPem: "not a key" })).toThrow(/unreadable/);
    expect(() => channels.add({ ...input("http"), sourceId: "http", url: "http://example.com/catalog.json" })).toThrow(PluginChannelError);
  });

  it("seeds a default source only on a fresh data directory", () => {
    const { channels } = store();
    expect(channels.ensureDefault({ ...input("default"), trust: "reviewed" })).toMatchObject({ sourceId: "default", trust: "reviewed" });
    expect(channels.remove("default").sourceId).toBe("default");
    expect(channels.ensureDefault({ ...input("default"), trust: "reviewed" })).toBeNull();
  });

  it("records refresh errors, disables and removes a channel", () => {
    const { channels } = store();
    channels.add(input());
    expect(channels.failed("community", "network down")).toMatchObject({ lastError: "network down" });
    expect(channels.setEnabled("community", false).enabled).toBe(false);
    expect(channels.remove("community").sourceId).toBe("community");
    expect(channels.list()).toEqual([]);
  });
});
