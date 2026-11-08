// GET /api/announcements: the merged remote feed and this workspace's announcements, read-only for every client.
// Owner/admin manage the local ones under the same path.
import type { IncomingMessage, ServerResponse } from "node:http";

import { activeAnnouncements } from "../../shared/announcement.ts";
import { AnnouncementError, announcementInputSchema, type Announcements, type AnnouncementInput } from "../announcements.ts";
import type { AnnouncementFeed } from "../announcement-feed.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export interface AnnouncementRouteDeps {
  announcements: Announcements;
  feed?: AnnouncementFeed;
  mayManage(auth: RequestAuth): boolean;
  now?(): number;
}

const INVALID_BODY = "A title of up to 200 characters, an optional body of up to 4000, a level and an optional window are required.";

type ReadInput = { ok: true; value: AnnouncementInput } | { ok: false; tooLarge: boolean };

async function readInput(req: IncomingMessage, readBody: RouteContext["readBody"]): Promise<ReadInput> {
  try {
    const body = await readBody(req, 16_384);
    const parsed = announcementInputSchema.safeParse(body);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, tooLarge: false };
  } catch (error) {
    return { ok: false, tooLarge: (error as { status?: number }).status === 413 };
  }
}

function refuseBody(res: ServerResponse, json: RouteContext["json"], parsed: { ok: false; tooLarge: boolean }) {
  return json(res, parsed.tooLarge ? 413 : 400, { error: INVALID_BODY, code: parsed.tooLarge ? "body-too-large" : "invalid-body" });
}

function failure(res: ServerResponse, json: RouteContext["json"], error: unknown) {
  if (error instanceof AnnouncementError) {
    return json(res, error.code === "not-found" ? 404 : 409, { error: error.message, code: error.code });
  }
  return json(res, 500, { error: "the announcement could not be saved", code: "internal" });
}

export function createAnnouncementRoutes(deps: AnnouncementRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }: RouteContext) => {
    if (path !== "/api/announcements" && !path.startsWith("/api/announcements/")) return PASS;
    const now = deps.now ?? Date.now;
    if (method === "GET" && path === "/api/announcements") {
      const local = deps.announcements.list();
      const seen = new Set(local.map((item) => item.id));
      const remote = (deps.feed?.list() ?? []).filter((item) => !seen.has(item.id));
      return json(res, 200, { announcements: activeAnnouncements([...local, ...remote], now()) });
    }
    if (!deps.mayManage(auth)) return json(res, 403, { error: "Only an owner or administrator can manage announcements." });
    if (method === "GET" && path === "/api/announcements/manage") {
      return json(res, 200, { announcements: deps.announcements.list() });
    }

    if (method === "POST" && path === "/api/announcements") {
      const parsed = await readInput(req, readBody);
      if (!parsed.ok) return refuseBody(res, json, parsed);
      try {
        return json(res, 200, { announcement: deps.announcements.add(parsed.value) });
      } catch (error) {
        return failure(res, json, error);
      }
    }

    const one = /^\/api\/announcements\/([\w.-]{1,64})$/.exec(path);
    if (one && method === "PATCH") {
      const parsed = await readInput(req, readBody);
      if (!parsed.ok) return refuseBody(res, json, parsed);
      try {
        return json(res, 200, { announcement: deps.announcements.update(one[1]!, parsed.value) });
      } catch (error) {
        return failure(res, json, error);
      }
    }
    if (one && method === "DELETE") {
      return json(res, 200, { removed: deps.announcements.remove(one[1]!) });
    }
    return PASS;
  };
}
