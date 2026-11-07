// The floating Live2D companion on the web app: browsers subscribe to the command stream, and bots
// (loopback callers) or the owner's session push commands through POST /api/mascot/cmd.
import type { ServerResponse } from "node:http";
import { PASS, type RouteHandler } from "./table.ts";

const clients = new Set<ServerResponse>();
let pinger: ReturnType<typeof setInterval> | undefined;

function broadcast(line: string): number {
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
  return clients.size;
}

function drop(res: ServerResponse): void {
  clients.delete(res);
  if (clients.size === 0 && pinger) {
    clearInterval(pinger);
    pinger = undefined;
  }
}

export function createMascotRoutes(): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/mascot/")) return PASS;
    if (auth.kind !== "loopback" && auth.kind !== "session") {
      json(res, 403, { error: "Not allowed." });
      return;
    }

    if (method === "GET" && path === "/api/mascot/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      if (!pinger) pinger = setInterval(() => broadcast(": ping\n\n"), 25_000);
      res.on("close", () => drop(res));
      req.on("close", () => drop(res));
      return;
    }

    if (method === "POST" && path === "/api/mascot/cmd") {
      const body: unknown = await readBody(req, 16_384);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(res, 400, { error: "The command was not valid." });
        return;
      }
      const size = broadcast(`data: ${JSON.stringify(body)}\n\n`);
      json(res, 200, { ok: true, clients: size });
      return;
    }

    json(res, 404, { error: "Not found." });
  };
}
