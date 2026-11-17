/** Durable mission state. Every table is additive-only where the record is an
 * audit trail; mutable rows carry a revision the caller must present.
 *
 * `runs.control_pending` records a control action whose native effect was
 * never confirmed; it survives a crash so recovery can report it rather than
 * forget a possibly live native session. */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    root_mission_id TEXT NOT NULL,
    parent_mission_id TEXT,
    depth INTEGER NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    agent TEXT NOT NULL,
    model_json TEXT,
    environment_json TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    settled_at TEXT,
    active_run_id TEXT,
    wake_generation INTEGER NOT NULL DEFAULT 0,
    error_json TEXT,
    cancel_reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS missions_root ON missions(root_mission_id)`,
  `CREATE INDEX IF NOT EXISTS missions_parent ON missions(parent_mission_id)`,
  `CREATE INDEX IF NOT EXISTS missions_status ON missions(status)`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id),
    attempt INTEGER NOT NULL,
    agent TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    accepted_command_id TEXT NOT NULL,
    native_session_id TEXT,
    native_started_at TEXT,
    native_completed_at TEXT,
    native_outcome TEXT,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL,
    resume_of_run_id TEXT,
    interrupted_at TEXT,
    resumed_at TEXT,
    last_adapter_seq INTEGER NOT NULL DEFAULT 0,
    control_pending TEXT,
    cancel_accepted_at TEXT,
    reconcile_required_at TEXT,
    error_json TEXT,
    UNIQUE(mission_id, attempt)
  )`,
  `CREATE INDEX IF NOT EXISTS runs_mission ON runs(mission_id)`,
  `CREATE TABLE IF NOT EXISTS mission_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    mission_id TEXT NOT NULL,
    run_id TEXT,
    at TEXT NOT NULL,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    adapter_seq INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS events_run_seq ON mission_events(run_id, adapter_seq) WHERE adapter_seq IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS events_mission ON mission_events(mission_id, seq)`,
  `CREATE TABLE IF NOT EXISTS pending_events (
    run_id TEXT NOT NULL,
    adapter_seq INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY(run_id, adapter_seq)
  )`,
  `CREATE TABLE IF NOT EXISTS commands (
    command_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    expires_at TEXT,
    resolved_at TEXT,
    decided_by TEXT,
    revision INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS approvals_mission ON approvals(mission_id)`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS artifacts_mission ON artifacts(mission_id)`,
  `CREATE TABLE IF NOT EXISTS mission_inbox (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    consumed_at TEXT,
    UNIQUE(mission_id, generation)
  )`,
  `CREATE TABLE IF NOT EXISTS terminals (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed_at TEXT,
    exit_code INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS terminals_mission ON terminals(mission_id)`,
];
