import { describe, expect, it, vi } from "vitest";

import { HostUnsupportedError, createHostAdapter } from "./host-adapter.ts";

describe("host adapter", () => {
  it("reports every native feature as unsupported in a plain browser", () => {
    const adapter = createHostAdapter({});
    expect(adapter.kind).toBe("web");
    expect(adapter.capability("tray")).toMatchObject({ state: "unsupported" });
    expect(adapter.capability("openExternal")).toMatchObject({ state: "unsupported" });
  });

  it("uses the Electron bridge only for functions it actually exposes", async () => {
    const openExternal = vi.fn(async () => true);
    const adapter = createHostAdapter({ ogb: { openExternal } });
    expect(adapter.kind).toBe("electron");
    expect(adapter.capability("chooseFolder")).toMatchObject({ state: "unsupported" });
    await expect(adapter.openExternal("https://example.com/a")).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/a");
    await expect(adapter.chooseFolder()).rejects.toBeInstanceOf(HostUnsupportedError);
  });

  it("trusts a Tauri host declaration and refuses undeclared commands", async () => {
    const invoke = vi.fn(async (command: string) => command === "open_external" ? true : null);
    const adapter = createHostAdapter({
      __EAC_HOST__: {
        apiVersion: 1,
        kind: "tauri",
        features: { openExternal: "available", tray: "available", secureStorage: "available" },
        commands: { secureStorage: ["secret_get"] },
        invoke,
      },
    });
    expect(adapter.kind).toBe("tauri");
    expect(adapter.capability("tray")).toMatchObject({ state: "available" });
    expect(adapter.capability("microphone")).toMatchObject({ state: "unsupported" });
    await expect(adapter.openExternal("https://example.com")).resolves.toBe(true);
    await expect(adapter.invoke("secureStorage", "secret_get", { key: "x" })).resolves.toBeNull();
    await expect(adapter.invoke("secureStorage", "secret_delete_all")).rejects.toBeInstanceOf(HostUnsupportedError);
  });

  it("refuses a non-http external link before calling the host", async () => {
    const openExternal = vi.fn(async () => true);
    const adapter = createHostAdapter({ ogb: { openExternal } });
    await expect(adapter.openExternal("file:///etc/passwd")).rejects.toThrow(/http/);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
