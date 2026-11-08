import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createAnnouncementFeed } from "../announcement-feed.ts";
import { createAnnouncements } from "../announcements.ts";
import { createAnnouncementRoutes } from "./announcements.ts";
import { dispatchRoutes } from "./table.ts";

const owner = { kind: "session", session: { id: "s1" }, via: "bearer", scopes: ["admin", "client"] } as unknown as RequestAuth;
const client = { ...owner, scopes: ["client"] } as unknown as RequestAuth;
const folders: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function serve(feedItems: unknown[] = []) {
  const folder = mkdtempSync(join(tmpdir(), "eac-announcement-routes-"));
  folders.push(folder);
  const announcements = createAnnouncements(folder, () => 1_000);
  const feed = createAnnouncementFeed({
    url: feedItems.length ? "https://announcements.example/eacbot.json" : "",
    fetch: async () => new Response(JSON.stringify({ version: 1, announcements: feedItems }), { status: 200, headers: { "content-type": "application/json" } }),
    now: () => 1_000,
    refreshMs: 0,
    startDelayMs: 1,
    warn: () => undefined,
  });
  await new Promise((done) => setTimeout(done, 20));
  const route = createAnnouncementRoutes({ announcements, feed, mayManage: (auth) => auth.kind === "loopback" || auth.scopes.includes("admin"), now: () => 1_000 });
  let auth = owner;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "next route" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, announcements, setAuth: (next: RequestAuth) => { auth = next; } };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("/api/announcements", () => {
  it("is readable by a client session and managed by owner/admin only", async () => {
    const { base, setAuth } = await serve();
    setAuth(client);
    expect((await call(base, "GET", "/api/announcements")).status).toBe(200);
    expect((await call(base, "POST", "/api/announcements", { title: "No" })).status).toBe(403);
    expect(requiredScope("GET", "/api/announcements")).toBe("client");
    expect(requiredScope("POST", "/api/announcements")).toBe("admin");
  });

  it("serves the local and remote announcements with the window applied", async () => {
    const { base } = await serve([
      { id: "remote-1", title: "From the source", level: "important" },
      { id: "remote-2", title: "Scheduled later", startsAt: 9_000 },
      { id: "remote-3", title: "Ended", endsAt: 500 },
    ]);
    const added = await call(base, "POST", "/api/announcements", { title: "Local notice", body: "Hello", level: "info" });
    expect(added.status).toBe(200);
    const listed = await call(base, "GET", "/api/announcements");
    expect(listed.status).toBe(200);
    expect(listed.body.announcements).toMatchObject([
      { title: "From the source", source: "remote", level: "important" },
      { title: "Local notice", source: "local" },
    ]);
    expect(listed.body.announcements).toHaveLength(2);
  });

  it("updates and removes a local announcement and refuses an invalid body", async () => {
    const { base } = await serve();
    const added = await call(base, "POST", "/api/announcements", { title: "First", body: "b", level: "important", startsAt: 0, endsAt: null });
    const id = (added.body.announcement as { id: string }).id;
    expect(added.body.announcement).toMatchObject({ title: "First", level: "important" });

    const updated = await call(base, "PATCH", `/api/announcements/${id}`, { title: "Second" });
    expect(updated.body.announcement).toMatchObject({ title: "Second", level: "info" });

    expect((await call(base, "PATCH", `/api/announcements/${id}`, { title: "" })).status).toBe(400);
    expect((await call(base, "PATCH", "/api/announcements/missing", { title: "No" })).status).toBe(404);
    expect((await call(base, "DELETE", `/api/announcements/${id}`)).status).toBe(200);
    expect((await call(base, "GET", "/api/announcements")).body.announcements).toEqual([]);
  });
});
