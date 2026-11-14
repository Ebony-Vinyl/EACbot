/** Native model catalogs. Each probe asks the engine itself and reports what it actually
 * answered; an engine whose catalog cannot be read says so rather than returning a guess.
 *
 * A catalog is either `reported` (the engine listed these) or `unknown` (with the reason). The
 * `unknown` case is a first-class answer, not an empty list, because an empty list would read as
 * "this engine has no models". */

import type { AgentId } from "./contracts.ts";
import type { ModelBilling, ModelOption } from "./models.ts";
import { readJsonl } from "./transport/jsonl.ts";
import type { FetchLike, SpawnFn } from "./transport/types.ts";
import { agentDescriptor } from "./registry.ts";
import { readModels } from "./adapters/opencode/codec.ts";

export type ModelCatalogReading =
  | { state: "reported"; agentId: AgentId; options: ModelOption[]; defaultId: string | null }
  | { state: "unknown"; agentId: AgentId; reason: string };

export interface CatalogProbeOptions {
  agentId: AgentId;
  spawn?: SpawnFn;
  fetch?: FetchLike;
  env: Record<string, string>;
  /** A CLI agent's executable, when it differs from the descriptor. */
  cli?: string;
  /** An HTTP agent's server URL. */
  baseUrl?: string;
  token?: string;
  billing: ModelBilling;
  timeoutMs?: number;
}

/** Reads the engine's own catalog. Never throws for a missing engine: a failed probe is an
 * `unknown` reading carrying why. */
export async function probeModelCatalog(options: CatalogProbeOptions): Promise<ModelCatalogReading> {
  switch (options.agentId) {
    case "pi":
    case "ohMyPi":
      return probeJsonlCatalog(options);
    case "openCode":
      return probeOpenCodeCatalog(options);
    case "codex":
      return probeCodexCatalog(options);
    case "hermes":
      return probeHermesCatalog(options);
    case "claudeCode":
      // Claude Code's stream-json surface has no catalog method; its model choice is the CLI's own
      // `--model` value, which the caller supplies. Declared unknown rather than guessed.
      return {
        state: "unknown",
        agentId: options.agentId,
        reason: "Claude Code's stream-json mode reports no model catalog; the model is passed as --model",
      };
    case "custom":
      return {
        state: "unknown",
        agentId: options.agentId,
        reason: "an ACP agent's catalog is whatever it advertises at initialize, which this probe does not open a session to read",
      };
    default: {
      const exhaustive: never = options.agentId;
      return { state: "unknown", agentId: exhaustive, reason: "no catalog probe" };
    }
  }
}

