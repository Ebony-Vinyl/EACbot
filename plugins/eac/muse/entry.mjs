// eac.muse — music for EACbot: Kugou public search plus a revision-checked playback state.
// The state lives in this work directory; a player client (the KugouMusic.NET bridge or a panel) reads it with
// muse-now-playing and reports real receipts with muse-report-playback. A control request without a connected
// player stays "requested": nothing here ever claims a song played.
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult, shutdown -> exit.
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STORE = join(process.cwd(), "muse-state.json");
const DEFAULT_SEARCH_API = "https://songsearch.kugou.com/song/search/v2";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_QUEUE = 200;

class ToolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function emptyState() { return { schemaVersion: 1, revision: 1, current: null, playing: false, volume: null, queue: [], lastRequest: null, lastReceipt: null, changedAt: new Date().toISOString() }; }

function loadConfig() {
  const file = join(process.cwd(), "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    throw new ToolError("bad-config", "config.json is not valid JSON", false);
  }
}

function loadState() {
  if (!existsSync(STORE)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(STORE, "utf8"));
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.queue)) return emptyState();
    return { ...emptyState(), ...parsed };
  } catch {
    throw new ToolError("store-corrupt", "muse-state.json is not valid JSON", false);
  }
}

function saveState(state) {
  mkdirSync(dirname(STORE), { recursive: true, mode: 0o700 });
  const tmp = `${STORE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STORE);
}

function snapshot(state) {
  return {
    revision: state.revision,
    current: state.current,
    playing: state.playing,
    volume: state.volume,
    queue: state.queue,
    lastRequest: state.lastRequest,
    lastReceipt: state.lastReceipt,
    playbackConfirmed: state.lastReceipt?.revision === state.revision && state.lastReceipt.state !== "failed",
    changedAt: state.changedAt,
  };
}

function checkRevision(state, expected) {
  if (expected === undefined) return;
  if (!Number.isInteger(expected)) throw new ToolError("invalid-revision", "expectedRevision must be an integer", false);
  if (expected !== state.revision) {
    throw new ToolError("stale-revision", `the playback state moved on (now revision ${state.revision}, you sent ${expected}); call muse-now-playing and redo the request against the fresh snapshot`, false);
  }
}

function searchApi() {
  return String(loadConfig().apiBase ?? DEFAULT_SEARCH_API);
}

function searchKugou(keyword, page) {
  return fetch(`${searchApi()}?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=20`, {
    headers: { "user-agent": UA, referer: "https://www.kugou.com/" },
    signal: AbortSignal.timeout(12_000),
  }).then(async (response) => {
    if (response.status === 403 || response.status === 412) throw new ToolError("risk-control", "the Kugou search endpoint refused this request (region or rate limit); the public search interface is not a contract and may be unavailable", true);
    if (!response.ok) throw new ToolError("server", `Kugou search returned ${response.status}`, true);
    const payload = await response.json();
    const rows = payload?.data?.lists ?? [];
    return rows.map((row) => ({
      hash: row.FileHash ?? row.filehash ?? null,
      albumId: row.AlbumID ?? row.albumid ?? null,
      title: row.SongName ? String(row.SongName).replace(/<[^>]+>/g, "") : row.SongName,
      singer: row.SingerName ?? null,
      album: row.AlbumName ?? null,
      duration_seconds: row.Duration ?? null,
      vip: (row.PayType ?? 0) !== 0 ? "likely" : "unknown",
    })).filter((row) => row.hash && row.title);
  }, (error) => {
    const cause = error?.cause?.code ?? error?.name;
    throw new ToolError("unreachable", `Kugou is unreachable (${String(cause).slice(0, 60)})`, true);
  });
}

function trackFromArgs(args) {
  const track = args.track && typeof args.track === "object" ? args.track : null;
  const hash = String(track?.hash ?? args.hash ?? "").trim();
  if (!hash) throw new ToolError("invalid-track", "a track from muse-search (with hash) is required", false);
  return {
    hash,
    albumId: track?.albumId ?? null,
    title: String(track?.title ?? args.title ?? "").trim().slice(0, 200) || hash.slice(0, 12),
    singer: track?.singer ? String(track.singer).slice(0, 200) : null,
    vip: track?.vip ?? "unknown",
  };
}

const TOOLS = {
  "muse-search": async (args) => {
    const keyword = String(args.keyword ?? "").trim();
    if (!keyword) throw new ToolError("invalid-keyword", "keyword is required", false);
    const page = Math.max(Number(args.page) > 0 ? Number(args.page) : 1, 1);
    const tracks = await searchKugou(keyword, page);
    return { keyword, page, count: tracks.length, tracks };
  },

  "muse-now-playing": async () => snapshot(loadState()),

  "muse-queue": async () => {
    const state = loadState();
    return { revision: state.revision, count: state.queue.length, queue: state.queue, current: state.current };
  },

  "muse-play-control": async (args) => {
    const action = String(args.action ?? "").trim();
    if (!["play", "pause", "resume", "next", "prev", "seek", "volume"].includes(action)) {
      throw new ToolError("invalid-action", "action must be one of play|pause|resume|next|prev|seek|volume", false);
    }
    const state = loadState();
    checkRevision(state, args.expectedRevision);
    if (action === "seek" && !Number.isFinite(Number(args.positionSeconds))) throw new ToolError("invalid-args", "seek needs positionSeconds", false);
    if (action === "volume" && (!Number.isFinite(Number(args.volume)) || Number(args.volume) < 0 || Number(args.volume) > 100)) throw new ToolError("invalid-args", "volume must be 0-100", false);
    if ((action === "next" || action === "prev") && state.queue.length < 2) throw new ToolError("empty-queue", "the queue needs at least two tracks to switch", false);
    if (action === "play" && !state.current) throw new ToolError("empty-queue", "nothing is queued; add a track with muse-queue-edit first", false);
    state.revision += 1;
    state.lastRequest = { kind: "control", action, revision: state.revision, at: new Date().toISOString(), ...(action === "seek" ? { positionSeconds: Number(args.positionSeconds) } : {}), ...(action === "volume" ? { volume: Number(args.volume) } : {}) };
    if (action === "volume") state.volume = Number(args.volume);
    if (action === "pause") state.playing = false;
    if (action === "resume" || action === "play") state.playing = state.lastReceipt?.revision === state.revision ? state.lastReceipt.state === "playing" : state.playing;
    if (action === "next") { state.current = state.queue[1] ?? state.current; state.queue = state.queue.slice(1); }
    if (action === "prev") { state.playing = true; }
    state.changedAt = new Date().toISOString();
    saveState(state);
    return { ...snapshot(state), requested: action, playbackConfirmed: false, note: "recorded; a real receipt comes from the connected player via muse-report-playback" };
  },

  "muse-queue-edit": async (args) => {
    const action = String(args.action ?? "").trim();
    if (!["add", "remove", "clear"].includes(action)) throw new ToolError("invalid-action", "action must be one of add|remove|clear", false);
    const state = loadState();
    checkRevision(state, args.expectedRevision);
    if (action === "add") {
      const track = trackFromArgs(args);
      if (state.queue.some((row) => row.hash === track.hash)) throw new ToolError("duplicate", "this track is already in the queue; reuse the existing entry instead of adding it twice", false);
      if (state.queue.length >= MAX_QUEUE) throw new ToolError("queue-full", `the queue holds at most ${MAX_QUEUE} tracks`, false);
      state.queue.push({ ...track, queueItemId: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` });
      if (!state.current) state.current = state.queue[0] ?? null;
    }
    if (action === "remove") {
      const queueItemId = String(args.queueItemId ?? "").trim();
      const kept = state.queue.filter((row) => row.queueItemId !== queueItemId);
      if (kept.length === state.queue.length) throw new ToolError("not-found", `no queue item ${queueItemId.slice(0, 60)}`, false);
      state.queue = kept;
    }
    if (action === "clear") state.queue = [];
    state.revision += 1;
    state.changedAt = new Date().toISOString();
    saveState(state);
    return snapshot(state);
  },

  "muse-report-playback": async (args) => {
    const state = String(args.state ?? "").trim();
    if (!["playing", "paused", "ended", "failed", "buffering"].includes(state)) throw new ToolError("invalid-state", "state must be one of playing|paused|ended|failed|buffering", false);
    const current = loadState();
    const revision = Number(args.revision ?? current.revision);
    if (!Number.isInteger(revision) || revision < 1 || revision > current.revision) throw new ToolError("invalid-revision", "revision must be the snapshot revision the player acts on", false);
    current.revision += 1;
    current.playing = state === "playing" || state === "buffering";
    if (state === "ended") {
      current.queue = current.queue.slice(1);
      current.current = current.queue[0] ?? null;
    }
    if (state === "failed") current.playing = false;
    current.lastReceipt = { state, revision, at: new Date().toISOString(), ...(typeof args.detail === "string" ? { detail: args.detail.slice(0, 300) } : {}) };
    current.changedAt = new Date().toISOString();
    saveState(current);
    return snapshot(current);
  },
};

function result(value) {
  return { status: "succeeded", value };
}

function failure(error) {
  if (error instanceof ToolError) return { status: "failed", code: error.code, message: error.message.slice(0, 2000), retryable: error.retryable };
  return { status: "failed", code: "internal", message: String(error instanceof Error ? error.message : error).slice(0, 2000), retryable: false };
}

function answer(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (text) => {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  if (!frame || typeof frame !== "object" || frame.id === undefined || frame.id === null) return;
  if (frame.method === "initialize") { answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.muse" }); return; }
  if (frame.method === "shutdown") { answer(frame.id, { ok: true }); process.exit(0); }
  if (frame.method !== "tools/call") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } })}\n`); return; }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) { answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false }); return; }
  Promise.resolve(tool(params.arguments ?? {})).then(result, failure).then((value) => answer(frame.id, value));
});
