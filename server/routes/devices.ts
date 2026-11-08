import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { DeviceError, type DeviceRegistry } from "../plugins/device-registry.ts";
import type { DeviceCommandStatus, DeviceKind } from "../../shared/plugins/devices.ts";

export interface DeviceRouteDeps {
  devices: DeviceRegistry;
  mayManage(auth: RequestAuth): boolean;
}

const STATUS: Readonly<Record<DeviceError["code"], number>> = {
  invalid: 400,
  "not-found": 404,
  conflict: 409,
  forbidden: 403,
  expired: 410,
  corrupt: 500,
};

/** Device pairing, listing, revocation and command receipts; every path is owner-only. */
export function createDeviceRoutes(deps: DeviceRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/devices" && !path.startsWith("/api/devices/")) return PASS;
    if (!deps.mayManage(auth)) return json(res, 403, { error: "Only an owner or administrator can manage devices." });
    res.setHeader("Cache-Control", "no-store");

    const fail = (error: unknown) => {
      if (error instanceof DeviceError) return json(res, STATUS[error.code], { error: error.message, code: error.code });
      return json(res, 500, { error: "device operation failed", code: "internal" });
    };

    try {
      if (method === "GET" && path === "/api/devices") return json(res, 200, { devices: deps.devices.list() });

      if (method === "POST" && path === "/api/devices/pairings") {
        const body = await readBody(req, 8_192);
        if (typeof body?.name !== "string" || typeof body?.kind !== "string" || !Array.isArray(body?.capabilities)) {
          return json(res, 400, { error: "name, kind and capabilities are required.", code: "invalid" });
        }
        return json(res, 200, {
          pairing: deps.devices.createPairing({
            name: body.name,
            kind: body.kind as DeviceKind,
            capabilities: (body.capabilities as unknown[]).filter((item): item is string => typeof item === "string"),
          }),
        });
      }

      const redeem = /^\/api\/devices\/pairings\/([0-9a-f-]{36})\/redeem$/.exec(path);
      if (method === "POST" && redeem) {
        const body = await readBody(req, 8_192);
        if (typeof body?.code !== "string") return json(res, 400, { error: "code is required.", code: "invalid" });
        return json(res, 200, { device: deps.devices.redeem(redeem[1]!, body.code) });
      }

      const one = /^\/api\/devices\/([0-9a-f-]{36})$/.exec(path);
      if (method === "DELETE" && one) return json(res, 200, { device: deps.devices.revoke(one[1]!) });

      const heartbeat = /^\/api\/devices\/([0-9a-f-]{36})\/heartbeat$/.exec(path);
      if (method === "POST" && heartbeat) return json(res, 200, { device: deps.devices.touch(heartbeat[1]!) });

      const commands = /^\/api\/devices\/([0-9a-f-]{36})\/commands$/.exec(path);
      if (method === "GET" && commands) return json(res, 200, { commands: deps.devices.pending(commands[1]!) });
      if (method === "POST" && commands) {
        const body = await readBody(req, 32_768);
        if (typeof body?.capability !== "string") return json(res, 400, { error: "capability is required.", code: "invalid" });
        return json(res, 200, {
          command: deps.devices.send({
            ...(typeof body.commandId === "string" ? { commandId: body.commandId } : {}),
            deviceId: commands[1]!,
            capability: body.capability,
            ...(body.args && typeof body.args === "object" && !Array.isArray(body.args) ? { args: body.args as Record<string, unknown> } : {}),
            ...(typeof body.ttlMs === "number" ? { ttlMs: body.ttlMs } : {}),
          }),
        });
      }

      const receipt = /^\/api\/devices\/([0-9a-f-]{36})\/commands\/([0-9a-f-]{36})\/result$/.exec(path);
      if (method === "POST" && receipt) {
        const body = await readBody(req, 32_768);
        if (body?.status !== "succeeded" && body?.status !== "failed" && body?.status !== "unknown") {
          return json(res, 400, { error: "status must be succeeded, failed or unknown.", code: "invalid" });
        }
        return json(res, 200, {
          command: deps.devices.complete(
            receipt[1]!,
            receipt[2]!,
            body.status as Exclude<DeviceCommandStatus, "queued">,
            body.result && typeof body.result === "object" && !Array.isArray(body.result) ? body.result as Record<string, unknown> : undefined,
          ),
        });
      }

      return json(res, 405, { error: "unsupported device route", code: "method-not-allowed" });
    } catch (error) {
      return fail(error);
    }
  };
}
