import { describe, expect, it } from "vitest";

import {
  MAX_RATIO,
  MIN_RATIO,
  adjacentPane,
  assignTerminal,
  clampRatio,
  closePane,
  containsPane,
  cyclePane,
  findLeaf,
  findSplit,
  leaf,
  leaves,
  nudgeRatio,
  paneCount,
  paneRects,
  setRatio,
  split,
  splitPane,
  swapPanes,
} from "./pane-tree.ts";

const two = split("s1", "horizontal", leaf("a", "t-a"), leaf("b", "t-b"), 0.3);

describe("split ratios", () => {
  it("clamps to the range that keeps a pane visible", () => {
    expect(clampRatio(0)).toBe(MIN_RATIO);
    expect(clampRatio(1)).toBe(MAX_RATIO);
    expect(clampRatio(-3)).toBe(MIN_RATIO);
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(Number.NaN)).toBe(0.5);
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(MAX_RATIO);
  });

  it("clamps when a split is created", () => {
    expect(split("s", "vertical", leaf("a"), leaf("b"), 0.99).ratio).toBe(MAX_RATIO);
  });

  it("sets a ratio only on the named split", () => {
    const tree = split("outer", "vertical", two, leaf("c"), 0.5);
    const next = setRatio(tree, "s1", 0.7);
    expect(findSplit(next, "s1")?.ratio).toBe(0.7);
    expect(findSplit(next, "outer")?.ratio).toBe(0.5);
  });

  it("nudges by a delta and stays clamped", () => {
    expect(findSplit(nudgeRatio(two, "s1", 0.1), "s1")?.ratio).toBeCloseTo(0.4);
    expect(findSplit(nudgeRatio(two, "s1", 10), "s1")?.ratio).toBe(MAX_RATIO);
    expect(findSplit(nudgeRatio(two, "s1", -10), "s1")?.ratio).toBe(MIN_RATIO);
  });

  it("ignores an unknown split id and leaves the tree identical", () => {
    expect(setRatio(two, "nope", 0.9)).toBe(two);
    expect(nudgeRatio(two, "nope", 0.1)).toBe(two);
  });
});

describe("splitting", () => {
  it("splits the target and keeps its terminal in place", () => {
    const tree = splitPane(leaf("a", "t-a"), "a", "b", "horizontal");
    expect(tree.kind).toBe("split");
    expect(leaves(tree).map((pane) => pane.id)).toEqual(["a", "b"]);
    expect(findLeaf(tree, "a")?.terminalId).toBe("t-a");
    expect(findLeaf(tree, "b")?.terminalId).toBeNull();
  });

  it("puts the new pane first when asked", () => {
    const tree = splitPane(leaf("a", "t-a"), "a", "b", "vertical", "before");
    expect(leaves(tree).map((pane) => pane.id)).toEqual(["b", "a"]);
  });

  it("splits a nested pane without disturbing its sibling", () => {
    const tree = splitPane(two, "b", "c", "vertical");
    expect(leaves(tree).map((pane) => pane.id)).toEqual(["a", "b", "c"]);
    expect(findSplit(tree, "s1")?.ratio).toBe(0.3);
  });

  it("refuses an unknown target and a duplicate pane id", () => {
    expect(splitPane(two, "zzz", "c", "horizontal")).toBe(two);
    expect(splitPane(two, "a", "b", "horizontal")).toBe(two);
  });

  it("reports whether a pane id is already in the tree", () => {
    expect(containsPane(two, "a")).toBe(true);
    expect(containsPane(two, "s1")).toBe(true);
    expect(containsPane(two, "nope")).toBe(false);
  });
});

describe("closing", () => {
  it("collapses a split into its surviving sibling", () => {
    const tree = closePane(two, "a");
    expect(tree?.kind).toBe("leaf");
    expect((tree as { id: string }).id).toBe("b");
  });

  it("returns null when the last pane closes", () => {
    expect(closePane(leaf("only"), "only")).toBeNull();
  });

  it("leaves the tree alone for an unknown id", () => {
    expect(closePane(two, "nope")).toBe(two);
  });

  it("keeps the other branch intact when a nested pane closes", () => {
    const tree = split("outer", "vertical", two, leaf("c", "t-c"), 0.4);
    const next = closePane(tree, "b");
    expect(next?.kind).toBe("split");
    expect(leaves(next!).map((pane) => pane.id)).toEqual(["a", "c"]);
    expect(findSplit(next!, "outer")?.ratio).toBe(0.4);
  });
});

