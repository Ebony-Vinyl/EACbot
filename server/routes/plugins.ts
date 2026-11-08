import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { PluginRegistryError, type PluginRegistry } from "../plugins/registry.ts";
import type { PluginGrantResources } from "../../shared/plugins/permissions.ts";
import { LocalInstallError, installLocalPlugin } from "../plugins/local-install.ts";
import { MarketError, type PluginMarketService } from "../plugins/market.ts";
import { PluginChannelError, type PluginChannelStore } from "../plugins/channel-store.ts";

export interface PluginRouteDeps {
  registry: PluginRegistry;
  channels: PluginChannelStore;
  market: PluginMarketService;
  mayManage(auth: RequestAuth): boolean;
  /** When given, a grant may only name a bot this workspace has. */
  botExists?(botId: string): boolean;
}

const RESOURCES = ["accounts", "devices", "memorySpaces", "resources"] as const;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Returns the caller's resource scopes, or null when one is malformed. */
function grantResources(value: unknown): PluginGrantResources | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: PluginGrantResources = {};
  for (const key of RESOURCES) {
    const list = (value as Record<string, unknown>)[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 50 || list.some((item) => typeof item !== "string" || !item || item.length > 128)) return null;
    out[key] = list as string[];
  }
  return out;
}

const STATUS: Readonly<Record<PluginRegistryError["code"], number>> = {
  "not-found": 404,
  incompatible: 422,
  conflict: 409,
  dependency: 409,
  "runtime-unavailable": 409,
  "invalid-state": 409,
};

