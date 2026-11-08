// eac.home-assistant — Home Assistant REST API for EACbot. Config: config.json in the work directory
// with { "baseUrl": "http://homeassistant.local:8123", "token": "<long-lived access token>" }.
// Protocol: EACbot plugin host (JSON-RPC over stdio): initialize -> {ok:true}, tools/call -> ActionResult, shutdown -> exit.
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

class ToolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function loadConfig() {
  const file = join(process.cwd(), "config.json");
  if (!existsSync(file)) {
    throw new ToolError("unconfigured", "config.json is missing in this plugin's work directory: add { \"baseUrl\", \"token\" } (a Home Assistant long-lived access token) and restart the plugin", false);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ToolError("bad-config", "config.json is not valid JSON", false);
  }
  const baseUrl = String(parsed.baseUrl ?? "").replace(/\/+$/, "");
  const token = String(parsed.token ?? "");
  if (!/^https?:\/\//.test(baseUrl)) throw new ToolError("bad-config", "config.json needs a http(s) baseUrl", false);
  if (!token) throw new ToolError("bad-config", "config.json needs a Home Assistant access token", false);
  return { baseUrl, token };
}

async function haFetch(path, { method = "GET", body } = {}) {
  const { baseUrl, token } = loadConfig();
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.name;
    if (cause === "TimeoutError") throw new ToolError("timeout", "Home Assistant did not answer within 15 s; it may still be processing", true);
    throw new ToolError("unreachable", `Home Assistant is unreachable (${String(cause).slice(0, 60)})`, true);
  }
  if (response.status === 401) throw new ToolError("auth", "Home Assistant rejected the token; create a new long-lived access token and update config.json", false);
  if (response.status === 404) throw new ToolError("not-found", "no such entity or endpoint", false);
  if (response.status === 400 || response.status === 405) {
    const detail = await response.text().catch(() => "");
    throw new ToolError("bad-request", `Home Assistant refused the call (${response.status}): ${detail.slice(0, 300)}`, false);
  }
  if (response.status >= 500) throw new ToolError("server", `Home Assistant server error (${response.status})`, true);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const ENTITY_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/;

const TOOLS = {
  "ha-get-states": async (args) => {
    const states = await haFetch("/api/states");
    const domain = typeof args.domain === "string" && args.domain.trim() ? args.domain.trim().toLowerCase() : null;
    const search = typeof args.search === "string" && args.search.trim() ? args.search.trim().toLowerCase() : null;
    const limit = Math.min(Number(args.limit) > 0 ? Number(args.limit) : 50, 500);
    const filtered = states.filter((state) => {
      if (domain && !state.entity_id.startsWith(`${domain}.`)) return false;
      if (search && !`${state.entity_id} ${state.attributes?.friendly_name ?? ""}`.toLowerCase().includes(search)) return false;
      return true;
    });
    return {
      count: filtered.length,
      returned: Math.min(filtered.length, limit),
      states: filtered.slice(0, limit).map((state) => ({
        entity_id: state.entity_id,
        state: state.state,
        name: state.attributes?.friendly_name ?? null,
        attributes: state.attributes ?? {},
        last_changed: state.last_changed,
      })),
    };
  },

  "ha-get-state": async (args) => {
    const entityId = String(args.entity_id ?? "").trim();
    if (!ENTITY_PATTERN.test(entityId)) throw new ToolError("invalid-entity", "entity_id must look like light.kitchen", false);
    const state = await haFetch(`/api/states/${encodeURIComponent(entityId)}`);
    return { entity_id: state.entity_id, state: state.state, name: state.attributes?.friendly_name ?? null, attributes: state.attributes ?? {}, last_changed: state.last_changed };
  },

  "ha-get-services": async () => {
    const services = await haFetch("/api/services");
    return services.map((domain) => ({ domain: domain.domain, services: Object.keys(domain.services ?? {}) }));
  },

  "ha-call-service": async (args) => {
    const domain = String(args.domain ?? "").trim().toLowerCase();
    const service = String(args.service ?? "").trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(service)) throw new ToolError("invalid-service", "domain and service must be lowercase identifiers", false);
    const entityId = args.entity_id === undefined ? undefined : String(args.entity_id).trim();
    if (entityId !== undefined && !ENTITY_PATTERN.test(entityId)) throw new ToolError("invalid-entity", "entity_id must look like light.kitchen", false);
    const data = args.data && typeof args.data === "object" && !Array.isArray(args.data) ? args.data : {};
    const result = await haFetch(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
      method: "POST",
      body: entityId ? { entity_id: entityId, ...data } : data,
    });
    const changed = Array.isArray(result) ? result.map((state) => ({ entity_id: state.entity_id, state: state.state })) : [];
    return { called: `${domain}.${service}`, entities: changed };
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
  if (frame.method === "initialize") { answer(frame.id, { ok: true, pluginId: process.env.EAC_PLUGIN_ID ?? "eac.home-assistant" }); return; }
  if (frame.method === "shutdown") { answer(frame.id, { ok: true }); process.exit(0); }
  if (frame.method !== "tools/call") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } })}\n`); return; }
  const params = frame.params ?? {};
  const tool = TOOLS[params.toolId];
  if (!tool) { answer(frame.id, { status: "failed", code: "unknown-tool", message: `no tool ${String(params.toolId).slice(0, 60)}`, retryable: false }); return; }
  Promise.resolve(tool(params.arguments ?? {})).then(result, failure).then((value) => answer(frame.id, value));
});
