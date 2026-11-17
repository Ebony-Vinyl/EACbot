/** The mission history as a person reads it: entries in `seq` order, with an
 * honest marker wherever a number is missing.
 *
 * The authority's log is append-only and `seq` is monotonic per mission, so a
 * jump means this client lost entries. That is reported as a gap and answered
 * by refetching from the last known sequence; entries are never silently
 * spliced together to look continuous.
 */

import type { MissionLogEntry } from "../../../packages/agent-protocol/events.ts";

export interface LogGap {
  /** The last sequence this client holds before the gap. */
  readonly afterSeq: number;
  /** The first sequence it received after the gap. */
  readonly beforeSeq: number;
  readonly missing: number;
}

export interface LogView {
  readonly entries: readonly MissionLogEntry[];
  readonly gap: LogGap | null;
  /** The highest sequence held, and what a refetch should ask for. */
  readonly lastSeq: number;
  /** True when the same sequence arrived twice and only one copy was kept. */
  readonly duplicates: number;
}

export const EMPTY_LOG: LogView = { entries: [], gap: null, lastSeq: 0, duplicates: 0 };

/** Merges a page into the view. A page that starts after the held sequence
 * opens a gap; a page that overlaps it keeps one copy of each entry. */
export function mergeEntries(view: LogView, incoming: readonly MissionLogEntry[]): LogView {
  if (incoming.length === 0) return view;
  const bySeq = new Map<number, MissionLogEntry>();
  for (const entry of view.entries) bySeq.set(entry.seq, entry);
  let duplicates = view.duplicates;
  for (const entry of incoming) {
    if (bySeq.has(entry.seq)) duplicates += 1;
    bySeq.set(entry.seq, entry);
  }
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const lastSeq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
  return { entries, gap: findGap(entries), lastSeq, duplicates };
}

/** The first jump in the sequence, if any. */
export function findGap(entries: readonly MissionLogEntry[]): LogGap | null {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1] as MissionLogEntry;
    const current = entries[index] as MissionLogEntry;
    if (current.seq > previous.seq + 1) {
      return { afterSeq: previous.seq, beforeSeq: current.seq, missing: current.seq - previous.seq - 1 };
    }
  }
  return null;
}

/** What to ask the history route for after a resync: from the last sequence
 * held, not from the beginning, so a resync does not refetch everything. */
export function refetchFrom(view: LogView): number {
  return view.lastSeq;
}

/** Replaces the view with a whole refetch, keeping a gap the server still
 * reports rather than pretending the refetch closed it. */
export function replaceEntries(entries: readonly MissionLogEntry[]): LogView {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const unique = new Map<number, MissionLogEntry>();
  for (const entry of sorted) unique.set(entry.seq, entry);
  const kept = [...unique.values()];
  return {
    entries: kept,
    gap: findGap(kept),
    lastSeq: kept.reduce((max, entry) => Math.max(max, entry.seq), 0),
    duplicates: sorted.length - kept.length,
  };
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "run.started": "Run started",
  "run.output": "Output",
  "run.tool_call": "Tool call",
  "run.tool_result": "Tool result",
  "run.approval_requested": "Approval requested",
  "run.approval_resolved": "Approval resolved",
  "run.waiting_input": "Waiting for input",
  "run.input_received": "Input received",
  "run.steer_acknowledged": "Steer acknowledged",
  "run.interrupted": "Interrupted",
  "run.resumed": "Resumed",
  "run.completed": "Completed",
  "run.failed": "Failed",
  "run.cancelled": "Cancelled",
  "run.artifact": "Artifact",
  "run.usage": "Usage",
  "run.child_spawned": "Child started",
  "run.child_settled": "Child settled",
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

/** A one-line detail for an entry: the fields worth reading, in a fixed order,
 * truncated so one long output cannot push the rest off screen. */
export function eventDetail(entry: MissionLogEntry, limit = 160): string {
  const payload = entry.payload;
  const candidates = ["text", "message", "detail", "question", "input", "tool", "path", "reason", "summary", "code", "status", "decision"];
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return truncate(value.trim(), limit);
  }
  return "";
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, " ");
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1))}…`;
}
