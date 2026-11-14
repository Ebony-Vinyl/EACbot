import { CommandError } from "../../packages/agent-protocol/commands.ts";
import type { CommandRecord, CommandResult, CommandType } from "../../packages/agent-protocol/commands.ts";
import type { Database } from "./db.ts";
import { text, type Row } from "./rows.ts";

/** Canonical JSON: object keys sorted, so two requests that mean the same thing
 * hash the same regardless of field order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`);
  return `{${entries.join(",")}}`;
}

export function requestHash(type: CommandType, body: unknown): string {
  return stableStringify({ type, body });
}

export class CommandRegistry {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** A replay of the same command id with the same body returns the stored
   * result; the same id with a different body is a conflict, not an overwrite. */
  lookup(commandId: string, hash: string): CommandResult | undefined {
    const row = this.db.prepare("SELECT * FROM commands WHERE command_id = ?").get(commandId) as Row | undefined;
    if (!row) return undefined;
    if (text(row, "request_hash") !== hash) {
      throw new CommandError("command_conflict", `command ${commandId} was already used with a different request`);
    }
    const stored = JSON.parse(text(row, "result_json")) as CommandResult;
    return { ...stored, replayed: true };
  }

  record(record: CommandRecord): void {
    this.db
      .prepare(
        `INSERT INTO commands (command_id, type, mission_id, applied_at, request_hash, result_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.commandId,
        record.type,
        record.missionId,
        record.appliedAt,
        record.requestHash,
        JSON.stringify({ ...record.result, replayed: false }),
      );
  }

  get(commandId: string): CommandRecord | undefined {
    const row = this.db.prepare("SELECT * FROM commands WHERE command_id = ?").get(commandId) as Row | undefined;
    if (!row) return undefined;
    return {
      commandId: text(row, "command_id"),
      type: text(row, "type") as CommandType,
      missionId: text(row, "mission_id"),
      appliedAt: text(row, "applied_at"),
      requestHash: text(row, "request_hash"),
      result: JSON.parse(text(row, "result_json")) as CommandResult,
    };
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM commands").get() as Row;
    return Number(row.n);
  }
}