function failure(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof PluginRegistryError) {
    return { status: STATUS[error.code], body: { error: error.message, code: error.code } };
  }
  if (error instanceof MarketError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  if (error instanceof PluginChannelError) {
    return { status: error.code === "not-found" ? 404 : error.code === "duplicate" ? 409 : 422, body: { error: error.message, code: error.code } };
  }
  if (error instanceof LocalInstallError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  return { status: 500, body: { error: "plugin operation failed", code: "internal" } };
}

export function createPluginRoutes(deps: PluginRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== "/api/plugins" && !path.startsWith("/api/plugins/")) return PASS;
    if (!deps.mayManage(auth)) return json(res, 403, { error: "Only an owner or administrator can manage plugins." });
    res.setHeader("Cache-Control", "no-store");

    if (method === "POST" && path === "/api/plugins/local") {
      let body: { path?: unknown };
      try {
        body = await readBody(req, 16_384);
      } catch (error) {
        const status = (error as { status?: number }).status === 413 ? 413 : 400;
        return json(res, status, { error: "A small JSON body with a package path is required.", code: status === 413 ? "body-too-large" : "invalid-body" });
      }
      if (typeof body?.path !== "string") return json(res, 400, { error: "A package path is required.", code: "invalid-body" });
      try {
        return json(res, 200, { plugin: installLocalPlugin(deps.registry, body.path) });
      } catch (error) {
        if (error instanceof LocalInstallError) return json(res, error.status, { error: error.message, code: error.code });
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }

    if (method === "GET" && path === "/api/plugins/channels") {
      return json(res, 200, {
        channels: deps.channels.list().map(({ publicKeyPem: _publicKeyPem, ...channel }) => channel),
      });
    }

    if (method === "POST" && path === "/api/plugins/channels") {
      let body: Record<string, unknown>;
      try {
        body = await readBody(req, 32_768);
      } catch (error) {
        const status = (error as { status?: number }).status === 413 ? 413 : 400;
        return json(res, status, { error: "A channel body is required.", code: status === 413 ? "body-too-large" : "invalid-body" });
      }
      if (typeof body?.sourceId !== "string" || typeof body.name !== "string" || typeof body.url !== "string"
        || typeof body.keyId !== "string" || typeof body.publicKeyPem !== "string") {
        return json(res, 400, { error: "sourceId, name, url, keyId and publicKeyPem are required.", code: "invalid-body" });
      }
      try {
        const channel = deps.channels.add({
          sourceId: body.sourceId, name: body.name, url: body.url, keyId: body.keyId,
          publicKeyPem: body.publicKeyPem, trust: "community",
        });
        return json(res, 200, { channel: { ...channel, publicKeyPem: undefined } });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }

    const channelOne = /^\/api\/plugins\/channels\/([a-z0-9][a-z0-9._-]{1,63})$/.exec(path);
    if (method === "DELETE" && channelOne) {
      try {
        const { publicKeyPem: _publicKeyPem, ...removed } = deps.channels.remove(channelOne[1]!);
        return json(res, 200, { removed });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }
    const channelRefresh = /^\/api\/plugins\/channels\/([a-z0-9][a-z0-9._-]{1,63})\/refresh$/.exec(path);
    if (method === "POST" && channelRefresh) {
      try {
        const refreshed = await deps.market.refresh(channelRefresh[1]!);
        if (!refreshed.ok) return json(res, 502, { error: refreshed.error, code: refreshed.code });
        return json(res, 200, { entries: deps.market.catalog().filter((entry) => entry.sourceId === channelRefresh[1]) });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }

    if (method === "GET" && path === "/api/plugins/catalog") {
      try {
        if (url.searchParams.get("refresh") === "1") await deps.market.refreshAll();
        return json(res, 200, {
          entries: deps.market.catalog(),
          channels: deps.channels.list().map(({ publicKeyPem: _publicKeyPem, ...channel }) => channel),
        });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }

    if (method === "POST" && path === "/api/plugins/install") {
      let body: Record<string, unknown>;
      try {
        body = await readBody(req, 32_768);
      } catch (error) {
        const status = (error as { status?: number }).status === 413 ? 413 : 400;
        return json(res, status, { error: "An install body is required.", code: status === 413 ? "body-too-large" : "invalid-body" });
      }
      if (typeof body?.sourceId !== "string" || typeof body.pluginId !== "string" || typeof body.version !== "string"
        || (body.platform !== undefined && typeof body.platform !== "string")) {
        return json(res, 400, { error: "sourceId, pluginId and version are required.", code: "invalid-body" });
      }
      try {
        return json(res, 200, { plugin: await deps.market.install({
          sourceId: body.sourceId, pluginId: body.pluginId, version: body.version,
          ...(typeof body.platform === "string" ? { platform: body.platform } : {}),
        }) });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }

    if (method === "POST" && path === "/api/plugins") return json(res, 405, { error: "Use /api/plugins/install or /api/plugins/local.", code: "method-not-allowed" });

    if (method === "GET" && path === "/api/plugins") {
      try {
        return json(res, 200, { plugins: deps.registry.list() });
      } catch {
        return json(res, 500, { error: "The plugin store could not be read.", code: "store-unavailable" });
      }
    }

    const toolsPath = /^\/api\/plugins\/([A-Za-z0-9_-]{1,120})\/tools$/.exec(path);
    if (method === "GET" && toolsPath) {
      try {
        return json(res, 200, { tools: deps.registry.tools(toolsPath[1]!) });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }

    const toolCall = /^\/api\/plugins\/([A-Za-z0-9_-]{1,120})\/tools\/([a-z][a-z0-9-]{1,63})\/call$/.exec(path);
    if (method === "POST" && toolCall) {
      let body: Record<string, unknown>;
      try {
        body = await readBody(req, 128 * 1024);
      } catch (error) {
        const status = (error as { status?: number }).status === 413 ? 413 : 400;
        return json(res, status, { error: "A tool call body is required.", code: status === 413 ? "body-too-large" : "invalid-body" });
      }
      if (typeof body?.botId !== "string" || typeof body.principalId !== "string" || typeof body.audienceId !== "string"
        || typeof body.epoch !== "number" || !Number.isInteger(body.epoch) || body.epoch < 0
        || !body.args || typeof body.args !== "object" || Array.isArray(body.args)) {
        return json(res, 400, { error: "botId, principalId, audienceId, epoch and an args object are required.", code: "invalid-body" });
      }
      try {
        const result = await deps.registry.callTool(toolCall[1]!, toolCall[2]!, {
          botId: body.botId,
          principalId: body.principalId,
          audienceId: body.audienceId,
          epoch: body.epoch,
          args: body.args as Record<string, unknown>,
          ...(typeof body.accountId === "string" ? { accountId: body.accountId } : {}),
          ...(typeof body.deviceId === "string" ? { deviceId: body.deviceId } : {}),
          ...(typeof body.memorySpaceId === "string" ? { memorySpaceId: body.memorySpaceId } : {}),
          ...(typeof body.resourceId === "string" ? { resourceId: body.resourceId } : {}),
        });
        return json(res, 200, { result });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }

    const grantsPath = /^\/api\/plugins\/([A-Za-z0-9_-]{1,120})\/grants$/.exec(path);
    if (method === "GET" && grantsPath) {
      try {
        return json(res, 200, { grants: deps.registry.grants(grantsPath[1]!) });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }
    if (method === "POST" && grantsPath) {
      let body: Record<string, unknown>;
      try {
        body = await readBody(req, 16_384);
      } catch (error) {
        const status = (error as { status?: number }).status === 413 ? 413 : 400;
        return json(res, status, { error: "A grant body is required.", code: status === 413 ? "body-too-large" : "invalid-body" });
      }
      const strings = (value: unknown, max: number) => typeof value === "string" && value.length >= 1 && value.length <= max ? value : null;
      const toolId = strings(body?.toolId, 120);
      const botId = strings(body?.botId, 120);
      const principalId = strings(body?.principalId, 200);
      const audienceId = strings(body?.audienceId, 200);
      const epoch = body?.epoch;
      const maxUses = body?.maxUses;
      const expiresAt = body?.expiresAt;
      const resources = grantResources(body?.resources);
      if (!toolId || !botId || !principalId || !audienceId || typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0
        || (maxUses !== undefined && (typeof maxUses !== "number" || !Number.isInteger(maxUses) || maxUses < 1))
        || (expiresAt !== undefined && (typeof expiresAt !== "string" || !ISO_DATETIME.test(expiresAt)))
        || resources === null) {
        return json(res, 400, { error: "toolId, botId, principalId, audienceId and an epoch of 0 or more are required.", code: "invalid-body" });
      }
      if (deps.botExists && !deps.botExists(botId)) {
        return json(res, 422, { error: "no such bot for this grant", code: "invalid-body" });
      }
      try {
        return json(res, 200, { grant: deps.registry.grantTool(grantsPath[1]!, {
          toolId, botId, principalId, audienceId, epoch,
          ...(maxUses !== undefined ? { maxUses } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          resources,
        }) });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }
    const grantOne = /^\/api\/plugins\/([A-Za-z0-9_-]{1,120})\/grants\/([A-Za-z0-9_-]{1,120})$/.exec(path);
    if (method === "DELETE" && grantOne) {
      try {
        deps.registry.removeGrant(grantOne[1]!, grantOne[2]!);
        return json(res, 200, { removed: grantOne[2] });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }

    const one = /^\/api\/plugins\/([A-Za-z0-9_-]{1,120})$/.exec(path);
    if (method === "GET" && one) {
      try {
        const plugin = deps.registry.get(one[1]!);
        return plugin ? json(res, 200, { plugin }) : json(res, 404, { error: "No such plugin installation.", code: "not-found" });
      } catch {
        return json(res, 500, { error: "The plugin store could not be read.", code: "store-unavailable" });
      }
    }

    const action = /^\/api\/plugins\/([A-Za-z0-9_-]{1,120})\/(activate|disable|revoke)$/.exec(path);
    if (method === "POST" && action) {
      const [, installationId, verb] = action;
      try {
        if (verb === "activate") {
          const activated = await deps.registry.activate(installationId!);
          const plugin = deps.registry.get(installationId!);
          return json(res, activated.ok ? 200 : 409, {
            ...(plugin ? { plugin } : {}),
            ...(activated.ok ? {} : { error: activated.error ?? "plugin is blocked", code: activated.code ?? "blocked" }),
          });
        }
        if (verb === "disable") return json(res, 200, { plugin: await deps.registry.deactivate(installationId!) });
        return json(res, 200, { plugin: await deps.registry.revoke(installationId!, "revoked by the owner") });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }

    const marketAction = /^\/api\/plugins\/([A-Za-z0-9_-]{1,120})\/(update|rollback)$/.exec(path);
    if (method === "POST" && marketAction) {
      const [, installationId, verb] = marketAction;
      let body: Record<string, unknown> = {};
      try {
        body = await readBody(req, 32_768);
      } catch (error) {
        const status = (error as { status?: number }).status === 413 ? 413 : 400;
        return json(res, status, { error: "An update body is invalid.", code: status === 413 ? "body-too-large" : "invalid-body" });
      }
      try {
        if (verb === "update") {
          return json(res, 200, { plugin: await deps.market.update(installationId!, {
            ...(typeof body.version === "string" ? { version: body.version } : {}),
            ...(typeof body.platform === "string" ? { platform: body.platform } : {}),
          }) });
        }
        return json(res, 200, { plugin: await deps.market.rollback(installationId!) });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }

    if (method === "DELETE" && one) {
      try {
        return json(res, 200, { removed: await deps.registry.remove(one[1]!) });
      } catch (error) {
        const refused = failure(error);
        return json(res, refused.status, refused.body);
      }
    }

    return PASS;
  };
}
