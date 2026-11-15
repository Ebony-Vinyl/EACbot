// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { choiceOf, currentTheme, modeOf, readThemeChoice, setThemeChoice, skinFor, THEME_CHOICES } from "./theme.ts";
import { readSkinChoice } from "@/lib/skins";

describe("the workbench theme", () => {
  it("offers exactly system, light and dark", () => {
    expect(THEME_CHOICES).toEqual(["system", "light", "dark"]);
  });

  it("reads a light skin as light and a dark skin as dark", () => {
    expect(modeOf("daylight")).toBe("light");
    expect(modeOf("meadow")).toBe("light");
    expect(modeOf("midnight")).toBe("dark");
    expect(modeOf("foundry")).toBe("dark");
  });

  it("writes the app's own skin, so the two can never disagree", () => {
    localStorage.clear();
    setThemeChoice("dark");
    expect(readSkinChoice()).toBe(skinFor("dark"));
    expect(currentTheme()).toBe("dark");
    expect(readThemeChoice()).toBe("dark");

    setThemeChoice("light");
    expect(readSkinChoice()).toBe(skinFor("light"));
    expect(currentTheme()).toBe("light");
  });

  it("hands the decision back to the system without pinning a skin", () => {
    localStorage.clear();
    setThemeChoice("system");
    expect(readSkinChoice()).toBe("system");
    expect(readThemeChoice()).toBe("system");
  });

  it("shows a pinned skin as the mode it paints", () => {
    expect(choiceOf("meadow")).toBe("light");
    expect(choiceOf("halloween")).toBe("dark");
    expect(choiceOf("system")).toBe("system");
  });
});
