import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { PlatformAccountError, type PlatformAccountStore } from "../plugins/platform-accounts.ts";
import { PlatformOutboxError, type PlatformOutboxStore } from "../plugins/platform-outbox.ts";
import { MemorySpaceError, type MemorySpaceStore } from "../memory-spaces/store.ts";
import type { PlatformAccount } from "../../shared/plugins/accounts.ts";
import { PLATFORM_IDS } from "../../shared/plugins/accounts.ts";
import type { MemoryRequestPrincipal } from "../../shared/plugins/memory-spaces.ts";
import type { PlatformInboundHost } from "../host/platform-inbound.ts";

export interface PlatformRouteBots {
  has(botId: string): boolean;
  bindingOf(botId: string): { accountId: string } | null;
  createDedicated(input: {
    name: string;
    title?: string;
    description?: string;
    platform: PlatformAccount["platform"];
    accountId: string;
  }): string | null;
  bind(botId: string, binding: { platform: PlatformAccount["platform"]; accountId: string; mode: "existing" | "dedicated" } | null): boolean;
  remove(botId: string): boolean;
}

export interface PlatformRouteDeps {
  accounts: PlatformAccountStore;
  memory: MemorySpaceStore;
  bots: PlatformRouteBots;
  mayManage(auth: RequestAuth): boolean;
  /** When present, POST /api/platforms/inbound starts the bound bot's turn and queues its reply. */
  inbound?: PlatformInboundHost;
  /** When present, a bridge lists and acknowledges the bot's replies per account. */
  outbox?: PlatformOutboxStore;
}

const STATUS: Readonly<Record<PlatformAccountError["code"], number>> = {
  invalid: 400,
  duplicate: 409,
  conflict: 409,
  "not-found": 404,
  corrupt: 500,
};

const OUTBOX_STATUS: Readonly<Record<PlatformOutboxError["code"], number>> = {
  invalid: 400,
  "not-found": 404,
  full: 507,
  corrupt: 500,
};

function refused(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof PlatformAccountError) return { status: STATUS[error.code], body: { error: error.message, code: error.code } };
  if (error instanceof MemorySpaceError) {
    const status = error.code === "invalid" ? 400 : error.code === "not-found" ? 404 : error.code === "conflict" ? 409 : error.code === "forbidden" ? 403 : 500;
    return { status, body: { error: error.message, code: error.code } };
  }
  return { status: 500, body: { error: "platform operation failed", code: "internal" } };
}

function accountIdFromPath(path: string, suffix: string): string | null {
  const match = new RegExp(`^/api/platforms/accounts/([0-9a-f-]{36})${suffix}$`).exec(path);
  return match?.[1] ?? null;
}

function revision(query: URLSearchParams): number {
  const value = Number(query.get("revision"));
  return Number.isInteger(value) && value >= 0 ? value : Number.NaN;
}

function ownerPrincipal(query: URLSearchParams): MemoryRequestPrincipal {
  return {
    kind: query.get("principal") === "guest" ? "guest" : "owner",
    personId: query.get("personId")?.slice(0, 200) || "host-owner",
  };
}

