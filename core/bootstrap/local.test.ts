import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { discoverLocalComputer, localAgents } from "../environments/local.ts";
import { EnvironmentStore } from "../environments/store.ts";
import { EnvironmentStorePort } from "./environments.ts";

it("discovers only installed CLIs and exposes a non-removable local computer without SSH", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eac-local-"));
  try {
    writeFileSync(join(directory, "codex"), '#!/bin/sh\nprintf "codex-cli 1.2.3\\n"\n', { mode: 0o700 });
    writeFileSync(join(directory, "opencode"), '#!/bin/sh\nprintf "1.2.3\\n"\n', { mode: 0o700 });
    const local = await discoverLocalComputer({ HOME: directory, PATH: directory });
    expect(local.tools.find(tool => tool.name === "codex")).toMatchObject({ status: "installed", version: "1.2.3" });
    expect(local.tools.find(tool => tool.name === "claude")?.status).toBe("missing");
    expect(localAgents(local).map(agent => agent.agentId)).toEqual(["codex"]);
    const port = new EnvironmentStorePort({ store: EnvironmentStore.open({ dataDir: directory }), local, runner: async () => { throw new Error("must not run SSH"); } });
    expect(port.list()[0]).toMatchObject({ id: "local", kind: "local", status: "online" });
    expect((await port.check("local")).reachable).toBe(true);
    await expect(port.remove("local")).rejects.toThrow("cannot be removed");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
