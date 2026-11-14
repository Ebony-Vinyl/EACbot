// The cloud half of the health HTTP surface: which provider apps are registered, a sign-in's progress, and a sync.
// A token never leaves this process: the routes report a source's status, never its credential.
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { HealthStore } from "../health/store.ts";
import type { HealthCloudStore } from "../health/cloud-store.ts";
import { HEALTH_OAUTH_CALLBACK_PATH, HealthOAuthError, type HealthOAuthEndpoints, type HealthOAuthManager, type HealthOAuthProvider } from "../health/adapters/oauth.ts";
import { READABLE_CLOUD_PROVIDERS, syncHealthSource } from "../health/sync.ts";

export interface HealthCloudRouteDeps {
  store: HealthStore;
  cloud: HealthCloudStore;
  oauth: HealthOAuthManager;
  /** The app a source was configured with, or null when config names none. */
  app(sourceId: string): { provider: HealthOAuthProvider; clientId: string; clientSecret?: string; endpoints?: HealthOAuthEndpoints } | null;
  mayManage(auth: RequestAuth): boolean;
  now?: () => string;
}

const PROVIDERS: readonly HealthOAuthProvider[] = ["withings", "oura", "polar", "fitbit"];

const isProvider = (value: unknown): value is HealthOAuthProvider =>
  typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);

const STATUS: Readonly<Record<HealthOAuthError["code"], number>> = {
  unknown_provider: 400,
  no_client: 400,
  port_busy: 409,
  refused: 400,
  expired: 410,
};

/** Sign-in, sync and disconnect for a cloud health source. */
export function createHealthCloudRoutes(deps: HealthCloudRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/health/cloud" && !path.startsWith("/api/health/cloud/")) return PASS;
    if (!deps.mayManage(auth)) return json(res, 403, { error: "Only an owner or administrator can connect or sync a health source." });
    res.setHeader("Cache-Control", "no-store");

    const fail = (error: unknown) => {
      if (error instanceof HealthOAuthError) return json(res, STATUS[error.code], { error: { code: error.code, message: error.message } });
      return json(res, 500, { error: { code: "cloud_failure", message: error instanceof Error ? error.message : String(error) } });
    };

    try {
      if (method === "GET" && path === "/api/health/cloud") {
        return json(res, 200, {
          providers: PROVIDERS.map((provider) => ({
            provider,
            readable: READABLE_CLOUD_PROVIDERS.has(provider),
            /** What a person must register with that provider to connect it. */
            callbackPath: HEALTH_OAUTH_CALLBACK_PATH,
          })),
          sources: deps.cloud.all().map((record) => ({
            sourceId: record.sourceId,
            provider: record.provider,
            account: record.account ?? null,
            cursor: record.cursor ?? null,
            lastSyncAt: record.lastSyncAt ?? null,
            /** Configured and holding a sign-in, with no token ever echoed. */
            signedIn: true,
            expiresAt: record.tokens.expiresAt ? new Date(record.tokens.expiresAt).toISOString() : null,
            canRefresh: Boolean(record.tokens.refresh),
          })),
        });
      }

      if (method === "POST" && path === "/api/health/cloud/connect") {
        const body = await readBody(req, 8_192);
        const sourceId = typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
        if (!sourceId) return json(res, 400, { error: { code: "invalid_source", message: `give the source id from config.json: {"sourceId": "withings"}` } });
        const configured = deps.app(sourceId);
        if (!configured) {
          return json(res, 400, { error: { code: "no_app", message: `config.json has no cloud source "${sourceId}"; add one with provider and app` } });
        }
        if (!isProvider(configured.provider)) {
          return json(res, 400, { error: { code: "unknown_provider", message: `${String(configured.provider).slice(0, 40)} is not a provider this build knows` } });
        }
        if (!READABLE_CLOUD_PROVIDERS.has(configured.provider)) {
          return json(res, 400, { error: { code: "not_supported", message: `this build cannot read ${configured.provider} yet; connect withings or oura` } });
        }
        const { status, done } = await deps.oauth.authorize({
          provider: configured.provider,
          sourceId,
          client: {
            clientId: configured.clientId,
            ...(configured.clientSecret ? { clientSecret: configured.clientSecret } : {}),
            ...(configured.endpoints ? { endpoints: configured.endpoints } : {}),
          },
        });
        // Persisted as soon as the person comes back, whether or not this request is still being read.
        void done.then((record) => {
          deps.cloud.put(record);
          deps.store.upsertSource({ sourceId, kind: "cloud", label: configured.provider, status: "connected", credentialRef: null });
        }).catch(() => {});
        return json(res, 200, { sourceId, provider: configured.provider, ...status });
      }

      if (method === "GET" && path === "/api/health/cloud/status") {
        const sourceId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("sourceId") ?? "";
        const status = deps.oauth.status(sourceId);
        return json(res, 200, status ?? { phase: "idle", sourceId });
      }

      if (method === "POST" && path === "/api/health/cloud/cancel") {
        const body = await readBody(req, 4_096);
        const sourceId = typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
        if (!sourceId) return json(res, 400, { error: { code: "invalid_source", message: `give the source id: {"sourceId": "withings"}` } });
        deps.oauth.cancel(sourceId);
        return json(res, 200, { sourceId, cancelled: true });
      }

      if (method === "POST" && path === "/api/health/cloud/sync") {
        const body = await readBody(req, 4_096);
        const sourceId = typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
        if (!sourceId) return json(res, 400, { error: { code: "invalid_source", message: `give the source id: {"sourceId": "withings"}` } });
        const configured = deps.app(sourceId);
        const outcome = await syncHealthSource({
          store: deps.store,
          cloud: deps.cloud,
          client: (provider) => {
            if (!configured || configured.provider !== provider) return null;
            return {
              clientId: configured.clientId,
              ...(configured.clientSecret ? { clientSecret: configured.clientSecret } : {}),
              ...(configured.endpoints ? { endpoints: configured.endpoints } : {}),
            };
          },
          ...(deps.now ? { now: deps.now } : {}),
        }, sourceId);
        return json(res, outcome.error ? 502 : 200, outcome);
      }

      if (method === "DELETE" && path === "/api/health/cloud") {
        const body = await readBody(req, 4_096);
        const sourceId = typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
        if (!sourceId) return json(res, 400, { error: { code: "invalid_source", message: `give the source id: {"sourceId": "withings"}` } });
        deps.oauth.cancel(sourceId);
        deps.cloud.delete(sourceId);
        const removed = deps.store.remove({ sourceId });
        return json(res, 200, { sourceId, removed, disconnected: true });
      }

      return json(res, 404, { error: { code: "not_found", message: "no such cloud health endpoint" } });
    } catch (error) {
      return fail(error);
    }
  };
}
