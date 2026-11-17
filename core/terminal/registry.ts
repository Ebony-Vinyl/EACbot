/**
 * Terminal facts as a client sees them: a snapshot, then events applied in
 * order. This is a read-only view. Nothing here writes a task, a mission or an
 * agent record; terminal and OSC 7501 state never mutates them.
 *
 * A subscriber that falls behind gets `missed` with a fresh snapshot, and `seq`
 * restarts with each core process, so a reconnect always begins from a snapshot
 * (herdr-core 0.1.21, `docs/api.md`, "Events").
 */

import { TransportError } from "./protocol.ts";
import type { EventParams, EventType, Status, Terminal } from "./types.ts";

export interface RegistrySnapshot {
  readonly seq: number;
  readonly terminals: readonly Terminal[];
}

export interface ReconcileResult {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export type RegistryListener = (change: {
  readonly type: EventType | "snapshot" | "missed";
  readonly terminal?: string;
  readonly record?: Terminal;
}) => void;

export class TerminalRegistry {
  #seq = 0;
  #epoch = 0;
  #stale = false;
  readonly #terminals = new Map<string, Terminal>();
  readonly #listeners = new Set<RegistryListener>();

  /** The last sequence applied. Events at or below it are already in the view. */
  get seq(): number {
    return this.#seq;
  }

  /** Bumped on every snapshot: events from an older epoch are stale. */
  get epoch(): number {
    return this.#epoch;
  }

  get size(): number {
    return this.#terminals.size;
  }

