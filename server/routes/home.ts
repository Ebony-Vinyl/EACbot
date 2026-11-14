// The home HTTP surface: the snapshot the /home view draws, one command, and the audit trail. A command from the
// view is the person's own, so it is `full` access and its sensitive actions still ask the view to confirm.
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { HomeAudit } from "../home/audit.ts";
import type { HomeRegistry } from "../home/registry.ts";
import type { HomePolicy } from "../home/policy.ts";
import { homeVerdict } from "../home/policy.ts";
import { HOME_ACTIONS, type HomeAction, type HomeCommand } from "../../shared/home.ts";

export interface HomeRouteDeps {
  registry: HomeRegistry;
  audit: HomeAudit;
  mayManage(auth: RequestAuth): boolean;
  /** The person at the view: `full` access, but a sensitive action still needs the request's own `confirm`. */
  policy(): HomePolicy;
  /** Commissions a device onto a Matter fabric. Absent when no Matter adapter is configured. */
  pair?(input: { code?: string; passcode?: number; discriminator?: number; timeoutSeconds?: number }): Promise<{ nodeId: string }>;
}

export function createHomeRoutes(deps: HomeRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== "/api/home" && !path.startsWith("/api/home/")) return PASS;
    if (!deps.mayManage(auth)) return json(res, 403, { error: { code: "forbidden_zone", message: "Only an owner or administrator can see or change the home." } });
    res.setHeader("Cache-Control", "no-store");

    try {
      if (method === "GET" && path === "/api/home") {
        const force = url.searchParams.get("refresh") === "1";
        return json(res, 200, await deps.registry.snapshot({ force }));
      }

      if (method === "GET" && path === "/api/home/history") {
        const limit = Number(url.searchParams.get("limit")) || 50;
        return json(res, 200, { entries: deps.audit.recent(limit) });
      }

      if (method === "GET" && path.startsWith("/api/home/entities/")) {
        const entityId = decodeURIComponent(path.slice("/api/home/entities/".length));
        const entity = await deps.registry.entity(entityId);
        if (!entity) return json(res, 404, { error: { code: "unknown_entity", message: `no device "${entityId.slice(0, 120)}"` } });
        return json(res, 200, { entity });
      }

      if (method === "POST" && path === "/api/home/commands") {
        const body = await readBody(req, 32_768);
        if (typeof body?.entityId !== "string" || !body.entityId.trim()) {
          return json(res, 400, { error: { code: "unknown_entity", message: `entityId is required: {"entityId": "home-assistant:light.kitchen", "action": "turn_on"}` } });
        }
        if (!HOME_ACTIONS.includes(body.action as HomeAction)) {
          return json(res, 400, { error: { code: "unsupported_action", message: `action must be one of ${HOME_ACTIONS.join(", ")}` } });
        }
        const entity = await deps.registry.entity(body.entityId);
        if (!entity) return json(res, 404, { error: { code: "unknown_entity", message: `no device "${body.entityId.slice(0, 120)}"` } });
        const action = body.action as HomeAction;
        const policy = deps.policy();
        const verdict = homeVerdict(policy, entity, action);
        if (!verdict.ok) return json(res, 403, { error: { code: verdict.code, message: verdict.message } });
        if (verdict.needsConfirmation && body.confirm !== true) {
          return json(res, 409, {
            error: { code: "sensitive_requires_confirmation", message: `${action} on ${entity.name} needs an explicit confirmation: repeat the request with "confirm": true` },
            needsConfirmation: true,
            entity: { entityId: entity.entityId, name: entity.name, domain: entity.domain, state: entity.state },
          });
        }
        const adapter = deps.registry.adapter(entity.adapterId);
        if (!adapter) return json(res, 404, { error: { code: "unknown_adapter", message: `no adapter named "${entity.adapterId}"` } });
        if (!adapter.controllable) return json(res, 409, { error: { code: "adapter_unavailable", message: `${adapter.label} can only be read in this build` } });
        const command: HomeCommand = {
          entityId: entity.entityId,
          action,
          ...(body.value === undefined ? {} : { value: body.value as string | number | boolean }),
        };
        const receipt = await adapter.control(command);
        deps.audit.record(receipt, "person", { entityName: entity.name, ...(command.value === undefined ? {} : { value: command.value }) });
        deps.registry.invalidate(entity.adapterId);
        return json(res, 200, { receipt });
      }

      if (method === "POST" && path === "/api/home/pair") {
        if (!deps.pair) return json(res, 409, { error: { code: "unknown_adapter", message: "no Matter adapter is configured, so there is nothing to pair with" } });
        const body = await readBody(req, 4_096);
        const code = typeof body?.code === "string" ? body.code.trim() : undefined;
        const passcode = Number(body?.passcode);
        const discriminator = Number(body?.discriminator);
        const timeoutSeconds = Number(body?.timeoutSeconds);
        if (!code && !Number.isInteger(passcode)) {
          return json(res, 400, { error: { code: "invalid_value", message: `give the pairing code: {"code": "3497-011-2332"}, or {"passcode": 20202021, "discriminator": 3840}` } });
        }
        try {
          const paired = await deps.pair({
            ...(code ? { code } : {}),
            ...(Number.isInteger(passcode) ? { passcode } : {}),
            ...(Number.isInteger(discriminator) ? { discriminator } : {}),
            ...(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? { timeoutSeconds } : {}),
          });
          // The new device has to appear on the next snapshot, not fifteen seconds later.
          deps.registry.invalidate();
          return json(res, 200, { paired });
        } catch (error) {
          return json(res, 502, { error: { code: "pairing_failed", message: error instanceof Error ? error.message.slice(0, 500) : String(error) } });
        }
      }

      return json(res, 404, { error: { code: "not_found", message: "no such home endpoint" } });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "adapter_unavailable";
      return json(res, 500, { error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  };
}
