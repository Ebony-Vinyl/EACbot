// Health samples live in SQLite beside the transcripts: one row per observation, keyed so a re-import
// replaces its own rows instead of duplicating them. Nothing here knows about HTTP, adapters or grants.
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  healthSampleSchema,
  type HealthBucket,
  type HealthMetricSummary,
  type HealthQuery,
  type HealthSample,
  type HealthSampleInput,
  type HealthSeries,
  type HealthSource,
  type HealthTrend,
  healthAggregationOf,
  healthUnitOf,
  isCanonicalHealthMetric,
} from "../../shared/health.ts";

const DB_FILE = "health.db";
/** A single import may not exceed this, so one bad file cannot fill the disk in one call. */
export const HEALTH_MAX_IMPORT_ROWS = 200_000;
const DEFAULT_QUERY_LIMIT = 2_000;

export class HealthStoreError extends Error {
  readonly code: "invalid_metric" | "invalid_value" | "invalid_time" | "unknown_source" | "too_many_rows" | "store_failure";
  constructor(code: HealthStoreError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface HealthSampleRow extends HealthSample {
  /** Set when a later import replaced this row; the old row is kept so a mistaken import is reversible. */
  supersededAt?: string;
}

export interface HealthStoreOptions {
  dataDir: string;
  now?: () => string;
}

/** Local midnight of the day `at` falls in, in ms. */
function dayStart(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function bucketStart(at: number, bucket: HealthBucket): number {
  if (bucket === "hour") {
    const date = new Date(at);
    date.setMinutes(0, 0, 0);
    return date.getTime();
  }
  if (bucket === "week") return dayStart(at) - ((new Date(at).getDay() + 6) % 7) * 86_400_000;
  if (bucket === "month") {
    const date = new Date(at);
    return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  }
  return dayStart(at);
}

function parseInstant(value: string, field: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new HealthStoreError("invalid_time", `${field} is not a valid time: ${String(value).slice(0, 60)}`);
  return time;
}

/** The key a sample's identity is built from: one source, one metric, one window. */
function sampleKey(sample: Pick<HealthSampleInput, "sourceId" | "metric" | "at" | "endedAt">): string {
  return `${sample.sourceId}\u0000${sample.metric}\u0000${sample.at}\u0000${sample.endedAt ?? ""}`;
}

/** Health samples and sources, with import deduplication and the aggregate reads the UI and tools need. */
export class HealthStore {
  private db: DatabaseSync | null = null;
  private readonly statements = new Map<string, StatementSync>();
  private readonly file: string;
  private readonly now: () => string;

  constructor(options: HealthStoreOptions) {
    this.file = join(options.dataDir, DB_FILE);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    closeSync(openSync(this.file, "a", 0o600));
    try {
      chmodSync(this.file, 0o600);
    } catch {}
    const db = new DatabaseSync(this.file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS health_samples (
        sample_key TEXT NOT NULL PRIMARY KEY,
        sample_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        at INTEGER NOT NULL,
        ended_at INTEGER,
        source_id TEXT NOT NULL,
        quality TEXT NOT NULL,
        device_id TEXT,
        note TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        superseded_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS health_samples_metric_at ON health_samples(metric, at);
      CREATE INDEX IF NOT EXISTS health_samples_source_at ON health_samples(source_id, at);
      CREATE TABLE IF NOT EXISTS health_sources (
        source_id TEXT NOT NULL PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        credential_ref TEXT,
        last_sync_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db = db;
    return db;
  }

  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.open().prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  close(): void {
    this.statements.clear();
    this.db?.close();
    this.db = null;
  }

  /** Validates and normalises one row without writing it, so an importer can report per-row problems. */
  validate(input: HealthSampleInput): HealthSampleInput {
    if (!isCanonicalHealthMetric(input.metric) && !/^[a-z][a-z0-9_]{1,39}$/.test(input.metric)) {
      throw new HealthStoreError("invalid_metric", `not a metric name: ${String(input.metric).slice(0, 40)}`);
    }
    if (!Number.isFinite(input.value)) throw new HealthStoreError("invalid_value", "value must be a finite number");
    parseInstant(input.at, "at");
    if (input.endedAt !== undefined) {
      if (parseInstant(input.endedAt, "endedAt") < parseInstant(input.at, "at")) {
        throw new HealthStoreError("invalid_time", "endedAt is before at");
      }
    }
    return { ...input, unit: input.unit || healthUnitOf(input.metric) };
  }

  /**
   * Writes rows, replacing any row with the same identity. Returns how many were
   * new and how many replaced an earlier one, so an import can say both.
   */
  write(inputs: readonly HealthSampleInput[]): { added: number; replaced: number; samples: HealthSample[] } {
    if (inputs.length > HEALTH_MAX_IMPORT_ROWS) {
      throw new HealthStoreError("too_many_rows", `at most ${HEALTH_MAX_IMPORT_ROWS} rows per import`);
    }
    const db = this.open();
    const select = this.prepare("SELECT revision, superseded_at FROM health_samples WHERE sample_key = ?");
    const insert = this.prepare(`
      INSERT INTO health_samples (sample_key, sample_id, metric, value, unit, at, ended_at, source_id, quality, device_id, note, revision, superseded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `);
    const update = this.prepare(`
      UPDATE health_samples SET sample_id = ?, value = ?, unit = ?, quality = ?, device_id = ?, note = ?, revision = ?, superseded_at = NULL
      WHERE sample_key = ?
    `);
    const samples: HealthSample[] = [];
    let added = 0;
    let replaced = 0;
    db.exec("BEGIN");
    try {
      for (const raw of inputs) {
        const input = this.validate(raw);
        const key = sampleKey(input);
        const at = parseInstant(input.at, "at");
        const endedAt = input.endedAt === undefined ? null : parseInstant(input.endedAt, "endedAt");
        const existing = select.get(key) as { revision: number } | undefined;
        const sampleId = input.sampleId ?? randomUUID();
        const revision = existing ? existing.revision + 1 : 0;
        if (existing) {
          replaced += 1;
          update.run(sampleId, input.value, input.unit, input.quality, input.deviceId ?? null, input.note ?? null, revision, key);
        } else {
          added += 1;
          insert.run(key, sampleId, input.metric, input.value, input.unit, at, endedAt, input.sourceId, input.quality,
            input.deviceId ?? null, input.note ?? null, revision);
        }
        samples.push({
          sampleId, metric: input.metric, value: input.value, unit: input.unit, at: input.at,
          ...(input.endedAt ? { endedAt: input.endedAt } : {}), sourceId: input.sourceId, quality: input.quality,
          ...(input.deviceId ? { deviceId: input.deviceId } : {}), ...(input.note ? { note: input.note } : {}), revision,
        });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (error instanceof HealthStoreError) throw error;
      throw new HealthStoreError("store_failure", error instanceof Error ? error.message : String(error));
    }
    this.touchSources(inputs);
    return { added, replaced, samples };
  }

  private touchSources(inputs: readonly HealthSampleInput[]): void {
    const ids = [...new Set(inputs.map((input) => input.sourceId))];
    if (!ids.length) return;
    const existing = this.prepare("SELECT source_id FROM health_sources WHERE source_id = ?");
    const insert = this.prepare(`
      INSERT INTO health_sources (source_id, kind, label, status, credential_ref, last_sync_at, created_at, updated_at)
      VALUES (?, 'file', ?, 'connected', NULL, ?, ?, ?)
    `);
    const bump = this.prepare("UPDATE health_sources SET last_sync_at = ?, updated_at = ? WHERE source_id = ?");
    const now = Date.parse(this.now());
    for (const sourceId of ids) {
      if (existing.get(sourceId)) bump.run(now, now, sourceId);
      else insert.run(sourceId, sourceId.slice(0, 120), now, now, now);
    }
  }

  upsertSource(source: Omit<HealthSource, "sampleCount" | "createdAt" | "updatedAt"> & Partial<Pick<HealthSource, "createdAt">>): HealthSource {
    const now = Date.parse(this.now());
    const createdAt = source.createdAt ? Date.parse(source.createdAt) : now;
    this.prepare(`
      INSERT INTO health_sources (source_id, kind, label, status, credential_ref, last_sync_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        kind = excluded.kind, label = excluded.label, status = excluded.status,
        credential_ref = excluded.credential_ref, last_sync_at = excluded.last_sync_at, updated_at = excluded.updated_at
    `).run(source.sourceId, source.kind, source.label, source.status, source.credentialRef,
      source.lastSyncAt ? Date.parse(source.lastSyncAt) : null, createdAt, now);
    return this.sources().find((row) => row.sourceId === source.sourceId)!;
  }

  sources(): HealthSource[] {
    const rows = this.prepare(`
      SELECT s.source_id, s.kind, s.label, s.status, s.credential_ref, s.last_sync_at, s.created_at, s.updated_at,
             (SELECT COUNT(*) FROM health_samples h WHERE h.source_id = s.source_id AND h.superseded_at IS NULL) AS n
      FROM health_sources s ORDER BY s.source_id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sourceId: String(row.source_id),
      kind: String(row.kind) as HealthSource["kind"],
      label: String(row.label),
      status: String(row.status) as HealthSource["status"],
      credentialRef: row.credential_ref === null ? null : String(row.credential_ref),
      ...(row.last_sync_at === null ? {} : { lastSyncAt: new Date(Number(row.last_sync_at)).toISOString() }),
      sampleCount: Number(row.n),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    }));
  }

  private where(query: HealthQuery): { sql: string; params: Array<string | number> } {
    const clauses = ["superseded_at IS NULL"];
    const params: Array<string | number> = [];
    if (query.metrics?.length) {
      clauses.push(`metric IN (${query.metrics.map(() => "?").join(",")})`);
      params.push(...query.metrics);
    }
    if (query.sources?.length) {
      clauses.push(`source_id IN (${query.sources.map(() => "?").join(",")})`);
      params.push(...query.sources);
    }
    if (query.from) {
      clauses.push("at >= ?");
      params.push(parseInstant(query.from, "from"));
    }
    if (query.to) {
      clauses.push("at < ?");
      params.push(parseInstant(query.to, "to"));
    }
    return { sql: clauses.join(" AND "), params };
  }

  query(query: HealthQuery): HealthSample[] {
    const { sql, params } = this.where(query);
    const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
    const rows = this.prepare(`SELECT * FROM health_samples WHERE ${sql} ORDER BY at ASC, metric ASC LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toSample(row));
  }

  private toSample(row: Record<string, unknown>): HealthSample {
    return healthSampleSchema.parse({
      sampleId: String(row.sample_id),
      metric: String(row.metric),
      value: Number(row.value),
      unit: String(row.unit),
      at: new Date(Number(row.at)).toISOString(),
      ...(row.ended_at === null ? {} : { endedAt: new Date(Number(row.ended_at)).toISOString() }),
      sourceId: String(row.source_id),
      quality: String(row.quality),
      ...(row.device_id === null ? {} : { deviceId: String(row.device_id) }),
      ...(row.note === null ? {} : { note: String(row.note) }),
      revision: Number(row.revision),
    });
  }

  count(query: HealthQuery): number {
    const { sql, params } = this.where(query);
    const row = this.prepare(`SELECT COUNT(*) AS n FROM health_samples WHERE ${sql}`).get(...params) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Per-metric totals, averages and the latest reading in the range. */
  summaries(query: HealthQuery): HealthMetricSummary[] {
    const { sql, params } = this.where(query);
    const rows = this.prepare(`
      SELECT metric, unit, COUNT(*) AS n, SUM(value) AS total, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max
      FROM health_samples WHERE ${sql} GROUP BY metric ORDER BY metric
    `).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const metric = String(row.metric);
      const latest = this.query({ ...query, metrics: [metric], limit: 1 });
      const previous = this.query({ ...query, metrics: [metric], limit: 5 });
      return {
        metric,
        unit: String(row.unit),
        count: Number(row.n),
        total: round(Number(row.total)),
        avg: round(Number(row.avg)),
        min: round(Number(row.min)),
        max: round(Number(row.max)),
        latest: latest[latest.length - 1] ?? null,
        trend: directionOf(previous.map((sample) => sample.value)),
      };
    });
  }

  /** A bucketed series: summed for count-like metrics, averaged otherwise. */
  series(metric: string, query: HealthQuery, bucket: HealthBucket): HealthSeries {
    const samples = this.query({ ...query, metrics: [metric], limit: 100_000 });
    const buckets = new Map<number, number[]>();
    for (const sample of samples) {
      const key = bucketStart(Date.parse(sample.at), bucket);
      const list = buckets.get(key);
      if (list) list.push(sample.value);
      else buckets.set(key, [sample.value]);
    }
    const aggregation = healthAggregationOf(metric);
    const points = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(-2_000)
      .map(([at, values]) => ({
        bucket: new Date(at).toISOString(),
        value: round(aggregation === "sum" ? values.reduce((sum, value) => sum + value, 0) : values.reduce((sum, value) => sum + value, 0) / values.length),
        n: values.length,
        min: round(Math.min(...values)),
        max: round(Math.max(...values)),
      }));
    return { metric, unit: healthUnitOf(metric), bucket, aggregation, points };
  }

  trend(metric: string, query: HealthQuery): HealthTrend {
    const samples = this.query({ ...query, metrics: [metric], limit: 100_000 });
    const values = samples.map((sample) => sample.value);
    const base = { metric, unit: healthUnitOf(metric), count: values.length, latest: samples[samples.length - 1] ?? null };
    if (values.length === 0) return { ...base, direction: "unknown", reason: "no_samples" };
    if (values.length === 1) return { ...base, direction: "unknown", reason: "single_sample", min: round(values[0]!), max: round(values[0]!) };
    const half = Math.floor(values.length / 2);
    const earlier = average(values.slice(0, half));
    const recent = average(values.slice(half));
    const change = recent - earlier;
    const flat = Math.abs(change) < Math.max(0.01, Math.abs(earlier) * 0.02);
    return {
      ...base,
      direction: flat ? "flat" : change > 0 ? "up" : "down",
      change: round(change),
      changePct: earlier === 0 ? 0 : round((change / Math.abs(earlier)) * 100),
      min: round(Math.min(...values)),
      max: round(Math.max(...values)),
    };
  }

  /** Deletes by sample id, or every sample of one source; returns how many rows went. */
  remove(selector: { sampleIds?: readonly string[]; sourceId?: string }): number {
    if (selector.sampleIds?.length) {
      const statement = this.prepare("DELETE FROM health_samples WHERE sample_id = ?");
      let removed = 0;
      for (const id of selector.sampleIds) removed += Number(statement.run(id).changes);
      return removed;
    }
    if (selector.sourceId) {
      const removed = Number(this.prepare("DELETE FROM health_samples WHERE source_id = ?").run(selector.sourceId).changes);
      this.prepare("DELETE FROM health_sources WHERE source_id = ?").run(selector.sourceId);
      return removed;
    }
    return 0;
  }

  /** Everything the /health view needs in one round trip. */
  overview(range: { from: string; to: string }, metrics?: readonly string[], bucket: HealthBucket = "day") {
    const query: HealthQuery = { from: range.from, to: range.to, ...(metrics?.length ? { metrics: [...metrics] } : {}) };
    const summaries = this.summaries(query);
    return {
      range,
      summaries,
      series: summaries.slice(0, 32).map((summary) => this.series(summary.metric, query, bucket)),
      sources: this.sources(),
      sampleCount: this.count(query),
    };
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function directionOf(values: readonly number[]): HealthTrend["direction"] {
  if (values.length < 2) return "unknown";
  const half = Math.floor(values.length / 2);
  const change = average(values.slice(half)) - average(values.slice(0, half));
  return Math.abs(change) < Math.max(0.01, Math.abs(average(values.slice(0, half))) * 0.02) ? "flat" : change > 0 ? "up" : "down";
}
