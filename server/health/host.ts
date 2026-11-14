// The health domain's per-turn pieces and its HTTP surface, wired once by server/index.ts. It owns the store,
// decides whose health a turn may read, and mounts the internal MCP route. Nothing here imports the home domain.
import type { Audience } from "../audience.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createHealthRoutes } from "../routes/health.ts";
import { createHealthCloudRoutes } from "../routes/health-cloud.ts";
import type { RouteHandler } from "../routes/table.ts";
import { PASS } from "../routes/table.ts";
import type { PromptPart } from "../system-prompt.ts";
import { HEALTH_INTERNAL_MCP_PATH, healthRpc, type HealthToolsList } from "./rpc.ts";
import { HEALTH_INSTRUCTIONS, HEALTH_TOOLS, type HealthToolResult } from "./tools.ts";
import { HealthStore } from "./store.ts";
import { HealthCloudStore } from "./cloud-store.ts";
import { HealthOAuthManager, type HealthOAuthProvider } from "./adapters/oauth.ts";
import { mayReadHealth, type HealthOwner } from "./audience.ts";

export const HEALTH_MCP_SERVER = "health";

type Turn = { botId: string; threadId: string; generation: string };

export interface HealthHostDeps {
  dataDir: string;
  /** The person whose health this server holds; null on a shared workspace where nobody's health is anyone's. */
  owner(): HealthOwner | null;
  /** The audience of a thread, and the person a member thread belongs to. */
  audienceOf(threadId: string): Audience;
  /** The person key a thread acts for, when it acts for one. */
  personOf(threadId: string): string | null;
  /** Whether a turn may use health at all: off when the person turned health tools off for this bot. */
  botAllows(botId: string): boolean;
  /** A turn that is still live: the capability's generation is the thread's current one. */
  active(turn: Turn): boolean;
  ownerOrAdmin(auth: RequestAuth): boolean;
  /** Asks the person to confirm deleting these readings. Defaults to refusing. */
  confirmDelete?(turn: Turn, sampleIds: readonly string[]): Promise<boolean>;
  /** Mints the turn's internal capability; the token never leaves this process. */
  mint(turn: Turn): string;
  harnessUrl: string;
  /** The cloud source a person configured, with the app they registered for it. */
  cloudApp?(sourceId: string): { provider: HealthOAuthProvider; clientId: string; clientSecret?: string } | null;
  now?: () => string;
}

export interface HealthHost {
  store: HealthStore;
  routes: RouteHandler;
  /** What a turn mounts, or null when health is not this turn's to use. */
  integration(turn: Turn, botId: string): { command: string; args: string[]; env: Record<string, string> } | null;
  /** The prompt part, empty when the turn may not read health. */
  parts(turn: Turn, botId: string): PromptPart[];
  /** Why a turn that could have health cannot, so the bot says so instead of guessing. */
  withheld(turn: Turn, botId: string): string;
  /**
   * The last week's state in one line, for a scheduled check that has to judge the present: a routine that
   * watches sleep needs today's sleep, not a tool call to go and look. Empty when health is not this turn's.
   */
  nowFor(turn: Turn): string;
  handle(body: unknown, capability: Turn & { botId: string }, assertActive: () => void): Promise<HealthToolsList | HealthToolResult>;
  /** The HEALTH_* names for the per-bot tool grants picker. */
  toolListing(): Array<{ name: string; description: string }>;
  dispose(): void;
}

const NOT_YOURS = "Health readings belong to the person whose they are, and this conversation is not theirs.";
const TURN_OVER = "This turn is no longer running, so its health data is out of reach.";

