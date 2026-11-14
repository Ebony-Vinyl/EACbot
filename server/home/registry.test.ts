// The registry: a failing adapter does not take the others down, a snapshot is reused for a moment, and a
// command that leaves the host lands in the audit trail.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HomeAudit } from "./audit.ts";
import { HomeRegistry } from "./registry.ts";
import type { HomeAdapter, HomeCommand, HomeEntity, HomeReceipt } from "../../shared/home.ts";

const folders: string[] = [];
const folder = () => {
  const created = mkdtempSync(join(tmpdir(), "eac-home-registry-"));
  folders.push(created);
  return created;
};

afterEach(() => {
  for (const created of folders.splice(0)) rmSync(created, { recursive: true, force: true });
});

const entity = (id: string, zone: string | null, name: string): HomeEntity => ({
  entityId: id, adapterId: id.split(":")[0]!, domain: "light", name, zone,
  nativeId: id.split(":")[1]!, available: true, actions: ["turn_on", "turn_off"],
  state: "off", attributes: {}, lastChangedAt: "2026-11-14T00:00:00Z",
});

function fakeAdapter(id: string, entities: HomeEntity[], options: { fail?: boolean; controllable?: boolean } = {}): HomeAdapter & { calls: HomeCommand[] } {
  const calls: HomeCommand[] = [];
  return {
    adapterId: id,
    label: `${id} home`,
    kind: "home-assistant",
    controllable: options.controllable ?? true,
    calls,
    async snapshot() {
      if (options.fail) throw new Error("the adapter broke");
      return { status: "ready" as const, zones: [{ zone: "kitchen", name: "Kitchen" }], entities };
    },
    async control(command: HomeCommand): Promise<HomeReceipt> {
      calls.push(command);
      return { receiptId: "00000000-0000-4000-8000-000000000000", entityId: command.entityId, action: command.action,
        status: "succeeded", observed: entities[0] ?? null, at: "2026-11-14T00:00:00Z" };
    },
  };
}

describe("home registry", () => {
  it("merges every adapter's entities and zones", async () => {
    const registry = new HomeRegistry({
      adapters: [
        fakeAdapter("a", [entity("a:light.one", "kitchen", "One")]),
        fakeAdapter("b", [entity("b:light.two", "kitchen", "Two")]),
      ],
    });
    const snapshot = await registry.snapshot();
    expect(snapshot.entities.map((row) => row.entityId)).toEqual(["a:light.one", "b:light.two"]);
    expect(snapshot.zones).toHaveLength(1);
    await registry.dispose();
  });

  it("keeps a broken adapter from taking the home down", async () => {
    const registry = new HomeRegistry({
      adapters: [
        fakeAdapter("a", [entity("a:light.one", "kitchen", "One")]),
        fakeAdapter("b", [entity("b:light.two", null, "Two")], { fail: true }),
      ],
    });
    const snapshot = await registry.snapshot();
    expect(snapshot.entities).toHaveLength(1);
    const broken = snapshot.adapters.find((adapter) => adapter.adapterId === "b")!;
    expect(broken.status).toBe("unreachable");
    expect(broken.statusReason).toMatch(/broke/);
    await registry.dispose();
  });

  it("reuses a snapshot inside its window and refetches past it", async () => {
    let reads = 0;
    const adapter: HomeAdapter = {
      adapterId: "a", label: "a", kind: "home-assistant", controllable: true,
      async snapshot() { reads += 1; return { status: "ready" as const, zones: [], entities: [entity("a:light.one", null, "One")] }; },
      async control() { throw new Error("unused"); },
    };
    const registry = new HomeRegistry({ adapters: [adapter], cacheMs: 60_000 });
    await registry.snapshot();
    await registry.snapshot();
    expect(reads).toBe(1);
    await registry.snapshot({ force: true });
    expect(reads).toBe(2);
    await registry.dispose();
  });

  it("finds one entity by its id and reports an unknown one as null", async () => {
    const registry = new HomeRegistry({ adapters: [fakeAdapter("a", [entity("a:light.one", "kitchen", "One")])] });
    expect(await registry.entity("a:light.one")).toMatchObject({ name: "One" });
    expect(await registry.entity("a:light.ghost")).toBeNull();
    expect(await registry.entity("nope:light.one")).toBeNull();
    await registry.dispose();
  });

  it("refuses two adapters claiming one id", () => {
    expect(() => new HomeRegistry({ adapters: [fakeAdapter("a", []), fakeAdapter("a", [])] })).toThrow(/two home adapters/);
  });
});

describe("home audit", () => {
  it("appends a line per command and reads the newest first", () => {
    const audit = new HomeAudit({ dataDir: folder(), now: () => "2026-11-14T10:00:00.000Z" });
    const receipt: HomeReceipt = {
      receiptId: "00000000-0000-4000-8000-000000000001", entityId: "home-assistant:light.kitchen",
      action: "turn_on", status: "succeeded", observed: null, at: "2026-11-14T10:00:00.000Z",
    };
    audit.record(receipt, "person", { entityName: "Kitchen light", value: 1 });
    audit.record({ ...receipt, receiptId: "00000000-0000-4000-8000-000000000002", action: "turn_off", status: "indeterminate", code: "timeout" }, "bot:abc", { threadId: "t1" });
    const entries = audit.recent();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ action: "turn_off", status: "indeterminate", actor: "bot:abc", threadId: "t1", code: "timeout" });
    expect(entries[1]).toMatchObject({ action: "turn_on", actor: "person", entityName: "Kitchen light", value: 1 });
  });

  it("writes one JSON object per line so a person can read it", () => {
    const dataDir = folder();
    const audit = new HomeAudit({ dataDir });
    audit.record({ receiptId: "00000000-0000-4000-8000-000000000003", entityId: "a:light.one", action: "turn_on",
      status: "succeeded", observed: null, at: "2026-11-14T00:00:00Z" }, "person");
    const lines = readFileSync(join(dataDir, "home-audit.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ action: "turn_on", actor: "person" });
  });

  it("answers nothing for a home that has never been touched", () => {
    expect(new HomeAudit({ dataDir: folder() }).recent()).toEqual([]);
  });
});
