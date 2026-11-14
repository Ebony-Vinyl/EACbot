// The home domain wired once by server/index.ts: the registry of adapters, the audit trail, the per-turn policy
// and the internal MCP route. Adapters are built from config.json; this file is the only place that knows which
// adapter kinds exist, so adding a vendor touches one switch here and one file beside it.
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createHomeRoutes } from "../routes/home.ts";
import type { RouteHandler } from "../routes/table.ts";
import type { PromptPart } from "../system-prompt.ts";
import { HomeAudit } from "./audit.ts";
import { HomeRegistry } from "./registry.ts";
import type { HomeAccessLevel, HomePolicy } from "./policy.ts";
import { HOME_INTERNAL_MCP_PATH, homeRpc, type HomeToolsList } from "./rpc.ts";
import { HOME_INSTRUCTIONS, HOME_TOOLS, type HomeToolResult } from "./tools.ts";
import { homeAssistantAdapter } from "./adapters/home-assistant.ts";
import { matterAdapter } from "./adapters/matter.ts";
import type { HomeAdapter, HomeCommand, HomeEntity } from "../../shared/home.ts";
import { join } from "node:path";

export const HOME_MCP_SERVER = "home";

type Turn = { botId: string; threadId: string; generation: string };

/** `home` in config.json: which adapters exist and what a bot may do with them. */
export interface HomeConfig {
  adapters?: ReadonlyArray<
    | { kind: "home-assistant"; baseUrl: string; token: string; label?: string; exclude?: string[] }
    | { kind: "matter"; label?: string; nodes?: ReadonlyArray<{ nodeId: string; name?: string; zone?: string }> }
  >;
  /** The default for bots that do not set their own. */
  botAccess?: HomeAccessLevel;
}

export interface HomeHostDeps {
  dataDir: string;
  config(): HomeConfig | undefined;
  /** One bot's home policy; absent means the config default at `read`. */
  botPolicy(botId: string): HomePolicy | null;
  active(turn: Turn): boolean;
  ownerOrAdmin(auth: RequestAuth): boolean;
  mint(turn: Turn): string;
  harnessUrl: string;
  /** Asks the person to approve a sensitive command on this turn. */
  confirm?(turn: Turn, command: HomeCommand, entity: HomeEntity): Promise<boolean>;
  now?: () => string;
}

export interface HomeHost {
  registry: HomeRegistry;
  audit: HomeAudit;
  routes: RouteHandler;
  /** Rebuilds the adapters from config; called when config.json changes. */
  reload(): void;
  integration(turn: Turn): { command: string; args: string[]; env: Record<string, string> } | null;
  parts(turn: Turn, botId: string): PromptPart[];
  withheld(turn: Turn, botId: string): string;
  /** The home's present state in one line, for a scheduled check that has to judge it. Empty when off. */
  nowFor(turn: Turn): Promise<string>;
  handle(body: unknown, capability: Turn, assertActive: () => void): Promise<HomeToolsList | HomeToolResult>;
  toolListing(): Array<{ name: string; description: string }>;
  dispose(): Promise<void>;
}

/** Builds the adapters a config names. One entry per adapter kind; a new vendor is a new case and a new file. */
export function adaptersFrom(config: HomeConfig | undefined, dataDir: string): HomeAdapter[] {
  const adapters: HomeAdapter[] = [];
  for (const entry of config?.adapters ?? []) {
    if (entry.kind === "home-assistant" && entry.baseUrl && entry.token) {
      adapters.push(homeAssistantAdapter({
        baseUrl: entry.baseUrl,
        token: entry.token,
        ...(entry.label ? { label: entry.label } : {}),
        ...(entry.exclude ? { exclude: entry.exclude } : {}),
      }));
      continue;
    }
    if (entry.kind === "matter") {
      // The controller's fabric lives in its own directory, so a reload never picks up a half-written node store.
      adapters.push(matterAdapter({
        dataDir: join(dataDir, "matter"),
        ...(entry.label ? { label: entry.label } : {}),
        ...(entry.nodes ? { nodes: entry.nodes } : {}),
      }));
    }
  }
  return adapters;
}