export function createHealthHost(deps: HealthHostDeps): HealthHost {
  const store = new HealthStore({ dataDir: deps.dataDir, ...(deps.now ? { now: deps.now } : {}) });
  const cloud = new HealthCloudStore({ dataDir: deps.dataDir });
  const oauth = new HealthOAuthManager();

  /** Whether this turn may read the store, decided from the live thread every call. */
  function reach(turn: Turn): { ok: true } | { ok: false; text: string } {
    if (!deps.active(turn)) return { ok: false, text: TURN_OVER };
    const owner = deps.owner();
    if (owner === null) return { ok: false, text: NOT_YOURS };
    const verdict = mayReadHealth(owner, deps.audienceOf(turn.threadId), deps.personOf(turn.threadId));
    return verdict.ok ? { ok: true } : { ok: false, text: verdict.message };
  }

  const mayUse = (turn: Turn, botId: string) => deps.botAllows(botId) && reach(turn).ok;

  return {
    store,
    // Two route handlers, one domain: the readings surface and the cloud sign-in surface.
    routes: async (ctx) => {
      const records = await createHealthRoutes({ store, mayManage: deps.ownerOrAdmin, ...(deps.now ? { now: deps.now } : {}) })(ctx);
      if (records !== PASS) return records;
      return createHealthCloudRoutes({
        store,
        cloud,
        oauth,
        app: (sourceId) => deps.cloudApp?.(sourceId) ?? null,
        mayManage: deps.ownerOrAdmin,
        ...(deps.now ? { now: deps.now } : {}),
      })(ctx);
    },

    integration(turn, botId) {
      if (!mayUse(turn, botId)) return null;
      return {
        command: process.execPath,
        args: [SPAWNED_PROXIES.harnessMcp, HEALTH_MCP_SERVER],
        env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("health")]: deps.mint(turn), EAC_HARNESS_URL: deps.harnessUrl },
      };
    },

    parts(turn, botId) {
      if (!mayUse(turn, botId)) return [];
      const sources = store.sources();
      const lines = [HEALTH_INSTRUCTIONS];
      if (sources.length) {
        lines.push(`Health sources: ${sources.map((source) => `${source.label} (${source.sampleCount} readings${source.lastSyncAt ? `, last synced ${source.lastSyncAt}` : ""})`).join("; ")}.`);
      } else {
        lines.push("No health readings are stored yet; record one with HEALTH_LOG when the person mentions a measurement.");
      }
      return [{ id: "health", label: "Health", text: lines.join(" ") }];
    },

    withheld(turn, botId) {
      if (deps.botAllows(botId) || !deps.active(turn)) return "";
      return "This bot's health tools are off, so you cannot read or record health readings in this conversation.";
    },

    nowFor(turn) {
      if (!deps.active(turn) || !reach(turn).ok) return "";
      const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const summaries = store.summaries({ from, to: new Date().toISOString() });
      if (!summaries.length) return "";
      return `Health, last 7 days: ${summaries.map((summary) => `${summary.metric} ${summary.avg} ${summary.unit} (${summary.count} readings, ${summary.trend})`).join("; ")}.`;
    },

    toolListing: () => HEALTH_TOOLS.map(({ name, description }) => ({ name, description })),

    async handle(body, capability, assertActive) {
      const turn = { botId: capability.botId, threadId: capability.threadId, generation: capability.generation };
      return healthRpc(body as { method?: unknown; params?: unknown }, {
        store,
        assertActive,
        allowed: (name) => {
          if (!deps.botAllows(capability.botId)) return false;
          if (!reach(turn).ok) return false;
          // Deleting is the one tool that needs the person to agree; without a confirm handler it is not offered.
          return name !== "HEALTH_DELETE" || Boolean(deps.confirmDelete);
        },
        authorize: (name) => {
          if (!deps.botAllows(capability.botId)) return { ok: false, text: "This bot's health tools are off." };
          const verdict = reach(turn);
          if (!verdict.ok) return { ok: false, text: verdict.text };
          if (name === "HEALTH_DELETE" && !deps.confirmDelete) return { ok: false, text: "Deleting health readings needs the person's confirmation, and this conversation has no way to ask." };
          return { ok: true };
        },
        ...(deps.confirmDelete ? { confirmDelete: (ids) => deps.confirmDelete!(turn, ids) } : {}),
      });
    },

    dispose: () => {
      oauth.dispose();
      store.close();
    },
  };
}

export { HEALTH_INTERNAL_MCP_PATH };
