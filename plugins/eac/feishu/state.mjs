import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const EMPTY = () => ({
  schemaVersion: 1,
  inbound: [],
  outbound: {},
  consumer: { state: "stopped", lastError: "", readyAt: "" },
});

export function loadState(file) {
  if (!existsSync(file)) return EMPTY();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("feishu bridge state is not valid JSON; move " + file + " aside to start clean");
  }
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.inbound)) {
    throw new Error("feishu bridge state does not match schema version 1; move " + file + " aside to start clean");
  }
  return { ...EMPTY(), ...parsed, outbound: parsed.outbound && typeof parsed.outbound === "object" ? parsed.outbound : {} };
}

export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + ".tmp";
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, file);
}

export function enqueue(state, item, limit = 500) {
  if (state.inbound.some((entry) => entry.eventId === item.eventId)) return false;
  if (state.inbound.length >= limit) state.inbound.shift();
  state.inbound.push(item);
  return true;
}

export function dueInbound(state, now = Date.now()) {
  return state.inbound.filter((entry) => {
    if (!entry.nextAt) return true;
    const at = Date.parse(entry.nextAt);
    return !Number.isFinite(at) || at <= now;
  });
}

export function removeInbound(state, eventId) {
  state.inbound = state.inbound.filter((entry) => entry.eventId !== eventId);
}