/** Platform accounts, inbound routing and shared memory spaces. Every path is owner-only. */
export function createPlatformRoutes(deps: PlatformRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    const platformPath = path === "/api/platforms" || path.startsWith("/api/platforms/");
    const memoryPath = path === "/api/memory-spaces" || path.startsWith("/api/memory-spaces/");
    if (!platformPath && !memoryPath) return PASS;
    if (!deps.mayManage(auth)) return json(res, 403, { error: "Only an owner or administrator can manage platform accounts and shared memory." });
    res.setHeader("Cache-Control", "no-store");

    const body = async (limit = 64 * 1024): Promise<Record<string, unknown>> => {
      try {
        const parsed = await readBody(req, limit);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      } catch (error) {
        throw new PlatformAccountError("invalid", (error as { status?: number }).status === 413 ? "body is too large" : "a JSON body is required");
      }
    };

    if (platformPath) {
      if (method === "GET" && path === "/api/platforms/accounts") {
        return json(res, 200, { accounts: deps.accounts.listAccounts() });
      }

      if (method === "POST" && path === "/api/platforms/accounts") {
        try {
          const input = await body();
          if (typeof input.platform !== "string" || typeof input.externalAccountId !== "string" || typeof input.displayName !== "string") {
            return json(res, 400, { error: "platform, externalAccountId and displayName are required.", code: "invalid" });
          }
          const account = deps.accounts.addAccount({
            platform: input.platform as PlatformAccount["platform"],
            externalAccountId: input.externalAccountId,
            displayName: input.displayName,
            credentialRef: typeof input.credentialRef === "string" ? input.credentialRef : null,
            ...(Array.isArray(input.capabilities) ? { capabilities: input.capabilities.filter((item): item is string => typeof item === "string") } : {}),
          });
          return json(res, 200, { account });
        } catch (error) {
          const answer = refused(error);
          return json(res, answer.status, answer.body);
        }
      }

      if (method === "POST" && path === "/api/platforms/inbound") {
        try {
          if (deps.inbound) {
            const delivered = await deps.inbound.deliver(await body(128 * 1024));
            return json(res, delivered.status, delivered.body);
          }
          const route = deps.accounts.resolveInbound(await body(128 * 1024));
          return json(res, route.action === "unknown-account" ? 404 : 200, { route });
        } catch (error) {
          const answer = refused(error);
          return json(res, answer.status, answer.body);
        }
      }

      const accountOne = accountIdFromPath(path, "");
      if (method === "DELETE" && accountOne) {
        try {
          const binding = deps.accounts.binding(accountOne);
          const account = deps.accounts.removeAccount(accountOne);
          if (binding) deps.bots.bind(binding.botId, null);
          return json(res, 200, { removed: account });
        } catch (error) {
          const answer = refused(error);
          return json(res, answer.status, answer.body);
        }
      }

      const statusPath = accountIdFromPath(path, "/status");
      if (method === "POST" && statusPath) {
        try {
          const input = await body();
          if (typeof input.status !== "string") return json(res, 400, { error: "status is required.", code: "invalid" });
          return json(res, 200, { account: deps.accounts.setStatus(statusPath, input.status as PlatformAccount["status"]) });
        } catch (error) {
          const answer = refused(error);
          return json(res, answer.status, answer.body);
        }
      }

      const identitiesPath = accountIdFromPath(path, "/identities");
      if (method === "POST" && identitiesPath) {
        try {
          const input = await body();
          if (typeof input.externalPersonId !== "string" || typeof input.personId !== "string"
            || (input.role !== "owner" && input.role !== "member")) {
            return json(res, 400, { error: "externalPersonId, personId and role are required.", code: "invalid" });
          }
          return json(res, 200, {
            identity: deps.accounts.upsertIdentity(identitiesPath, {
              externalPersonId: input.externalPersonId,
              personId: input.personId,
              role: input.role,
            }),
          });
        } catch (error) {
          const answer = refused(error);
          return json(res, answer.status, answer.body);
        }
      }

      const identitiesOne = /^\/api\/platforms\/accounts\/([0-9a-f-]{36})\/identities\/([^/]{1,200})$/.exec(path);
      if (method === "DELETE" && identitiesOne) {
        try {
          return json(res, 200, { removed: deps.accounts.removeIdentity(identitiesOne[1]!, decodeURIComponent(identitiesOne[2]!)) });
        } catch (error) {
          const answer = refused(error);
          return json(res, answer.status, answer.body);
        }
      }

      const bindPath = accountIdFromPath(path, "/bind");
      if (method === "POST" && bindPath) {
        try {
          const account = deps.accounts.account(bindPath);
          if (!account) return json(res, 404, { error: "no such platform account", code: "not-found" });
          if (deps.accounts.binding(bindPath)) return json(res, 409, { error: "this platform account already has a bot; unbind it first", code: "conflict" });
          const input = await body();
          const mode = input.mode === "dedicated" ? "dedicated" : "existing";
          let botId: string;
          let created = false;
          if (mode === "dedicated") {
            const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : `${account.displayName}'s ${account.platform} bot`;
            const id = deps.bots.createDedicated({
              name,
              ...(typeof input.title === "string" ? { title: input.title } : {}),
              ...(typeof input.description === "string" ? { description: input.description } : {}),
              platform: account.platform,
              accountId: account.accountId,
            });
            if (!id) return json(res, 500, { error: "the platform bot could not be created", code: "internal" });
            botId = id;
            created = true;
          } else {
            if (typeof input.botId !== "string" || !deps.bots.has(input.botId)) {
              return json(res, 404, { error: "no such bot", code: "not-found" });
            }
            const existing = deps.bots.bindingOf(input.botId);
            if (existing && existing.accountId !== account.accountId) {
              return json(res, 409, { error: "that bot already answers another platform account", code: "conflict" });
            }
            botId = input.botId;
          }
          try {
            const binding = deps.accounts.bind(account.accountId, botId, mode, typeof input.externalBotId === "string" ? input.externalBotId : undefined);
            if (!deps.bots.bind(botId, { platform: account.platform, accountId: account.accountId, mode })) {
              deps.accounts.unbind(account.accountId);
              if (created) deps.bots.remove(botId);
              return json(res, 404, { error: "the bot disappeared while binding", code: "not-found" });
            }
            return json(res, 200, { binding, botId, created });
          } catch (error) {
            if (created) deps.bots.remove(botId);
            throw error;
          }
        } catch (error) {
          const answer = refused(error);
          return json(res, answer.status, answer.body);
        }
      }

      if (method === "DELETE" && bindPath) {
        try {
          const binding = deps.accounts.unbind(bindPath);
          deps.bots.bind(binding.botId, null);
          return json(res, 200, { removed: binding });
        } catch (error) {
          const answer = refused(error);
          return json(res, answer.status, answer.body);
        }
      }

      const routesPath = accountIdFromPath(path, "/routes");
      if (method === "POST" && routesPath) {
        try {
          const input = await body();
          if (typeof input.conversationId !== "string" || typeof input.botId !== "string" || !deps.bots.has(input.botId)) {
            return json(res, 400, { error: "conversationId and an existing botId are required.", code: "invalid" });
          }
          deps.accounts.setConversationRoute(routesPath, input.conversationId, input.botId);
          return json(res, 200, { routed: true });
        } catch (error) {
          const answer = refused(error);
          return json(res, answer.status, answer.body);
        }
      }
      const routeOne = /^\/api\/platforms\/accounts\/([0-9a-f-]{36})\/routes\/([^/]{1,200})$/.exec(path);
      if (method === "DELETE" && routeOne) {
        try {
          return json(res, 200, { removed: deps.accounts.clearConversationRoute(routeOne[1]!, decodeURIComponent(routeOne[2]!)) });
        } catch (error) {
          const answer = refused(error);
          return json(res, answer.status, answer.body);
        }
      }

      // The bot's replies to this account, until their bridge takes them: list after the last id taken, then ack.
      const outboxPath = accountIdFromPath(path, "/outbox");
      if (deps.outbox && method === "GET" && outboxPath) {
        try {
          return json(res, 200, { messages: deps.outbox.list(outboxPath, url.searchParams.get("since") ?? undefined) });
        } catch (error) {
          if (error instanceof PlatformOutboxError) return json(res, OUTBOX_STATUS[error.code], { error: error.message, code: error.code });
          throw error;
        }
      }
      const outboxAck = accountIdFromPath(path, "/outbox/ack");
      if (deps.outbox && method === "POST" && outboxAck) {
        try {
          const input = await body();
          const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === "string") : [];
          if (!ids.length) return json(res, 400, { error: "a non-empty ids array is required.", code: "invalid" });
          return json(res, 200, { removed: deps.outbox.ack(outboxAck, ids) });
        } catch (error) {
          if (error instanceof PlatformOutboxError) return json(res, OUTBOX_STATUS[error.code], { error: error.message, code: error.code });
          const answer = refused(error);
          return json(res, answer.status, answer.body);
        }
      }

      return json(res, 405, { error: "unsupported platform route", code: "method-not-allowed" });
    }

    if (method === "GET" && path === "/api/memory-spaces") {
      return json(res, 200, { spaces: deps.memory.list() });
    }

    if (method === "POST" && path === "/api/memory-spaces") {
      try {
        const input = await body();
        if (typeof input.spaceId !== "string" || typeof input.name !== "string" || (input.audience !== "owner" && input.audience !== "shared")) {
          return json(res, 400, { error: "spaceId, name and audience are required.", code: "invalid" });
        }
        const members: Array<{ botId: string; access: "read" | "read-write" }> = [];
        if (Array.isArray(input.members)) {
          for (const member of input.members) {
            if (!member || typeof member !== "object") continue;
            const row = member as Record<string, unknown>;
            if (typeof row.botId !== "string" || (row.access !== "read" && row.access !== "read-write")) {
              throw new MemorySpaceError("invalid", "each member needs botId and read or read-write access");
            }
            if (!deps.bots.has(row.botId)) throw new MemorySpaceError("invalid", `no such bot: ${row.botId}`);
            members.push({ botId: row.botId, access: row.access });
          }
        }
        return json(res, 200, {
          space: deps.memory.create({
            spaceId: input.spaceId,
            name: input.name,
            ...(typeof input.description === "string" ? { description: input.description } : {}),
            audience: input.audience,
            members,
          }),
        });
      } catch (error) {
        const answer = refused(error);
        return json(res, answer.status, answer.body);
      }
    }

    const spaceOne = /^\/api\/memory-spaces\/([a-z0-9][a-z0-9-]{1,63})$/.exec(path);
    if (method === "GET" && spaceOne) {
      try {
        const space = deps.memory.get(spaceOne[1]!);
        if (!space) return json(res, 404, { error: "no such memory space", code: "not-found" });
        const botId = url.searchParams.get("botId");
        if (!botId) return json(res, 200, { space });
        return json(res, 200, {
          space,
          entries: deps.memory.entries(space.spaceId, botId, ownerPrincipal(url.searchParams)),
        });
      } catch (error) {
        const answer = refused(error);
        return json(res, answer.status, answer.body);
      }
    }

    const membersPath = /^\/api\/memory-spaces\/([a-z0-9][a-z0-9-]{1,63})\/members$/.exec(path);
    if (method === "POST" && membersPath) {
      try {
        const input = await body();
        if (typeof input.botId !== "string" || !deps.bots.has(input.botId)
          || (input.access !== "read" && input.access !== "read-write")) {
          return json(res, 400, { error: "an existing botId and read or read-write access are required.", code: "invalid" });
        }
        return json(res, 200, {
          space: deps.memory.addMember(membersPath[1]!, Number(input.revision), { botId: input.botId, access: input.access }),
        });
      } catch (error) {
        const answer = refused(error);
        return json(res, answer.status, answer.body);
      }
    }

    const memberOne = /^\/api\/memory-spaces\/([a-z0-9][a-z0-9-]{1,63})\/members\/([A-Za-z0-9_-]{1,120})$/.exec(path);
    if (method === "DELETE" && memberOne) {
      try {
        return json(res, 200, { space: deps.memory.removeMember(memberOne[1]!, revision(url.searchParams), memberOne[2]!) });
      } catch (error) {
        const answer = refused(error);
        return json(res, answer.status, answer.body);
      }
    }

    const revokePath = /^\/api\/memory-spaces\/([a-z0-9][a-z0-9-]{1,63})\/revoke$/.exec(path);
    if (method === "POST" && revokePath) {
      try {
        const input = await body();
        return json(res, 200, { space: deps.memory.revoke(revokePath[1]!, Number(input.revision)) });
      } catch (error) {
        const answer = refused(error);
        return json(res, answer.status, answer.body);
      }
    }

    const entriesPath = /^\/api\/memory-spaces\/([a-z0-9][a-z0-9-]{1,63})\/entries$/.exec(path);
    if (method === "POST" && entriesPath) {
      try {
        const input = await body(128 * 1024);
        if (typeof input.botId !== "string" || typeof input.text !== "string"
          || (input.sensitivity !== "normal" && input.sensitivity !== "private" && input.sensitivity !== "restricted")) {
          return json(res, 400, { error: "botId, text and sensitivity are required.", code: "invalid" });
        }
        if (!deps.bots.has(input.botId)) return json(res, 404, { error: "no such bot", code: "not-found" });
        const provenance = input.provenance && typeof input.provenance === "object" && !Array.isArray(input.provenance)
          ? input.provenance as Record<string, unknown>
          : {};
        const platform = typeof provenance.platform === "string" && (PLATFORM_IDS as readonly string[]).includes(provenance.platform)
          ? provenance.platform as PlatformAccount["platform"]
          : undefined;
        return json(res, 200, {
          entry: deps.memory.writeEntry(entriesPath[1]!, Number(input.revision), {
            text: input.text,
            sensitivity: input.sensitivity,
            provenance: {
              botId: input.botId,
              ...(platform ? { platform } : {}),
              ...(typeof provenance.accountId === "string" ? { accountId: provenance.accountId } : {}),
              ...(typeof provenance.conversationId === "string" ? { conversationId: provenance.conversationId } : {}),
              ...(typeof provenance.messageId === "string" ? { messageId: provenance.messageId } : {}),
            },
            principal: { kind: "owner", personId: "host-owner" },
          }),
        });
      } catch (error) {
        const answer = refused(error);
        return json(res, answer.status, answer.body);
      }
    }

    const entryOne = /^\/api\/memory-spaces\/([a-z0-9][a-z0-9-]{1,63})\/entries\/([0-9a-f-]{36})$/.exec(path);
    if (method === "DELETE" && entryOne) {
      try {
        return json(res, 200, deps.memory.deleteEntry(entryOne[1]!, revision(url.searchParams), entryOne[2]!));
      } catch (error) {
        const answer = refused(error);
        return json(res, answer.status, answer.body);
      }
    }

    const exportPath = /^\/api\/memory-spaces\/([a-z0-9][a-z0-9-]{1,63})\/export$/.exec(path);
    if (method === "GET" && exportPath) {
      try {
        const botId = url.searchParams.get("botId");
        if (!botId) return json(res, 400, { error: "botId is required.", code: "invalid" });
        return json(res, 200, deps.memory.exportSpace(exportPath[1]!, botId, ownerPrincipal(url.searchParams)));
      } catch (error) {
        const answer = refused(error);
        return json(res, answer.status, answer.body);
      }
    }

    return json(res, 405, { error: "unsupported memory space route", code: "method-not-allowed" });
  };
}
