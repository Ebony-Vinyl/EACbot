import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SavedPanels } from "./plugins/saved-panels.ts";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { createHarnessClient } from "./drivers/agents-client.ts";
import { callTool } from "./drivers/agents-call.ts";

it("passes shared memory to the real turn and rebuilds provider context after revocation", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_VERSION: "2.1.319" });
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const result = await response.json() as Record<string, any>;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    const { bots } = await request("/api/bots");
    const botId = bots[0].id as string;
    await request("/api/config", "PATCH", { profile: { aboutMe: "OWNER_PRIVATE_MARKER_71" } });
    await request("/api/memory-spaces", "POST", { spaceId: "taste", name: "Taste", audience: "shared", members: [{ botId, access: "read-write" }] });
    await request("/api/memory-spaces/taste/entries", "POST", { botId, revision: 1, text: "SHARED_MUSIC_MARKER_82", sensitivity: "normal" });
    await request("/api/memory-spaces/taste/entries", "POST", { botId, revision: 2, text: "SHARED_PRIVATE_MARKER_93", sensitivity: "private" });
    const { account } = await request("/api/platforms/accounts", "POST", { platform: "qq", externalAccountId: "999", displayName: "Fixture QQ" });
    await request(`/api/platforms/accounts/${account.accountId}/bind`, "POST", { mode: "existing", botId });
    await request(`/api/platforms/accounts/${account.accountId}/identities`, "POST", { externalPersonId: "123", personId: "owner", role: "owner" });
    const inbound = (eventId: string, text: string) => request("/api/platforms/inbound", "POST", {
      eventId, platform: "qq", accountId: account.accountId, conversation: { kind: "group", id: "456" },
      sender: { id: "123", name: "Fixture owner" }, text, receivedAt: new Date().toISOString(),
    });
    const first = await inbound("event-1", "FIRST_TURN_CONTEXT_MARKER_04");
    const threadId = first.threadId as string;
    const waitIdle = async () => {
      await expect.poll(async () => {
        const state = await request("/api/bots");
        const bot = state.bots.find((one: { id: string }) => one.id === botId);
        return bot.tasks.find((task: { threadId: string }) => task.threadId === threadId)?.busy === true;
      }, { timeout: 30_000 }).toBe(false);
    };
    await waitIdle();
    const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { pid: number; systemPrompt: string; prompt: unknown; argv: string[] };
    const firstDump = dump();
    expect(firstDump.systemPrompt).toContain("SHARED_MUSIC_MARKER_82");
    expect(firstDump.systemPrompt).not.toContain("OWNER_PRIVATE_MARKER_71");
    expect(firstDump.systemPrompt).not.toContain("SHARED_PRIVATE_MARKER_93");
    expect(firstDump.argv).toContain("--restricted");
    await request("/api/memory-spaces/taste/revoke", "POST", { revision: 3 });
    await request(`/api/memory-spaces/taste/members/${botId}?revision=4`, "DELETE");
    await inbound("event-2", "SECOND_TURN_CONTEXT_MARKER_15");
    await waitIdle();
    const secondDump = dump();
    expect(secondDump.systemPrompt).not.toContain("SHARED_MUSIC_MARKER_82");
    expect(JSON.stringify(secondDump.prompt)).not.toContain("FIRST_TURN_CONTEXT_MARKER_04");
    expect(secondDump.pid).not.toBe(firstDump.pid);
  } finally {
    await fixture.close();
  }
}, 90_000);


it("routes platform memory tools through the live turn capability and invalidates it on revocation", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_VERSION: "2.1.319", FAKE_CLAUDE_MODE: "hang" });
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    return await response.json() as Record<string, any>;
  };
  try {
    const { bots } = await request("/api/bots");
    const botId = bots[0].id as string;
    await request("/api/memory-spaces", "POST", {
      spaceId: "shared-tools", name: "Shared tools", audience: "shared", members: [{ botId, access: "read-write" }],
    });
    const { account } = await request("/api/platforms/accounts", "POST", { platform: "qq", externalAccountId: "999", displayName: "Fixture QQ" });
    await request(`/api/platforms/accounts/${account.accountId}/bind`, "POST", { mode: "existing", botId });
    await request(`/api/platforms/accounts/${account.accountId}/identities`, "POST", { externalPersonId: "123", personId: "owner", role: "owner" });
    const inbound = await request("/api/platforms/inbound", "POST", {
      eventId: "tool-event", platform: "qq", accountId: account.accountId, conversation: { kind: "group", id: "456" },
      sender: { id: "123" }, text: "Remember shared preferences", receivedAt: new Date().toISOString(),
    });
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 30_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const gate = dump.mcpConfig.mcpServers.agents;
    const env = gate.env.EAC_GATE_UPSTREAM ? JSON.parse(gate.env.EAC_GATE_UPSTREAM).env : gate.env;
    const client = createHarnessClient(fixture.info.url, env.EAC_COMMS_TOKEN);
    const context = { botId, threadId: inbound.threadId as string, depth: 0, externalRuntime: false, sharedComputers: false, client };
    const written = await callTool("memory_update", {
      space_id: "shared-tools", expected_revision: 1, action: "append", text: "SHARED_TOOL_MARKER_64",
    }, context);
    expect(written.isError).not.toBe(true);
    const entries = await request(`/api/memory-spaces/shared-tools?botId=${botId}`);
    expect(entries.entries).toMatchObject([{ text: "SHARED_TOOL_MARKER_64", provenance: { platform: "qq", conversationId: "456" } }]);
    const recalled = await client.api(`/api/internal/session-search?fromBotId=${botId}&q=SHARED_TOOL_MARKER_64&scope=memory`);
    expect(recalled.memoryHits).toMatchObject([{ snippet: "SHARED_TOOL_MARKER_64" }]);
    expect((await client.apiResponse("/api/internal/memory/log", { method: "POST", body: JSON.stringify({ text: "private write" }) })).status).toBe(403);
    const targets = await request("/api/plugins/grant-targets");
    expect(targets.targets).toMatchObject([{ botId, principalId: "owner", audienceId: expect.stringContaining(":group:456") }]);
    await request("/api/memory-spaces/shared-tools/revoke", "POST", { revision: 2 });
    expect((await client.apiResponse(`/api/internal/session-search?fromBotId=${botId}&q=SHARED_TOOL_MARKER_64`)).status).toBe(401);
  } finally {
    await fixture.close();
  }
}, 90_000);

it("generates a validated panel through the configured fake model and restores it from disk", async () => {
  const spec = { schemaVersion: 1, title: "Fixture tasks", slot: "workspace", items: [{ type: "data", source: "tasks" }] };
  const folder = mkdtempSync(join(tmpdir(), "eac-panel-model-"));
  const textFile = join(folder, "reply.txt");
  writeFileSync(textFile, JSON.stringify(spec));
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_VERSION: "2.1.319", FAKE_CLAUDE_TEXT_FILE: textFile });
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json() as Record<string, any>;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    const { bots } = await request("/api/bots");
    const generated = await request("/api/plugins/ui/generate", "POST", { botId: bots[0].id, prompt: "显示任务面板" });
    expect(generated.spec).toEqual(spec);
    await request("/api/plugins/ui/panels", "POST", { panelId: "fixture-panel", expectedRevision: 0, spec: generated.spec });
    expect((await request("/api/plugins/ui")).saved).toMatchObject([{ panelId: "fixture-panel", revision: 1, spec }]);
    expect(new SavedPanels(fixture.info.dataDir).list()).toMatchObject([{ panelId: "fixture-panel", revision: 1, spec }]);
  } finally {
    await fixture.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, 90_000);
