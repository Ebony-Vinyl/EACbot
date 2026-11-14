// Every cap that used to be a fixed number: untouched, config.json changes nothing; saved, it may raise the cap.
import { afterEach, describe, expect, it } from "vitest";

import { attachmentsMaxBytes, CLOUD_HOME_ATTACHMENTS_MAX_BYTES, DEFAULT_ATTACHMENTS_MAX_BYTES } from "./attachments.ts";
import { loadConfig, maxBotsPerWorkspace, parseConfigPatch, parseStoredConfig, saveConfig } from "./config.ts";
import { createImageDailyCap, IMAGE_DAILY_CAP } from "./image-daily-cap.ts";
import { quotaLimits, setQuotaLimits } from "./limits.ts";
import { maxMcpServers, MAX_MCP_SERVERS } from "./mcp-registry.ts";
import { DEFAULT_ROOM_POSTS_PER_TURN, roomPostLimits, roomPostsPerTurn } from "./room-post-budget.ts";
import type { JsonValue } from "./schema.ts";
import { chatToolLimitFor } from "./tool-count-limit.ts";

const CHAT_URL = "https://api.example.com/v1", CHAT_MODEL = "limits-test-model";
/** Only joined with the day file's name, so nothing is read or written by a cap check. */
const DATA_DIR = "limits-test-data";

afterEach(() => setQuotaLimits({}));

describe("quota limits", () => {
  it("keeps every old cap when config.json has no limits", () => {
    expect(quotaLimits()).toEqual({});
    expect(maxBotsPerWorkspace()).toBe(100);
    expect(maxMcpServers()).toBe(MAX_MCP_SERVERS);
    expect(MAX_MCP_SERVERS).toBe(20);
    expect(roomPostsPerTurn()).toBe(DEFAULT_ROOM_POSTS_PER_TURN);
    expect(DEFAULT_ROOM_POSTS_PER_TURN).toBe(3);
    expect(roomPostLimits()).toMatchObject({ senderMax: 10, escalateMax: 2, breakerCooldownMs: 5 * 60_000 });
    expect(chatToolLimitFor(CHAT_URL, CHAT_MODEL)).toBe(128);
    expect(createImageDailyCap(DATA_DIR).cap).toBe(IMAGE_DAILY_CAP);
    expect(IMAGE_DAILY_CAP).toBe(50);
    expect(attachmentsMaxBytes({}, undefined)).toBe(DEFAULT_ATTACHMENTS_MAX_BYTES);
    expect(DEFAULT_ATTACHMENTS_MAX_BYTES).toBe(512 * 1024 * 1024);
  });

  it("accepts a limits section and raises each cap", () => {
    const parsed = parseStoredConfig({ limits: {
      botsPerWorkspace: 250, botThreads: 64, attachmentsMaxBytes: 2 * 1024 ** 3, imagesPerDay: 120,
      chatToolsPerRequest: 256, mcpServers: 40, roomPostsPerTurn: 6, roomPostsPerMinute: 20,
      roomPostsWithoutReply: 4, roomBreakerMinutes: 15,
    } });
    expect(parsed.limits?.mcpServers).toBe(40);
    setQuotaLimits(parsed.limits);
    expect(maxBotsPerWorkspace(parsed)).toBe(250);
    expect(maxMcpServers()).toBe(40);
    expect(roomPostsPerTurn()).toBe(6);
    expect(roomPostLimits()).toMatchObject({ senderMax: 20, escalateMax: 4, breakerCooldownMs: 15 * 60_000 });
    expect(chatToolLimitFor(CHAT_URL, CHAT_MODEL)).toBe(256);
    expect(createImageDailyCap(DATA_DIR).cap).toBe(120);
    expect(attachmentsMaxBytes({}, quotaLimits().attachmentsMaxBytes)).toBe(2 * 1024 ** 3);
  });

  it("still lets an operator's environment variable outrank a saved attachment ceiling", () => {
    setQuotaLimits({ attachmentsMaxBytes: 2 * 1024 ** 3 });
    expect(attachmentsMaxBytes({ EAC_ATTACHMENTS_MAX_BYTES: String(4 * 1024 ** 3) })).toBe(4 * 1024 ** 3);
    expect(attachmentsMaxBytes({ EAC_CLOUD_ROLE: "home" })).toBe(2 * 1024 ** 3);
    setQuotaLimits({});
    expect(attachmentsMaxBytes({ EAC_CLOUD_ROLE: "home" })).toBe(CLOUD_HOME_ATTACHMENTS_MAX_BYTES);
  });

  it("applies a limits section saved through saveConfig as soon as it is loaded", () => {
    saveConfig({ limits: { mcpServers: 25, imagesPerDay: 80 } });
    expect(loadConfig().limits).toEqual({ mcpServers: 25, imagesPerDay: 80 });
    expect(maxMcpServers()).toBe(25);
    expect(createImageDailyCap(DATA_DIR).cap).toBe(80);
  });

  it("rejects a limits value that is not a positive whole number", () => {
    const invalid: Array<Record<string, JsonValue>> = [
      { botsPerWorkspace: 0 }, { botThreads: -1 }, { imagesPerDay: 1.5 }, { mcpServers: "20" },
      { chatToolsPerRequest: 0 }, { roomPostsPerTurn: 0 }, { roomBreakerMinutes: 0 }, { unknownCap: 5 },
      { attachmentsMaxBytes: 0 },
    ];
    for (const limits of invalid) {
      expect(() => parseConfigPatch({ limits })).toThrow("limits");
    }
    expect(parseConfigPatch({ limits: { roomPostsWithoutReply: 0 } }).limits).toEqual({ roomPostsWithoutReply: 0 });
  });
});
