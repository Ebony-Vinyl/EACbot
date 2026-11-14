// The platform board HTTP surface. Every path is owner-only: a board names accounts, conversations and money.
import { z } from "zod";

import { PLATFORM_IDS, type PlatformId } from "../../shared/plugins/accounts.ts";
import type { PlatformBoardHost } from "../plugins/platform-boards.ts";
import { PlatformBoardError } from "../plugins/platform-boards.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const STATUS: Readonly<Record<PlatformBoardError["code"], number>> = {
  "not-found": 404,
  "runtime-unavailable": 409,
  invalid: 502,
  failed: 502,
};

const operateSchema = z.object({
  action: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  params: z.unknown().optional(),
}).strict();

const isPlatform = (value: string): value is PlatformId => (PLATFORM_IDS as readonly string[]).includes(value);

export function createPlatformBoardRoutes(deps: {
  boards: PlatformBoardHost;
  mayManage(auth: RequestAuth): boolean;
}): RouteHandler {
  return async ({ path, method, req, res, auth, json, readBody, url }) => {
    if (path !== "/api/platform-boards" && !path.startsWith("/api/platform-boards/")) return PASS;
    if (!deps.mayManage(auth)) return json(res, 403, { error: "Only an owner or administrator can read or operate a platform board." });
    res.setHeader("Cache-Control", "no-store");
    const refresh = url.searchParams.get("refresh") === "1";
    const fail = (error: unknown) => {
      if (error instanceof PlatformBoardError) return json(res, STATUS[error.code], { error: { code: error.code, message: error.message } });
      if (error instanceof z.ZodError) return json(res, 422, { error: { code: "invalid", message: error.issues[0]?.message ?? "invalid request" } });
      return json(res, 500, { error: { code: "failed", message: error instanceof Error ? error.message.slice(0, 800) : String(error) } });
    };

    try {
      if (method === "GET" && path === "/api/platform-boards") {
        return json(res, 200, { platforms: await deps.boards.summaries({ refresh }) });
      }
      const board = /^\/api\/platform-boards\/([a-z]+)$/.exec(path);
      if (board && method === "GET") {
        if (!isPlatform(board[1]!)) return json(res, 404, { error: { code: "not-found", message: `${board[1]} is not a platform this host knows.` } });
        return json(res, 200, { board: await deps.boards.board(board[1]!, { refresh }) });
      }
      const operate = /^\/api\/platform-boards\/([a-z]+)\/operate$/.exec(path);
      if (operate && method === "POST") {
        if (!isPlatform(operate[1]!)) return json(res, 404, { error: { code: "not-found", message: `${operate[1]} is not a platform this host knows.` } });
        const body = operateSchema.parse(await readBody(req, 256 * 1024));
        return json(res, 200, { result: await deps.boards.operate(operate[1]!, body.action, body.params) });
      }
      const audit = /^\/api\/platform-boards\/([a-z]+)\/audit$/.exec(path);
      if (audit && method === "GET") {
        if (!isPlatform(audit[1]!)) return json(res, 404, { error: { code: "not-found", message: `${audit[1]} is not a platform this host knows.` } });
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
        return json(res, 200, { entries: await deps.boards.audit(audit[1]!, limit) });
      }
      return json(res, 405, { error: { code: "method-not-allowed", message: "Unknown platform board operation." } });
    } catch (error) {
      return fail(error);
    }
  };
}
