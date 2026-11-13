import { afterEach, expect, it, vi } from "vitest";

import { choosePluginUi, panelsInSlot, pluginUiChoice } from "./plugin-slots";

afterEach(() => vi.unstubAllGlobals());

it("restores layout choices and keeps panels in their registered slot", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  choosePluginUi("layout", "eac.test:workspace");
  expect(pluginUiChoice("layout")).toBe("eac.test:workspace");
  choosePluginUi("layout", null);
  expect(pluginUiChoice("layout")).toBeNull();
  expect(dispatchEvent).toHaveBeenCalledTimes(2);
  const panels = (["workspace", "bot"] as const).map((slot) => ({
    key: slot, title: slot, spec: { schemaVersion: 1 as const, title: slot, slot, items: [{ type: "text" as const, text: slot }] },
  }));
  expect(panelsInSlot(panels, "bot").map((panel) => panel.key)).toEqual(["bot"]);
});