export function createHomeHost(deps: HomeHostDeps): HomeHost {
  const audit = new HomeAudit({ dataDir: deps.dataDir, ...(deps.now ? { now: deps.now } : {}) });
  let registry = new HomeRegistry({ adapters: adaptersFrom(deps.config(), deps.dataDir), ...(deps.now ? { now: deps.now } : {}) });

  const policyFor = (botId: string): HomePolicy => deps.botPolicy(botId) ?? { access: deps.config()?.botAccess ?? "read", canConfirmSensitive: false };

  return {
    get registry() {
      return registry;
    },
    audit,
    routes: createHomeRoutes({
      get registry() {
        return registry;
      },
      audit,
      mayManage: deps.ownerOrAdmin,
      // The view is the person at their own computer: full access, with the request's own confirm for a sensitive action.
      policy: () => ({ access: "full", canConfirmSensitive: true }),
      pair: async (input) => {
        const adapter = registry.adapter("matter");
        if (!adapter) throw new Error("no Matter adapter is configured");
        const pairing = adapter as unknown as { pair?(options: typeof input): Promise<{ nodeId: string }> };
        if (!pairing.pair) throw new Error("this build cannot pair Matter devices");
        return pairing.pair(input);
      },
    }),

    reload() {
      void registry.dispose();
      registry = new HomeRegistry({ adapters: adaptersFrom(deps.config(), deps.dataDir), ...(deps.now ? { now: deps.now } : {}) });
    },

    integration(turn) {
      if (!deps.active(turn) || policyFor(turn.botId).access === "off") return null;
      return {
        command: process.execPath,
        args: [SPAWNED_PROXIES.harnessMcp, HOME_MCP_SERVER],
        env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("home")]: deps.mint(turn), EAC_HARNESS_URL: deps.harnessUrl },
      };
    },

    parts(turn, botId) {
      if (!deps.active(turn)) return [];
      const policy = policyFor(botId);
      if (policy.access === "off") return [];
      const lines = [HOME_INSTRUCTIONS, `Your home access is "${policy.access}".`];
      if (policy.zones?.length) lines.push(`You may touch only these zones: ${policy.zones.join(", ")}.`);
      return [{ id: "home", label: "Home", text: lines.join(" ") }];
    },

    withheld(turn, botId) {
      if (!deps.active(turn) || policyFor(botId).access !== "off") return "";
      return "This bot's home access is off, so you cannot read or change the home's devices here.";
    },

    async nowFor(turn) {
      if (!deps.active(turn) || policyFor(turn.botId).access === "off") return "";
      const snapshot = await registry.snapshot();
      const on = snapshot.entities.filter((entity) => entity.state === "on" || entity.state === "open");
      const away = snapshot.entities.filter((entity) => !entity.available);
      if (!snapshot.entities.length) return "";
      const parts = [`Home: ${snapshot.entities.length} devices across ${snapshot.zones.length} zones, ${on.length} on`];
      if (on.length) parts.push(`on now: ${on.slice(0, 12).map((entity) => entity.name).join(", ")}${on.length > 12 ? ", …" : ""}`);
      if (away.length) parts.push(`${away.length} unreachable`);
      return `${parts.join("; ")}.`;
    },

    toolListing: () => HOME_TOOLS.map(({ name, description }) => ({ name, description })),

    async handle(body, capability, assertActive) {
      const turn = { botId: capability.botId, threadId: capability.threadId, generation: capability.generation };
      return homeRpc(body as { method?: unknown; params?: unknown }, {
        registry,
        audit,
        policy: () => policyFor(capability.botId),
        assertActive,
        allowed: (name) => {
          if (!deps.active(turn)) return false;
          const policy = policyFor(capability.botId);
          if (policy.access === "off") return false;
          if (name === "HOME_CONTROL") return policy.access !== "read";
          return true;
        },
        actor: () => ({ id: `bot:${capability.botId}`, threadId: capability.threadId }),
        ...(deps.confirm ? { confirm: (command, entity) => deps.confirm!(turn, command, entity) } : {}),
      });
    },

    dispose: () => registry.dispose(),
  };
}

export { HOME_INTERNAL_MCP_PATH };