  list(): Terminal[] {
    return [...this.#terminals.values()];
  }

  get(address: string): Terminal | null {
    return this.#terminals.get(address) ?? null;
  }

  /** Replaces the whole view with a snapshot, returning what moved. */
  applySnapshot(snapshot: RegistrySnapshot): ReconcileResult {
    const before = new Map(this.#terminals);
    this.#terminals.clear();
    for (const terminal of snapshot.terminals) this.#terminals.set(terminal.address, terminal);
    this.#seq = snapshot.seq;
    this.#epoch += 1;
    this.#stale = false;
    const added = [...this.#terminals.keys()].filter((address) => !before.has(address));
    const removed = [...before.keys()].filter((address) => !this.#terminals.has(address));
    const changed = [...this.#terminals.keys()].filter((address) => {
      const previous = before.get(address);
      return previous !== undefined && !sameTerminal(previous, this.#terminals.get(address)!);
    });
    this.#emit({ type: "snapshot" });
    return { added, removed, changed };
  }

  /**
   * Applies one event. Returns false when it was dropped: an event at or below
   * the last applied sequence is already covered by a snapshot.
   */
  applyEvent(params: EventParams): boolean {
    // Between a dropped connection and its snapshot nothing can be ordered:
    // `seq` restarted with the core, so an old event would look new.
    if (this.#stale) return false;
    if (params.seq <= this.#seq) return false;
    this.#seq = params.seq;
    const address = params.terminal;
    if (address === undefined) {
      this.#emit({ type: "doc" });
      return true;
    }
    const existing = this.#terminals.get(address);
    switch (params.type) {
      case "created":
      case "restarted": {
        const record = params.data as Terminal;
        this.#terminals.set(address, record);
        this.#emit({ type: params.type, terminal: address, record });
        return true;
      }
      case "removed":
        this.#terminals.delete(address);
        this.#emit({ type: "removed", terminal: address });
        return true;
      case "lost": {
        if (!existing) return true;
        const data = params.data as { reason?: string; exit_code?: number | null; signal?: number | null };
        const next: Terminal = {
          ...existing,
          pid: null,
          foreground: null,
          reason: data.reason ?? existing.reason ?? null,
          exit_code: data.exit_code ?? null,
          signal: data.signal ?? null,
        };
        this.#terminals.set(address, next);
        this.#emit({ type: "lost", terminal: address, record: next });
        return true;
      }
      case "finished": {
        if (!existing) return true;
        const data = params.data as {
          reason?: string;
          exit_code?: number | null;
          signal?: number | null;
          finished_ms?: number | null;
        };
        const next: Terminal = {
          ...existing,
          state: "finished",
          foreground: null,
          status: null,
          reason: data.reason ?? existing.reason ?? null,
          exit_code: data.exit_code ?? null,
          signal: data.signal ?? null,
          finished_ms: data.finished_ms ?? existing.finished_ms ?? null,
        };
        this.#terminals.set(address, next);
        this.#emit({ type: "finished", terminal: address, record: next });
        return true;
      }
      case "keep": {
        if (!existing) return true;
        const next: Terminal = { ...existing, keep: Boolean((params.data as { keep?: boolean }).keep) };
        this.#terminals.set(address, next);
        this.#emit({ type: "keep", terminal: address, record: next });
        return true;
      }
      case "status": {
        if (!existing) return true;
        const data = params.data as { status?: Status | null; records?: Record<string, Status>; reported?: boolean };
        const next: Terminal = {
          ...existing,
          status: data.status ?? null,
          records: data.records ?? existing.records ?? {},
          reported: data.reported ?? existing.reported ?? false,
        };
        this.#terminals.set(address, next);
        this.#emit({ type: "status", terminal: address, record: next });
        return true;
      }
      case "turn": {
        if (!existing) return true;
        const next: Terminal = { ...existing, turn: Number((params.data as { turn?: number }).turn ?? existing.turn ?? 0) };
        this.#terminals.set(address, next);
        this.#emit({ type: "turn", terminal: address, record: next });
        return true;
      }
      case "title": {
        if (!existing) return true;
        const next: Terminal = { ...existing, title: String((params.data as { title?: string }).title ?? "") };
        this.#terminals.set(address, next);
        this.#emit({ type: "title", terminal: address, record: next });
        return true;
      }
      case "labels": {
        const data = params.data as { labels?: Record<string, string>; record?: Terminal };
        if (data.record) {
          this.#terminals.set(data.record.address, data.record);
          this.#emit({ type: "labels", terminal: data.record.address, record: data.record });
          return true;
        }
        if (!existing) return true;
        const next: Terminal = { ...existing, labels: data.labels ?? existing.labels };
        this.#terminals.set(address, next);
        this.#emit({ type: "labels", terminal: address, record: next });
        return true;
      }
      case "size": {
        if (!existing) return true;
        const data = params.data as { cols?: number; rows?: number };
        const next: Terminal = { ...existing, cols: data.cols ?? existing.cols, rows: data.rows ?? existing.rows };
        this.#terminals.set(address, next);
        this.#emit({ type: "size", terminal: address, record: next });
        return true;
      }
      case "foreground": {
        if (!existing) return true;
        const next: Terminal = {
          ...existing,
          foreground: params.data === null ? null : (params.data as Terminal["foreground"]),
        };
        this.#terminals.set(address, next);
        this.#emit({ type: "foreground", terminal: address, record: next });
        return true;
      }
      default:
        return true;
    }
  }

  /**
   * After a dropped connection nothing can be trusted: the core may have
   * restarted, `seq` may have restarted with it, and terminals may have come
   * and gone. The last view is kept only so the next snapshot can be diffed
   * against it; it is marked stale until then.
   */
  markDisconnected(error: TransportError | null): void {
    void error;
    this.#epoch += 1;
    this.#stale = true;
    this.#seq = 0;
  }

  /** True between a dropped connection and the snapshot that replaces it. */
  get stale(): boolean {
    return this.#stale;
  }

  subscribe(listener: RegistryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(change: { type: EventType | "snapshot" | "missed"; terminal?: string; record?: Terminal }): void {
    for (const listener of this.#listeners) listener(change);
  }
}

function sameTerminal(a: Terminal, b: Terminal): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
