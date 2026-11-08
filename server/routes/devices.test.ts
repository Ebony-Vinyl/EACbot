import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { DeviceRegistry } from "../plugins/device-registry.ts";
import { createDeviceRoutes } from "./devices.ts";
import { dispatchRoutes } from "./table.ts";

const owner = { kind: "session", session: { id: "s1" }, via: "bearer", scopes: ["admin", "client"] } as unknown as RequestAuth;
const client = { ...owner, scopes: ["client"] } as unknown as RequestAuth;
const folders: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function serve() {
  const folder = mkdtempSync(join(tmpdir(), "eac-device-routes-"));
  folders.push(folder);
  const devices = new DeviceRegistry(folder);
  const route = createDeviceRoutes({ devices, mayManage: (auth) => auth.kind === "loopback" || auth.scopes.includes("admin") });
  let auth = owner;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "next route" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, setAuth: (next: RequestAuth) => { auth = next; } };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("/api/devices", () => {
  it("is owner/admin only", async () => {
    const { base, setAuth } = await serve();
    setAuth(client);
    expect((await call(base, "GET", "/api/devices")).status).toBe(403);
  });

  it("pairs, sends an idempotent command and records its receipt", async () => {
    const { base } = await serve();
    const pairing = await call(base, "POST", "/api/devices/pairings", {
      name: "Watch", kind: "watch", capabilities: ["notify", "vibrate"],
    });
    expect(pairing.status).toBe(200);
    const { pairingId, code } = pairing.body.pairing as { pairingId: string; code: string };
    const redeemed = await call(base, "POST", `/api/devices/pairings/${pairingId}/redeem`, { code });
    expect(redeemed.status).toBe(200);
    const deviceId = (redeemed.body.device as { deviceId: string }).deviceId;
    expect((await call(base, "POST", `/api/devices/pairings/${pairingId}/redeem`, { code })).status).toBe(409);

    const commandId = crypto.randomUUID();
    const sent = await call(base, "POST", `/api/devices/${deviceId}/commands`, { commandId, capability: "notify", args: { text: "hi" } });
    expect(sent.status).toBe(200);
    expect((await call(base, "POST", `/api/devices/${deviceId}/commands`, { commandId, capability: "notify" })).body.command)
      .toMatchObject({ commandId });
    expect((await call(base, "GET", `/api/devices/${deviceId}/commands`)).body.commands).toHaveLength(1);
    const done = await call(base, "POST", `/api/devices/${deviceId}/commands/${commandId}/result`, { status: "succeeded", result: { shown: true } });
    expect(done.body.command).toMatchObject({ status: "succeeded", result: { shown: true } });
  });

  it("refuses an undeclared capability and a revoked device", async () => {
    const { base } = await serve();
    const pairing = await call(base, "POST", "/api/devices/pairings", { name: "Watch", kind: "watch", capabilities: ["notify"] });
    const { pairingId, code } = pairing.body.pairing as { pairingId: string; code: string };
    const deviceId = ((await call(base, "POST", `/api/devices/pairings/${pairingId}/redeem`, { code })).body.device as { deviceId: string }).deviceId;
    expect((await call(base, "POST", `/api/devices/${deviceId}/commands`, { capability: "lock.open" })).status).toBe(403);
    expect((await call(base, "DELETE", `/api/devices/${deviceId}`)).status).toBe(200);
    expect((await call(base, "POST", `/api/devices/${deviceId}/commands`, { capability: "notify" })).status).toBe(403);
  });

  it("leaves other API paths to the next route", async () => {
    const { base } = await serve();
    expect(await (await fetch(`${base}/api/not-devices`)).json()).toEqual({ from: "next route" });
  });
});
