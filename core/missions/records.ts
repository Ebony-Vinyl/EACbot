import { randomUUID } from "node:crypto";

import type { Approval, ApprovalStatus, Artifact, ArtifactKind } from "../../packages/agent-protocol/artifact.ts";
import type { MissionInboxItem } from "../../packages/agent-protocol/mission.ts";
import type { TerminalKind, TerminalRef } from "../../packages/agent-protocol/terminal.ts";
import type { Database } from "./db.ts";
import { approvalFromRow, artifactFromRow, inboxFromRow, integer, terminalFromRow, text, type Row } from "./rows.ts";

export class RecordStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  requestApproval(input: {
    id: string;
    missionId: string;
    runId: string;
    action: string;
    detail: string;
    requestedAt: string;
    expiresAt?: string;
  }): Approval {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO approvals (id, mission_id, run_id, status, action, detail, requested_at, expires_at, revision)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, 1)`,
      )
      .run(input.id, input.missionId, input.runId, input.action, input.detail, input.requestedAt, input.expiresAt ?? null);
    return this.requireApproval(input.id);
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? approvalFromRow(row) : undefined;
  }

  requireApproval(id: string): Approval {
    const approval = this.getApproval(id);
    if (!approval) throw new Error(`no approval ${id}`);
    return approval;
  }

  approvalsFor(missionId: string): Approval[] {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE mission_id = ? ORDER BY requested_at, id").all(missionId) as Row[];
    return rows.map(approvalFromRow);
  }

  resolveApproval(id: string, status: ApprovalStatus, resolvedAt: string, by?: string): Approval {
    const current = this.requireApproval(id);
    if (current.status !== "pending") return current;
    this.db
      .prepare("UPDATE approvals SET status = ?, resolved_at = ?, decided_by = ?, revision = revision + 1 WHERE id = ?")
      .run(status, resolvedAt, by ?? null, id);
    return this.requireApproval(id);
  }

  addArtifact(input: {
    id: string;
    missionId: string;
    runId: string;
    kind: ArtifactKind;
    path: string;
    mediaType: string;
    bytes: number;
    createdAt: string;
    sha256?: string;
  }): Artifact {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO artifacts (id, mission_id, run_id, kind, path, media_type, bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.missionId, input.runId, input.kind, input.path, input.mediaType, input.bytes, input.sha256 ?? null, input.createdAt);
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(input.id) as Row;
    return artifactFromRow(row);
  }

  artifactsFor(missionId: string): Artifact[] {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at, id").all(missionId) as Row[];
    return rows.map(artifactFromRow);
  }

  /** Inserts the wake for `generation` once. Returns whether this call created
   * it, which is what makes the wake fire exactly once per generation. */
  enqueueWake(input: {
    missionId: string;
    generation: number;
    kind: MissionInboxItem["kind"];
    payload: Record<string, unknown>;
    createdAt: string;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO mission_inbox (id, mission_id, generation, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), input.missionId, input.generation, input.kind, JSON.stringify(input.payload), input.createdAt);
    return Number(result.changes) === 1;
  }

  inbox(missionId: string, includeConsumed = false): MissionInboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mission_inbox WHERE mission_id = ? ${includeConsumed ? "" : "AND consumed_at IS NULL"}
         ORDER BY generation, created_at`,
      )
      .all(missionId) as Row[];
    return rows.map(inboxFromRow);
  }

  consumeInbox(missionId: string, at: string): number {
    const result = this.db
      .prepare("UPDATE mission_inbox SET consumed_at = ? WHERE mission_id = ? AND consumed_at IS NULL")
      .run(at, missionId);
    return Number(result.changes);
  }

  addTerminal(input: { id: string; missionId: string; runId: string; kind: TerminalKind; createdAt: string }): TerminalRef {
    this.db
      .prepare("INSERT INTO terminals (id, mission_id, run_id, kind, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.id, input.missionId, input.runId, input.kind, input.createdAt);
    return this.requireTerminal(input.id);
  }

  getTerminal(id: string): TerminalRef | undefined {
    const row = this.db.prepare("SELECT * FROM terminals WHERE id = ?").get(id) as Row | undefined;
    return row ? terminalFromRow(row) : undefined;
  }

  requireTerminal(id: string): TerminalRef {
    const terminal = this.getTerminal(id);
    if (!terminal) throw new Error(`no terminal ${id}`);
    return terminal;
  }

  terminalsFor(missionId: string): TerminalRef[] {
    const rows = this.db.prepare("SELECT * FROM terminals WHERE mission_id = ? ORDER BY created_at, id").all(missionId) as Row[];
    return rows.map(terminalFromRow);
  }

  closeTerminal(id: string, at: string, exitCode?: number): TerminalRef {
    this.db.prepare("UPDATE terminals SET closed_at = ?, exit_code = ? WHERE id = ?").run(at, exitCode ?? null, id);
    return this.requireTerminal(id);
  }

  countPendingApprovals(missionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE mission_id = ? AND status = 'pending'")
      .get(missionId) as Row;
    return integer(row, "n");
  }

  missionIdOfEvent(eventId: string): string | undefined {
    const row = this.db.prepare("SELECT mission_id FROM mission_events WHERE event_id = ?").get(eventId) as Row | undefined;
    return row ? text(row, "mission_id") : undefined;
  }
}