/** `get_available_models` over the JSONL RPC: `{ models: [{ provider, id, name? }] }`. */
function probeJsonlCatalog(options: CatalogProbeOptions): Promise<ModelCatalogReading> {
  const descriptor = agentDescriptor(options.agentId);
  const cli = options.cli ?? descriptor.cli;
  if (!cli || !options.spawn) {
    return Promise.resolve({ state: "unknown", agentId: options.agentId, reason: "no executable to probe" });
  }
  return new Promise<ModelCatalogReading>((resolve) => {
    let child;
    try {
      child = options.spawn!(cli, ["--mode", "rpc", "--no-session"], {
        env: { ...options.env, ...(descriptor.homeEnv ? { [descriptor.homeEnv]: options.env.HOME ?? "" } : {}) },
      });
    } catch (error) {
      resolve({ state: "unknown", agentId: options.agentId, reason: (error as Error).message });
      return;
    }
    let settled = false;
    const finish = (reading: ModelCatalogReading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      resolve(reading);
    };
    const timer = setTimeout(() => {
      finish({ state: "unknown", agentId: options.agentId, reason: "the catalog probe timed out" });
    }, options.timeoutMs ?? 15_000);
    timer.unref?.();

    readJsonl(child.stdout, (frame) => {
      if (frame.type !== "response" || frame.command !== "get_available_models") return;
      if (frame.success !== true) {
        finish({ state: "unknown", agentId: options.agentId, reason: "the engine refused get_available_models" });
        return;
      }
      const rows = (frame.data as { models?: unknown } | undefined)?.models;
      if (!Array.isArray(rows)) {
        finish({ state: "unknown", agentId: options.agentId, reason: "the engine answered without a models list" });
        return;
      }
      const options2: ModelOption[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const entry = row as { provider?: unknown; id?: unknown; name?: unknown };
        if (typeof entry.provider !== "string" || !entry.provider || typeof entry.id !== "string" || !entry.id) continue;
        options2.push({
          ref: { providerId: entry.provider, modelId: entry.id },
          label: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
          billing: options.billing,
          providerId: entry.provider,
        });
      }
      finish({ state: "reported", agentId: options.agentId, options: options2, defaultId: options2[0] ? `${options2[0].ref.providerId}/${options2[0].ref.modelId}` : null });
    });
    child.on("error", (error) => finish({ state: "unknown", agentId: options.agentId, reason: error.message }));
    child.on("exit", () => {
      finish({ state: "unknown", agentId: options.agentId, reason: "the engine exited before answering" });
    });
    try {
      child.stdin?.write(`${JSON.stringify({ id: "catalog", type: "get_available_models" })}\n`);
    } catch (error) {
      finish({ state: "unknown", agentId: options.agentId, reason: (error as Error).message });
    }
  });
}

/** `GET /api/model` (V2): `{ location, data: Model.Info[] }`. */
async function probeOpenCodeCatalog(options: CatalogProbeOptions): Promise<ModelCatalogReading> {
  if (!options.baseUrl || !options.fetch) {
    return { state: "unknown", agentId: options.agentId, reason: "no server URL to probe" };
  }
  try {
    const response = await options.fetch(`${options.baseUrl}/api/model`, {
      headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    });
    if (!response.ok) {
      return { state: "unknown", agentId: options.agentId, reason: `GET /api/model answered ${response.status}` };
    }
    const rows = readModels(await response.json());
    if (!rows.length) {
      return { state: "unknown", agentId: options.agentId, reason: "the server listed no models" };
    }
    const models: ModelOption[] = rows
      .filter((row) => row.enabled)
      .map((row) => ({
        ref: { providerId: row.ref.providerId, modelId: row.ref.modelId },
        label: row.label,
        billing: options.billing,
        providerId: row.ref.providerId,
      }));
    return { state: "reported", agentId: options.agentId, options: models, defaultId: null };
  } catch (error) {
    return { state: "unknown", agentId: options.agentId, reason: (error as Error).message };
  }
}

