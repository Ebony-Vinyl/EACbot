/** The BSP pane tree: pure data and pure functions, no React.
 *
 * `orientation: "horizontal"` puts the two children side by side (a vertical
 * divider between them); `"vertical"` stacks them (a horizontal divider).
 * `ratio` is the first child's share of the axis and is always inside
 * [`MIN_RATIO`, `MAX_RATIO`], so no splitter can be dragged to zero.
 *
 * Every function returns a new tree; nothing here mutates its input. */

export type PaneOrientation = "horizontal" | "vertical";

export interface PaneLeaf {
  readonly kind: "leaf";
  readonly id: string;
  /** The terminal this pane renders, or null for a pane still choosing one. */
  readonly terminalId: string | null;
}

export interface PaneSplit {
  readonly kind: "split";
  readonly id: string;
  readonly orientation: PaneOrientation;
  /** The first child's share of the axis, in (0, 1). */
  readonly ratio: number;
  readonly first: PaneNode;
  readonly second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export const MIN_RATIO = 0.12;
export const MAX_RATIO = 0.88;

export function clampRatio(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

export function leaf(id: string, terminalId: string | null = null): PaneLeaf {
  return { kind: "leaf", id, terminalId };
}

export function split(
  id: string,
  orientation: PaneOrientation,
  first: PaneNode,
  second: PaneNode,
  ratio = 0.5,
): PaneSplit {
  return { kind: "split", id, orientation, ratio: clampRatio(ratio), first, second };
}

/** Leaves in visual reading order: left to right, top to bottom. */
export function leaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...leaves(node.first), ...leaves(node.second)];
}

export function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  if (node.kind === "leaf") return node.id === id ? node : null;
  return findLeaf(node.first, id) ?? findLeaf(node.second, id);
}

export function findSplit(node: PaneNode, id: string): PaneSplit | null {
  if (node.kind === "leaf") return null;
  if (node.id === id) return node;
  return findSplit(node.first, id) ?? findSplit(node.second, id);
}

/** True when any node in the tree — pane or split — carries this id. */
export function containsPane(node: PaneNode, id: string): boolean {
  return node.id === id || (node.kind === "split" && (containsPane(node.first, id) || containsPane(node.second, id)));
}

/** Pane ids in tree order, including split ids. Used to refuse a duplicate. */
export function nodeIds(node: PaneNode): string[] {
  if (node.kind === "leaf") return [node.id];
  return [node.id, ...nodeIds(node.first), ...nodeIds(node.second)];
}

/**
 * Splits `targetId` into two panes. The existing pane keeps its id and its
 * terminal; the new pane is placed after it, or before it when `position` is
 * "before". Returns the tree unchanged when the target does not exist or when
 * `newPaneId` is already taken.
 */
export function splitPane(
  root: PaneNode,
  targetId: string,
  newPaneId: string,
  orientation: PaneOrientation,
  position: "before" | "after" = "after",
  newTerminalId: string | null = null,
  splitId = `${targetId}+${newPaneId}`,
): PaneNode {
  const taken = new Set(nodeIds(root));
  if (!taken.has(targetId) || taken.has(newPaneId)) return root;
  const grow = (node: PaneNode): PaneNode => {
    if (node.kind === "split") {
      return { ...node, first: grow(node.first), second: grow(node.second) };
    }
    if (node.id !== targetId) return node;
    const added = leaf(newPaneId, newTerminalId);
    return position === "after"
      ? split(splitId, orientation, node, added)
      : split(splitId, orientation, added, node);
  };
  return grow(root);
}

/**
 * Removes a pane and collapses its parent split into the surviving sibling, so
 * no splitter is left holding one child. Returns null when the last pane
 * closes. An unknown id returns the very same tree.
 */
export function closePane(root: PaneNode, id: string): PaneNode | null {
  if (root.kind === "leaf") return root.id === id ? null : root;
  if (!containsPane(root, id)) return root;
  const collapse = (node: PaneNode): PaneNode | null => {
    if (node.kind === "leaf") return node.id === id ? null : node;
    const first = collapse(node.first);
    const second = collapse(node.second);
    if (first === null) return second;
    if (second === null) return first;
    return { ...node, first, second };
  };
  return collapse(root);
}

/** Sets one split's ratio, clamped. Unknown ids and leaves return the tree
 * unchanged. */
export function setRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  if (root.kind === "leaf" || !findSplit(root, splitId)) return root;
  const rewrite = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") return node;
    const first = rewrite(node.first);
    const second = rewrite(node.second);
    const next = node.id === splitId ? { ...node, ratio: clampRatio(ratio) } : node;
    return { ...next, first, second };
  };
  return rewrite(root);
}

