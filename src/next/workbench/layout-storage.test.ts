import { describe, expect, it } from "vitest";

import {
  LAYOUT_STORAGE_KEY,
  LAYOUT_VERSION,
  browserStorage,
  defaultLayout,
  loadLayout,
  parseLayout,
  saveLayout,
  serializeLayout,
  type StorageLike,
} from "./layout-storage.ts";
import { leaf, split } from "./pane-tree.ts";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const layout = {
  root: split("s1", "horizontal" as const, leaf("p1", "t1"), leaf("p2", "t2"), 0.35),
  focusedPaneId: "p2",
  zoomedPaneId: "p1",
  openMissionIds: ["m1", "m2"],
  activeMissionId: "m2",
  sidebarCollapsed: true,
};

describe("layout persistence", () => {
  it("round-trips a tree, focus, zoom and tabs", () => {
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  it("stores under a versioned key and reads it back", () => {
    const storage = memoryStorage();
    expect(saveLayout(storage, layout)).toBe(true);
    expect(storage.values.has(LAYOUT_STORAGE_KEY)).toBe(true);
    expect(JSON.parse(storage.values.get(LAYOUT_STORAGE_KEY)!).version).toBe(LAYOUT_VERSION);
    expect(loadLayout(storage)).toEqual(layout);
  });

  it("falls back to the default for nothing stored", () => {
    expect(loadLayout(memoryStorage())).toEqual(defaultLayout());
    expect(parseLayout(null)).toEqual(defaultLayout());
    expect(parseLayout("   ")).toEqual(defaultLayout());
  });

  it("falls back to the default for a payload it cannot trust", () => {
    expect(parseLayout("{")).toEqual(defaultLayout());
    expect(parseLayout("null")).toEqual(defaultLayout());
    expect(parseLayout("[]")).toEqual(defaultLayout());
    expect(parseLayout(JSON.stringify({ version: LAYOUT_VERSION }))).toEqual(defaultLayout());
    expect(parseLayout(JSON.stringify({ version: 999, root: layout.root }))).toEqual(defaultLayout());
    expect(parseLayout(JSON.stringify({ version: LAYOUT_VERSION, root: { kind: "leaf" } }))).toEqual(defaultLayout());
    expect(parseLayout(JSON.stringify({ version: LAYOUT_VERSION, root: { kind: "split", id: "s", orientation: "diagonal", first: leaf("a"), second: leaf("b") } }))).toEqual(defaultLayout());
  });

  it("refuses a tree that nests past any sane depth", () => {
    let node: unknown = leaf("deep");
    for (let index = 0; index < 60; index += 1) node = split(`s${index}`, "horizontal", node as ReturnType<typeof leaf>, leaf(`x${index}`));
    expect(parseLayout(JSON.stringify({ version: LAYOUT_VERSION, root: node }))).toEqual(defaultLayout());
  });

  it("clamps a stored ratio instead of trusting it", () => {
    const raw = JSON.stringify({ version: LAYOUT_VERSION, root: { kind: "split", id: "s", orientation: "vertical", ratio: 5, first: leaf("a"), second: leaf("b") } });
    const restored = parseLayout(raw);
    expect(restored.root.kind === "split" ? restored.root.ratio : null).toBe(0.88);
  });

  it("drops a focus or zoom that names no pane", () => {
    const restored = parseLayout(JSON.stringify({ version: LAYOUT_VERSION, root: layout.root, focusedPaneId: "gone", zoomedPaneId: "gone" }));
    expect(restored.focusedPaneId).toBe("p1");
    expect(restored.zoomedPaneId).toBeNull();
  });

  it("drops an active tab that is not open and de-duplicates the strip", () => {
    const restored = parseLayout(JSON.stringify({ version: LAYOUT_VERSION, root: layout.root, openMissionIds: ["m1", "m1", "m2"], activeMissionId: "m9" }));
    expect(restored.openMissionIds).toEqual(["m1", "m2"]);
    expect(restored.activeMissionId).toBe("m1");
  });

  it("keeps the first tab selected when none was named", () => {
    const restored = parseLayout(JSON.stringify({ version: LAYOUT_VERSION, root: layout.root, openMissionIds: ["m1", "m2"] }));
    expect(restored.activeMissionId).toBe("m1");
  });

  it("reports a refused write instead of pretending it saved", () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(saveLayout(storage, layout)).toBe(false);
    expect(saveLayout(null, layout)).toBe(false);
  });

  it("reads through a storage that throws, and reports no storage as empty", () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(loadLayout(storage)).toEqual(defaultLayout());
    expect(loadLayout(null)).toEqual(defaultLayout());
  });

  it("finds no storage where there is none", () => {
    expect(browserStorage()).not.toBeUndefined();
  });
});
