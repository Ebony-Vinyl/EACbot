import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MissionRuntime } from "../missions/runtime.ts";
import { FakeAdapterRegistry } from "../missions/fake-registry.ts";
import { IdentityService } from "../identity/service.ts";
import { AgentCatalog } from "./agents.ts";
import { InMemoryEnvironmentStore } from "./environments.ts";
import { missionPort } from "./missions.ts";
import { composeServer } from "./server.ts";
import { startServer, type StartedServer } from "./start.ts";
import type { TerminalRef } from "../../packages/agent-protocol/terminal.ts";
import { capabilitiesFor } from "../missions/capabilities.ts";

const open: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!();
});

describe("composition against the real mission runtime", () => {
  it("creates a mission, streams a notification and answers a snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-http-"));
    const adapters = new FakeAdapterRegistry();
    const runtime = new MissionRuntime({
      databasePath: join(dir, "missions.db"),
      adapters: (kind) => adapters.get(kind),
    });
    const identity = new IdentityService();
    const terminals: TerminalRef[] = [];
    const composed = composeServer({
      missions: missionPort(runtime),
      identity,
      agents: new AgentCatalog({ kinds: ["hermes"], describe: (kind) => adapters.get(kind)?.describe() }),
      environments: new InMemoryEnvironmentStore({ now: () => new Date().toISOString() }),
      terminals: { list: () => terminals, get: (id) => terminals.find((terminal) => terminal.id === id) },
      terminalStreams: { open: () => ({ receive: () => {}, close: () => {} }) },
    });
    open.push(async () => {
      await composed.shutdown();
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    });

    await new Promise<void>((resolve) => composed.layer.server.listen(0, "127.0.0.1", () => resolve()));
    const address = composed.layer.server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const code = identity.issuePairingCode();
    const paired = identity.pair({ code: code.code, label: "cli", loopback: true, requestedScope: "owner" });

    const created = await fetch(`${base}/api/v1/missions`, {
      method: "POST",
      headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        commandId: "create-1",
        title: "demo",
        prompt: "go",
        agent: "hermes",
        environment: { id: "env-1", label: "box", kind: "ssh", authMode: "subscription" },
      }),
    });
    expect(created.status).toBe(201);
    const result = (await created.json()) as { missionId: string };
    expect(composed.events.cursor).toBe(1);

    const snapshot = await fetch(`${base}/api/v1/missions/${result.missionId}`, {
      headers: { authorization: `Bearer ${paired.token}` },
    });
    expect(snapshot.status).toBe(200);
    const body = (await snapshot.json()) as { mission: { id: string; agent: string; runIds: string[] } };
    expect(body.mission.id).toBe(result.missionId);
    expect(body.mission.agent).toBe("hermes");
    expect(body.mission.runIds.length).toBeGreaterThan(0);

    const events = await fetch(`${base}/api/v1/missions/${result.missionId}/history`, {
      headers: { authorization: `Bearer ${paired.token}` },
    });
    const history = (await events.json()) as { events: { type: string }[] };
    expect(history.events.some((entry) => entry.type === "mission.accepted")).toBe(true);

    const agents = await fetch(`${base}/api/v1/agents`, { headers: { authorization: `Bearer ${paired.token}` } });
    const agentBody = (await agents.json()) as { agents: { kind: string; capabilities: unknown }[] };
    expect(agentBody.agents[0]?.kind).toBe("hermes");
    expect(agentBody.agents[0]?.capabilities).toEqual(capabilitiesFor("hermes"));
  });
});

describe("startServer", () => {
  it("binds loopback by default and prints the pairing code once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eac-start-"));
    const runtime = new MissionRuntime({
      databasePath: join(dir, "missions.db"),
      adapters: () => undefined,
    });
    const printed: string[] = [];
    let started: StartedServer | undefined;
    let closed = false;
    const closeRuntime = (): void => {
      if (closed) return;
      closed = true;
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    };
    try {
      started = await startServer({
        runtime,
        agents: new AgentCatalog({ kinds: ["hermes"], describe: () => undefined }),
        environments: new InMemoryEnvironmentStore({ now: () => new Date().toISOString() }),
        terminals: { list: () => [], get: () => undefined, start: async () => { throw new Error("terminals are not configured"); } },
        terminalStreams: { open: () => ({ receive: () => {}, close: () => {} }) },
        listen: { port: 0 },
        printPairingCode: (view) => printed.push(view.code),
      });
      open.push(async () => {
        await started?.shutdown();
        closeRuntime();
      });

      expect(started.host).toBe("127.0.0.1");
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(printed).toEqual([started.pairing.code]);
      expect(started.pairing.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);

      const health = await fetch(`${started.url}/api/v1/health`);
      const body = (await health.json()) as { pairing: boolean };
      expect(body.pairing).toBe(true);

      const claim = await fetch(`${started.url}/api/v1/pairing/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: started.pairing.code, label: "desktop", scope: "owner" }),
      });
      expect(claim.status).toBe(201);
      const issued = (await claim.json()) as { token: string };
      expect((await fetch(`${started.url}/api/v1/agents`, { headers: { authorization: `Bearer ${issued.token}` } })).status).toBe(200);
    } finally {
      await started?.shutdown();
      closeRuntime();
    }
  });
});