/** Nudges a split by a fraction of its own axis, keeping the clamp. */
export function nudgeRatio(root: PaneNode, splitId: string, delta: number): PaneNode {
  const target = findSplit(root, splitId);
  if (!target) return root;
  return setRatio(root, splitId, target.ratio + delta);
}

/**
 * Exchanges what two panes show. Pane ids, focus and ratios stay where they
 * are: only the terminals trade places, which is what a person sees.
 */
export function swapPanes(root: PaneNode, a: string, b: string): PaneNode {
  const first = findLeaf(root, a);
  const second = findLeaf(root, b);
  if (!first || !second || a === b) return root;
  const rewrite = (node: PaneNode): PaneNode => {
    if (node.kind === "split") return { ...node, first: rewrite(node.first), second: rewrite(node.second) };
    if (node.id === a) return { ...node, terminalId: second.terminalId };
    if (node.id === b) return { ...node, terminalId: first.terminalId };
    return node;
  };
  return rewrite(root);
}

/** Points a pane at another terminal, or at none. */
export function assignTerminal(root: PaneNode, paneId: string, terminalId: string | null): PaneNode {
  if (root.kind === "split") {
    return { ...root, first: assignTerminal(root.first, paneId, terminalId), second: assignTerminal(root.second, paneId, terminalId) };
  }
  return root.id === paneId ? { ...root, terminalId } : root;
}

export interface PaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where each pane sits inside `box`, with `gap` pixels taken out of every
 * split for the divider. This is the same arithmetic the CSS uses (percentage
 * flex bases), kept here so the splitter maths is testable without a layout
 * engine.
 */
export function paneRects(root: PaneNode, box: PaneRect, gap = 0): Map<string, PaneRect> {
  const out = new Map<string, PaneRect>();
  const walk = (node: PaneNode, area: PaneRect): void => {
    if (node.kind === "leaf") {
      out.set(node.id, area);
      return;
    }
    const usable = (node.orientation === "horizontal" ? area.width : area.height) - gap;
    const firstSize = Math.max(0, usable * node.ratio);
    const secondSize = Math.max(0, usable - firstSize);
    if (node.orientation === "horizontal") {
      walk(node.first, { x: area.x, y: area.y, width: firstSize, height: area.height });
      walk(node.second, { x: area.x + firstSize + gap, y: area.y, width: secondSize, height: area.height });
    } else {
      walk(node.first, { x: area.x, y: area.y, width: area.width, height: firstSize });
      walk(node.second, { x: area.x, y: area.y + firstSize + gap, width: area.width, height: secondSize });
    }
  };
  walk(root, box);
  return out;
}

export type FocusDirection = "left" | "right" | "up" | "down";

/** The pane a directional move lands on: the nearest one whose centre lies
 * beyond the focused pane's edge in that direction. */
export function adjacentPane(
  root: PaneNode,
  from: string,
  direction: FocusDirection,
  box: PaneRect,
  gap = 0,
): string | null {
  const rects = paneRects(root, box, gap);
  const origin = rects.get(from);
  if (!origin) return null;
  const originX = origin.x + origin.width / 2;
  const originY = origin.y + origin.height / 2;
  let best: { id: string; distance: number } | null = null;
  for (const [id, rect] of rects) {
    if (id === from) continue;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const beyond =
      direction === "left" ? rect.x + rect.width <= origin.x + 0.5
        : direction === "right" ? rect.x >= origin.x + origin.width - 0.5
        : direction === "up" ? rect.y + rect.height <= origin.y + 0.5
        : rect.y >= origin.y + origin.height - 0.5;
    if (!beyond) continue;
    const distance = Math.abs(x - originX) + Math.abs(y - originY);
    if (!best || distance < best.distance) best = { id, distance };
  }
  return best?.id ?? null;
}

/** The pane after (or before) `from` in reading order, wrapping at the ends. */
export function cyclePane(root: PaneNode, from: string, step: 1 | -1): string | null {
  const order = leaves(root).map((pane) => pane.id);
  if (order.length === 0) return null;
  const at = order.indexOf(from);
  if (at < 0) return order[0] ?? null;
  return order[(at + step + order.length) % order.length] ?? null;
}

/** Total leaf count, for the "no panes left" empty state. */
export function paneCount(root: PaneNode | null): number {
  return root === null ? 0 : leaves(root).length;
}
