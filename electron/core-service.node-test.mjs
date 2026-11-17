import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createCoreService } from "./core-service.mjs";

test("desktop-owned core authorizes, isolates origins, and recovers after a child restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eac-core-desktop-"));
  const children = [];
  const service = createCoreService({
    entry: resolve("core/bootstrap/main.ts"), dataDir: () => directory,
    origin: () => "http://127.0.0.1:5199", source: true,
    spawn: (entry, args, options) => { const child = fork(entry, args, { ...options, env: { ...options.env, HOME: directory, PATH: directory } }); children.push(child); return child; },
  });
  try {
    const first = await service.connect();
    assert.equal(first.session.scope, "owner");
    const endpoint = first.baseUrl + "/agents";
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: { authorization: `Bearer ${first.token}`, origin: "https://untrusted.example" } })).status, 403);
    const response = await fetch(endpoint, { headers: { authorization: `Bearer ${first.token}`, origin: "http://127.0.0.1:5199" } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).agents, []);
    const computers = await fetch(first.baseUrl + "/environments", { headers: { authorization: `Bearer ${first.token}` } }).then(response => response.json());
    assert.equal(computers.environments[0].kind, "local");
    assert.equal(computers.environments[0].label, "这台电脑");
    const herdrEndpoint = first.baseUrl + "/herdr/sessions";
    assert.equal((await fetch(herdrEndpoint)).status, 401);
    const herdrResponse = await fetch(herdrEndpoint, { headers: { authorization: `Bearer ${first.token}` } });
    assert.equal(herdrResponse.status, 200);
    assert.deepEqual(await herdrResponse.json(), { sessions: [] });
    const exit = once(children[0], "exit"); children[0].kill(); await exit;
    const second = await service.connect();
    assert.notEqual(second.token, first.token);
    assert.equal((await fetch(second.baseUrl + "/agents", { headers: { authorization: `Bearer ${first.token}` } })).status, 401);
    assert.equal((await fetch(second.baseUrl + "/agents", { headers: { authorization: `Bearer ${second.token}` } })).status, 200);
  } finally {
    const exits = children.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, "exit"));
    service.stop(); await Promise.all(exits); rmSync(directory, { recursive: true, force: true });
  }
});