describe("swapping", () => {
  it("exchanges what two panes show and keeps ids and ratios", () => {
    const next = swapPanes(two, "a", "b");
    expect(findLeaf(next, "a")?.terminalId).toBe("t-b");
    expect(findLeaf(next, "b")?.terminalId).toBe("t-a");
    expect(findSplit(next, "s1")?.ratio).toBe(0.3);
  });

  it("ignores a missing pane and a swap with itself", () => {
    expect(swapPanes(two, "a", "nope")).toBe(two);
    expect(swapPanes(two, "a", "a")).toBe(two);
  });

  it("assigns a terminal to one pane only", () => {
    const next = assignTerminal(two, "b", "t-new");
    expect(findLeaf(next, "a")?.terminalId).toBe("t-a");
    expect(findLeaf(next, "b")?.terminalId).toBe("t-new");
    expect(findLeaf(assignTerminal(two, "b", null), "b")?.terminalId).toBeNull();
  });
});

describe("geometry", () => {
  const box = { x: 0, y: 0, width: 1000, height: 500 };

  it("lays a horizontal split out left to right", () => {
    const rects = paneRects(two, box);
    expect(rects.get("a")).toEqual({ x: 0, y: 0, width: 300, height: 500 });
    expect(rects.get("b")).toEqual({ x: 300, y: 0, width: 700, height: 500 });
  });

  it("takes the divider gap out of the axis", () => {
    const rects = paneRects(two, box, 10);
    expect(rects.get("a")?.width).toBeCloseTo(297);
    expect(rects.get("b")?.x).toBeCloseTo(307);
    expect((rects.get("a")?.width ?? 0) + 10 + (rects.get("b")?.width ?? 0)).toBeCloseTo(1000);
  });

  it("lays a vertical split out top to bottom", () => {
    const rects = paneRects(split("s", "vertical", leaf("a"), leaf("b"), 0.25), box);
    expect(rects.get("a")).toEqual({ x: 0, y: 0, width: 1000, height: 125 });
    expect(rects.get("b")).toEqual({ x: 0, y: 125, width: 1000, height: 375 });
  });

  it("nests areas without leaking one branch into the other", () => {
    const tree = split("outer", "vertical", two, leaf("c"), 0.5);
    const rects = paneRects(tree, box);
    expect(rects.get("a")).toEqual({ x: 0, y: 0, width: 300, height: 250 });
    expect(rects.get("b")).toEqual({ x: 300, y: 0, width: 700, height: 250 });
    expect(rects.get("c")).toEqual({ x: 0, y: 250, width: 1000, height: 250 });
  });
});

describe("focus movement", () => {
  const box = { x: 0, y: 0, width: 1000, height: 500 };

  it("moves to the pane on the right and back", () => {
    expect(adjacentPane(two, "a", "right", box)).toBe("b");
    expect(adjacentPane(two, "b", "left", box)).toBe("a");
  });

  it("finds nothing past an edge", () => {
    expect(adjacentPane(two, "a", "left", box)).toBeNull();
    expect(adjacentPane(two, "b", "right", box)).toBeNull();
  });

  it("moves between stacked panes", () => {
    const tree = split("s", "vertical", leaf("top"), leaf("bottom"));
    expect(adjacentPane(tree, "top", "down", box)).toBe("bottom");
    expect(adjacentPane(tree, "bottom", "up", box)).toBe("top");
  });

  it("cycles through panes in reading order and wraps", () => {
    const tree = splitPane(two, "b", "c", "horizontal");
    expect(cyclePane(tree, "a", 1)).toBe("b");
    expect(cyclePane(tree, "c", 1)).toBe("a");
    expect(cyclePane(tree, "a", -1)).toBe("c");
  });

  it("counts panes, including none", () => {
    expect(paneCount(two)).toBe(2);
    expect(paneCount(null)).toBe(0);
  });
});
