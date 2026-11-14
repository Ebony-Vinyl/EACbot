import { randomUUID } from "node:crypto";

import type { AdapterEvent } from "../../packages/agent-protocol/events.ts";
import type { MissionLogEntry } from "../../packages/agent-protocol/events.ts";
import type { Database } from "./db.ts";
import { integer, nullableInteger, nullableText, text, type Row } from "./rows.ts";

export interface AppendOutcome {
  readonly appended: boolean;
  readonly duplicate: boolean;
  readonly buffered: boolean;
  readonly seq?: number;
}

export interface PendingEvent {
  readonly runId: string;
  readonly adapterSeq: number;
  readonly event: AdapterEvent;
}

/** The append-only log. Adapter events are deduplicated by event id and by
 * (run, seq); an event that arrives before its predecessors is held in
 * `pending_events` until the gap closes, so replay order is always the
 * adapter's own order. */
export class EventLog {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Records an adapter event. Returns `buffered` when a lower `seq` is still
   * missing; the caller must drain with `drainRun` once it arrives. */
  appendAdapterEvent(event: AdapterEvent): AppendOutcome {
    const existing = this.db.prepare("SELECT seq FROM mission_events WHERE event_id = ?").get(event.eventId) as Row | undefined;
    if (existing) return { appended: false, duplicate: true, buffered: false };

    const run = this.db.prepare("SELECT last_adapter_seq FROM runs WHERE id = ?").get(event.runId) as Row | undefined;
    const lastSeq = run ? integer(run, "last_adapter_seq") : 0;
    const already = this.db
      .prepare("SELECT event_id FROM mission_events WHERE run_id = ? AND adapter_seq = ?")
      .get(event.runId, event.seq) as Row | undefined;
    if (already) return { appended: false, duplicate: true, buffered: false };

    if (event.seq <= lastSeq) return { appended: false, duplicate: true, buffered: false };

    if (event.seq > lastSeq + 1) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO pending_events (run_id, adapter_seq, event_id, mission_id, at, type, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(event.runId, event.seq, event.eventId, event.missionId, event.at, event.type, JSON.stringify(event));
      return { appended: false, duplicate: false, buffered: true };
    }

    const seq = this.writeAdapterEvent(event);
    return { appended: true, duplicate: false, buffered: false, seq };
  }

  /** Writes `event` and every buffered successor that is now contiguous. */
  drainRun(runId: string): AdapterEvent[] {
    const written: AdapterEvent[] = [];
    for (;;) {
      const run = this.db.prepare("SELECT last_adapter_seq FROM runs WHERE id = ?").get(runId) as Row | undefined;
      if (!run) break;
      const next = integer(run, "last_adapter_seq") + 1;
      const pending = this.db
        .prepare("SELECT payload_json FROM pending_events WHERE run_id = ? AND adapter_seq = ?")
        .get(runId, next) as Row | undefined;
      if (!pending) break;
      const event = JSON.parse(text(pending, "payload_json")) as AdapterEvent;
      this.db.prepare("DELETE FROM pending_events WHERE run_id = ? AND adapter_seq = ?").run(runId, next);
      this.writeAdapterEvent(event);
      written.push(event);
    }
    return written;
  }

  /** The next event the log would accept for `runId`. */
  expectedSeq(runId: string): number {
    const run = this.db.prepare("SELECT last_adapter_seq FROM runs WHERE id = ?").get(runId) as Row | undefined;
    return (run ? integer(run, "last_adapter_seq") : 0) + 1;
  }

  pendingFor(runId: string): PendingEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM pending_events WHERE run_id = ? ORDER BY adapter_seq")
      .all(runId) as Row[];
    return rows.map((row) => ({
      runId: text(row, "run_id"),
      adapterSeq: integer(row, "adapter_seq"),
      event: JSON.parse(text(row, "payload_json")) as AdapterEvent,
    }));
  }

  appendAuthorityEvent(missionId: string, type: string, payload: Record<string, unknown>, at: string, runId?: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO mission_events (event_id, mission_id, run_id, at, source, type, payload_json, adapter_seq)
         VALUES (?, ?, ?, ?, 'authority', ?, ?, NULL)`,
      )
      .run(randomUUID(), missionId, runId ?? null, at, type, JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  }

  events(missionId: string, options: { sinceSeq?: number; limit?: number } = {}): MissionLogEntry[] {
    const since = options.sinceSeq ?? 0;
    const limit = options.limit ?? 500;
    const rows = this.db
      .prepare("SELECT * FROM mission_events WHERE mission_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(missionId, since, limit) as Row[];
    return rows.map(entryFromRow);
  }

  /** Events for a whole tree, ordered by the log's own sequence. */
  treeEvents(rootMissionId: string, options: { sinceSeq?: number; limit?: number } = {}): MissionLogEntry[] {
    const since = options.sinceSeq ?? 0;
    const limit = options.limit ?? 500;
    const rows = this.db
      .prepare(
        `SELECT e.* FROM mission_events e
         JOIN missions m ON m.id = e.mission_id
         WHERE m.root_mission_id = ? AND e.seq > ? ORDER BY e.seq LIMIT ?`,
      )
      .all(rootMissionId, since, limit) as Row[];
    return rows.map(entryFromRow);
  }

  countFor(missionId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM mission_events WHERE mission_id = ?").get(missionId) as Row;
    return integer(row, "n");
  }

  private writeAdapterEvent(event: AdapterEvent): number {
    const result = this.db
      .prepare(
        `INSERT INTO mission_events (event_id, mission_id, run_id, at, source, type, payload_json, adapter_seq)
         VALUES (?, ?, ?, ?, 'adapter', ?, ?, ?)`,
      )
      .run(event.eventId, event.missionId, event.runId, event.at, event.type, JSON.stringify(event), event.seq);
    this.db
      .prepare("UPDATE runs SET last_adapter_seq = MAX(last_adapter_seq, ?) WHERE id = ?")
      .run(event.seq, event.runId);
    return Number(result.lastInsertRowid);
  }
}

function entryFromRow(row: Row): MissionLogEntry {
  const runId = nullableText(row, "run_id");
  const adapterSeq = nullableInteger(row, "adapter_seq");
  return {
    seq: integer(row, "seq"),
    eventId: text(row, "event_id"),
    missionId: text(row, "mission_id"),
    ...(runId ? { runId } : {}),
    at: text(row, "at"),
    source: text(row, "source") as MissionLogEntry["source"],
    type: text(row, "type"),
    payload: JSON.parse(text(row, "payload_json")) as Record<string, unknown>,
    ...(adapterSeq !== undefined ? { adapterSeq } : {}),
  };
}
