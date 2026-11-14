// The board routes against a fake board host: the HTTP shape a board page depends on, without a plugin process.
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createPlatformBoardRoutes } from "./platform-boards.ts";
import { PlatformBoardError } from "../plugins/platform-boards.ts";
import { dispatchRoutes, PASS } from "./table.ts";
import type { RequestAuth } from "../request-auth.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
});

const OWNER: RequestAuth = { kind: "loopback", trust: "owner" } as RequestAuth;
const CLIENT: RequestAuth = { kind: "token", scopes: ["client"] } as unknown as RequestAuth;

const BOARD = {
  schemaVersion: 1,
  platform: "xianyu",
  generatedAt: "2026-11-14T00:00:00.000Z",
  account: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", displayName: "Shop", status: "connected" },
  headline: [{ key: "inbound", label: "Inbound", value: "2" }],
  sections: [],
  actions: [],
  limits: [],
  capability: [],
};

/** A host stand-in that records what the route asked for. */
function fakeBoards(options: { boardThrows?: Error } = {}) {
  const calls: string[] = [];
  return {
    calls,
    host: {
      bindings: () => [],
      binding: () => null,
      summaries: async () => { calls.push("summaries"); return [{ platform: "xianyu", label: "Xianyu", installationId: null, live: false, account: null, headline: [], state: "missing", blocked: [] }]; },
      summary: async () => { calls.push("summary"); throw new Error("unused"); },
      board: async (platform: string, opts?: { refresh?: boolean }) => {
        calls.push(`board:${platform}:${opts?.refresh ? "refresh" : "cached"}`);
        if (options.boardThrows) throw options.boardThrows;
        return BOARD;
      },
      operate: async (platform: string, action: string) => { calls.push(`operate:${platform}:${action}`); return { ok: true }; },
      audit: async (platform: string, limit: number) => { calls.push(`audit:${platform}:${limit}`); return [{ id: "a1" }]; },
      forget: () => undefined,
    },
  };
}

/** One request through the route table, answering the JSON the route wrote. */
async function request(route: ReturnType<typeof createPlatformBoardRoutes>, method: string, path: string, auth: RequestAuth, body?: unknown) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const answered = await dispatchRoutes([route], {
      req, res, url, path: url.pathname, method, auth,
      json: (response, status, payload) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); },
      readBody: async () => JSON.parse(raw || "{}"),
    });
    if (!answered && !res.headersSent) { res.writeHead(599); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("the platform board routes", () => {
  it("declines a path that is not its own", async () => {
    const { host } = fakeBoards();
    const route = createPlatformBoardRoutes({ boards: host as never, mayManage: () => true });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      const out = await route({ req, res, url, path: url.pathname, method: "GET", auth: OWNER, json: () => undefined, readBody: async () => ({}) } as never);
      res.writeHead(out === PASS ? 204 : 500);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    closers.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const response = await fetch(`http://127.0.0.1:${port}/api/plugins`);
    expect(response.status).toBe(204);
  });

  it("lists every platform, and passes refresh through", async () => {
    const { host, calls } = fakeBoards();
    const route = createPlatformBoardRoutes({ boards: host as never, mayManage: () => true });
    const listed = await request(route, "GET", "/api/platform-boards", OWNER);
    expect(listed.status).toBe(200);
    expect(listed.body.platforms).toHaveLength(1);
    await request(route, "GET", "/api/platform-boards/xianyu?refresh=1", OWNER);
    expect(calls).toContain("board:xianyu:refresh");
  });

  it("answers a board for one platform and refuses one this host does not know", async () => {
    const { host } = fakeBoards();
    const route = createPlatformBoardRoutes({ boards: host as never, mayManage: () => true });
    expect((await request(route, "GET", "/api/platform-boards/xianyu", OWNER)).body.board.platform).toBe("xianyu");
    expect((await request(route, "GET", "/api/platform-boards/myspace", OWNER)).status).toBe(404);
  });

  it("keeps every path owner-only", async () => {
    const { host, calls } = fakeBoards();
    const route = createPlatformBoardRoutes({ boards: host as never, mayManage: (auth) => auth === OWNER });
    expect((await request(route, "GET", "/api/platform-boards", CLIENT)).status).toBe(403);
    expect((await request(route, "POST", "/api/platform-boards/xianyu/operate", CLIENT, { action: "self-check" })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("turns a board the plugin could not build into a 502 that names the reason", async () => {
    const { host } = fakeBoards();
    const failing = { ...host, board: async () => { throw new PlatformBoardError("invalid", "the board does not match the contract: sections.0.kind"); } };
    const route = createPlatformBoardRoutes({ boards: failing as never, mayManage: () => true });
    const answer = await request(route, "GET", "/api/platform-boards/xianyu", OWNER);
    expect(answer.status).toBe(502);
    expect(answer.body.error.message).toContain("sections.0.kind");
  });

  it("runs a board action, and reads the audit with a bounded limit", async () => {
    const { host, calls } = fakeBoards();
    const route = createPlatformBoardRoutes({ boards: host as never, mayManage: () => true });
    const ran = await request(route, "POST", "/api/platform-boards/xianyu/operate", OWNER, { action: "self-check", params: {} });
    expect(ran.body.result).toEqual({ ok: true });
    expect(calls).toContain("operate:xianyu:self-check");

    await request(route, "GET", "/api/platform-boards/xianyu/audit?limit=5", OWNER);
    await request(route, "GET", "/api/platform-boards/xianyu/audit?limit=99999", OWNER);
    expect(calls).toContain("audit:xianyu:5");
    expect(calls).toContain("audit:xianyu:200");
  });

  it("rejects an action name that is not a plain id, before the plugin is asked", async () => {
    const { host, calls } = fakeBoards();
    const route = createPlatformBoardRoutes({ boards: host as never, mayManage: () => true });
    const answer = await request(route, "POST", "/api/platform-boards/xianyu/operate", OWNER, { action: "../etc/passwd" });
    expect(answer.status).toBe(422);
    expect(calls.some((call) => call.startsWith("operate:"))).toBe(false);
  });
});
