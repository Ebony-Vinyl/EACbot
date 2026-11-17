import { describe, expect, it } from "vitest";

import { defaultSentinelOut, isInside } from "./paths.ts";

describe("sentinel paths", () => {
  it("keeps Sentinel's files in the platform's state folder, outside the data dir", () => {
    expect(defaultSentinelOut("/Users/eacbot/.eacbot", "darwin", "/Users/eacbot", {})).toBe("/Users/eacbot/Library/Application Support/eacbot-sentinel");
    expect(defaultSentinelOut("/home/eacbot/.eacbot", "linux", "/home/eacbot", {})).toBe("/home/eacbot/.local/state/eacbot-sentinel");
    expect(defaultSentinelOut("/home/eacbot/.eacbot", "linux", "/home/eacbot", { XDG_STATE_HOME: "/var/state/eacbot" })).toBe("/var/state/eacbot/eacbot-sentinel");
    // a relative XDG_STATE_HOME is invalid by the spec and ignored
    expect(defaultSentinelOut("/home/eacbot/.eacbot", "linux", "/home/eacbot", { XDG_STATE_HOME: "state" })).toBe("/home/eacbot/.local/state/eacbot-sentinel");
    expect(defaultSentinelOut("C:\\Users\\eacbot\\.eacbot", "win32", "C:\\Users\\eacbot", { LOCALAPPDATA: "D:\\Local" })).toBe("D:\\Local\\eacbot-sentinel");
  });

  it("gives any other data dir its own subfolder, the same one every time", () => {
    const other = defaultSentinelOut("/srv/omb-data", "linux", "/home/eacbot", {});
    expect(other).toMatch(/^\/home\/eacbot\/\.local\/state\/eacbot-sentinel\/data-[0-9a-f]{12}$/);
    expect(defaultSentinelOut("/srv/omb-data", "linux", "/home/eacbot", {})).toBe(other);
    expect(defaultSentinelOut("/srv/omb-data-2", "linux", "/home/eacbot", {})).not.toBe(other);
  });

  it("knows when a folder is inside another", () => {
    expect(isInside("/d/omb/sentinel", "/d/omb", "linux")).toBe(true);
    expect(isInside("/d/omb", "/d/omb", "linux")).toBe(true);
    expect(isInside("/d/omb-sentinel", "/d/omb", "linux")).toBe(false);
    expect(isInside("/d", "/d/omb", "linux")).toBe(false);
    expect(isInside("C:\\d\\omb\\x", "C:\\d\\omb", "win32")).toBe(true);
  });
});