/** `model/list` over the app-server, paged by `nextCursor`. */
function probeCodexCatalog(options: CatalogProbeOptions): Promise<ModelCatalogReading> {
  const cli = options.cli ?? agentDescriptor("codex").cli;
  if (!cli || !options.spawn) {
    return Promise.resolve({ state: "unknown", agentId: options.agentId, reason: "no executable to probe" });
  }
  return new Promise<ModelCatalogReading>((resolve) => {
    let child;
    try {
      child = options.spawn!(cli, ["app-server"], { env: options.env });
    } catch (error) {
      resolve({ state: "unknown", agentId: options.agentId, reason: (error as Error).message });
      return;
    }
    const collected: ModelOption[] = [];
    let nextId = 1;
    let settled = false;
    const finish = (reading: ModelCatalogReading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      resolve(reading);
    };
    const timer = setTimeout(() => {
      finish({ state: "unknown", agentId: options.agentId, reason: "the catalog probe timed out" });
    }, options.timeoutMs ?? 15_000);
    timer.unref?.();
    const send = (payload: Record<string, unknown>) => child.stdin?.write(`${JSON.stringify(payload)}\n`);
    let awaiting: number | null = null;
    const requestPage = (cursor: string | null) => {
      awaiting = nextId++;
      send({ jsonrpc: "2.0", id: awaiting, method: "model/list", params: { limit: 100, ...(cursor ? { cursor } : {}) } });
    };
    readJsonl(child.stdout, (frame) => {
      if (frame.id === 1 && frame.result) {
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        requestPage(null);
        return;
      }
      if (frame.id !== awaiting) return;
      if (frame.error) {
        finish({ state: "unknown", agentId: options.agentId, reason: "the engine refused model/list" });
        return;
      }
      const result = frame.result as { data?: unknown; nextCursor?: unknown } | undefined;
      const rows = Array.isArray(result?.data) ? result!.data : [];
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const entry = row as { id?: unknown; displayName?: unknown; hidden?: unknown };
        if (typeof entry.id !== "string" || !entry.id) continue;
        if (entry.hidden === true) continue;
        collected.push({
          ref: { providerId: "openai", modelId: entry.id },
          label: typeof entry.displayName === "string" && entry.displayName ? entry.displayName : entry.id,
          billing: options.billing,
          providerId: "openai",
        });
      }
      const cursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
      if (cursor) {
        requestPage(cursor);
        return;
      }
      finish({ state: "reported", agentId: options.agentId, options: collected, defaultId: collected[0] ? `openai/${collected[0].ref.modelId}` : null });
    });
    child.on("error", (error) => finish({ state: "unknown", agentId: options.agentId, reason: error.message }));
    child.on("exit", () => finish({ state: "unknown", agentId: options.agentId, reason: "the app-server exited before answering" }));
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "eacbot-core", version: "0" } } });
  });
}

/** Hermes' provider-aware picker inventory, `GET /api/model/options`. `/v1/models` is the
 * OpenAI-compatibility stub and deliberately lists only `hermes-agent`, so it is not used. */
async function probeHermesCatalog(options: CatalogProbeOptions): Promise<ModelCatalogReading> {
  if (!options.baseUrl || !options.fetch || !options.token) {
    return { state: "unknown", agentId: options.agentId, reason: "no authenticated server URL to probe" };
  }
  try {
    const response = await options.fetch(`${options.baseUrl}/api/model/options`, {
      headers: { authorization: `Bearer ${options.token}` },
    });
    if (!response.ok) {
      return { state: "unknown", agentId: options.agentId, reason: `GET /api/model/options answered ${response.status}` };
    }
    const rows = hermesModelRows(await response.json());
    if (!rows.length) {
      return { state: "unknown", agentId: options.agentId, reason: "the server listed no models" };
    }
    return { state: "reported", agentId: options.agentId, options: rows, defaultId: rows[0] ? `${rows[0].ref.providerId}/${rows[0].ref.modelId}` : null };
  } catch (error) {
    return { state: "unknown", agentId: options.agentId, reason: (error as Error).message };
  }
}

/** The picker payload's shape is not pinned by the public docs, so rows are read defensively:
 * only an entry carrying a provider and a model id becomes an option. */
function hermesModelRows(body: unknown): ModelOption[] {
  const candidates = Array.isArray(body) ? body
    : Array.isArray((body as { data?: unknown } | null)?.data) ? (body as { data: unknown[] }).data
    : Array.isArray((body as { models?: unknown } | null)?.models) ? (body as { models: unknown[] }).models
    : [];
  const rows: ModelOption[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const row = candidate as { provider?: unknown; id?: unknown; model?: unknown; name?: unknown; label?: unknown };
    const provider = typeof row.provider === "string" ? row.provider : "";
    const model = typeof row.id === "string" ? row.id : typeof row.model === "string" ? row.model : "";
    if (!provider || !model) continue;
    rows.push({
      ref: { providerId: provider, modelId: model },
      label: typeof row.label === "string" ? row.label : typeof row.name === "string" && row.name ? row.name : model,
      billing: "subscription",
      providerId: provider,
    });
  }
  return rows;
}
