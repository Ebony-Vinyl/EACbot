// What a plugin form may ask for, and what the host will write. The subset is small on purpose: an unfamiliar schema
// must be refused rather than half-honoured, and a secret must never travel back out of the server.
import { describe, expect, it } from "vitest";

import { parsePluginConfigSchema, pluginConfigView, pluginConfigWrite, undeclaredKeys } from "../../shared/plugins/config.ts";

const schema = (input: unknown) => {
  const parsed = parsePluginConfigSchema(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.schema;
};

const QQ = {
  type: "object",
  properties: {
    onebotUrl: { type: "string", description: "OneBot address" },
    accountId: { type: "string" },
    onebotToken: { type: "string", secret: true },
    pollMs: { type: "number" },
    verbose: { type: "boolean" },
  },
  required: ["onebotUrl", "accountId"],
  additionalProperties: false,
} as const;

describe("config schema", () => {
  it("accepts every bundled plugin's schema", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "..", "..", "plugins", "eac");
    const packs = readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory());
    expect(packs.length).toBeGreaterThan(8);
    for (const pack of packs) {
      const file = join(root, pack, "config.schema.json");
      const parsed = parsePluginConfigSchema(JSON.parse(readFileSync(file, "utf8")));
      expect(parsed.ok, `${pack}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
    }
  });

  it("refuses a schema it cannot render instead of guessing", () => {
    expect(parsePluginConfigSchema({ type: "object", properties: { a: { type: "array" } } }).ok).toBe(false);
    expect(parsePluginConfigSchema({ type: "object", properties: { a: { type: "object" } } }).ok).toBe(false);
    expect(parsePluginConfigSchema({ type: "array" }).ok).toBe(false);
    // A key a form could not name safely is refused at the schema, not at the write.
    expect(parsePluginConfigSchema({ type: "object", properties: { "bad key": { type: "string" } } }).ok).toBe(false);
  });

  it("refuses a required field the schema never declares", () => {
    const parsed = parsePluginConfigSchema({ type: "object", properties: { a: { type: "string" } }, required: ["b"] });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toMatch(/required names b/);
  });
});

describe("what the form shows", () => {
  it("reports a stored secret as set, never in the clear", () => {
    const view = pluginConfigView(schema(QQ), {
      onebotUrl: "ws://127.0.0.1:3001", accountId: "abc", onebotToken: "super-secret-token",
    });
    expect(view.values.onebotUrl).toBe("ws://127.0.0.1:3001");
    expect(view.values.onebotToken).toEqual({ set: true });
    expect(JSON.stringify(view)).not.toContain("super-secret-token");
  });

  it("lists the required fields that have no value yet", () => {
    expect(pluginConfigView(schema(QQ), {}).missing).toEqual(["onebotUrl", "accountId"]);
    expect(pluginConfigView(schema(QQ), { onebotUrl: "ws://x" }).missing).toEqual(["accountId"]);
  });

  it("keeps the schema's field order, so the form does not shuffle between loads", () => {
    expect(pluginConfigView(schema(QQ), {}).fields.map((field) => field.key))
      .toEqual(["onebotUrl", "accountId", "onebotToken", "pollMs", "verbose"]);
  });

  it("reports a stored key the schema dropped, so a form can say it will be removed", () => {
    expect(undeclaredKeys(schema(QQ), { onebotUrl: "ws://x", retired: 1 })).toEqual(["retired"]);
  });
});

describe("what the host writes", () => {
  it("refuses a key the schema does not declare", () => {
    const written = pluginConfigWrite(schema(QQ), {}, { onebotUrl: "ws://x", accountId: "a", injected: "x" });
    expect(written.ok).toBe(false);
    expect(written.ok ? "" : written.error).toMatch(/not a field/);
  });

  it("refuses a write that leaves a required field empty", () => {
    const written = pluginConfigWrite(schema(QQ), {}, { onebotUrl: "ws://x" });
    expect(written.ok).toBe(false);
    expect(written.ok ? "" : written.error).toMatch(/accountId is required/);
  });

  it("keeps a stored secret when the form submits an empty box", () => {
    const written = pluginConfigWrite(
      schema(QQ),
      { onebotUrl: "ws://old", accountId: "a", onebotToken: "kept" },
      { onebotUrl: "ws://new", accountId: "a", onebotToken: "" },
    );
    expect(written.ok && written.config).toEqual({ onebotUrl: "ws://new", accountId: "a", onebotToken: "kept" });
  });

  it("replaces a stored secret when the form submits a new one", () => {
    const written = pluginConfigWrite(
      schema(QQ),
      { onebotUrl: "ws://x", accountId: "a", onebotToken: "old" },
      { onebotToken: "new" },
    );
    expect(written.ok && written.config.onebotToken).toBe("new");
  });

  it("clears a non-secret field left empty, and drops keys the schema no longer declares", () => {
    const written = pluginConfigWrite(
      schema(QQ),
      { onebotUrl: "ws://x", accountId: "a", pollMs: 500, retired: "gone" },
      { onebotUrl: "" },
    );
    // `retired` is undeclared, so it is not carried over; `onebotUrl` was cleared but is required, so the write fails.
    expect(written.ok).toBe(false);
    const kept = pluginConfigWrite(schema(QQ), { onebotUrl: "ws://x", accountId: "a", pollMs: 500, retired: "gone" }, {});
    expect(kept.ok && kept.config).toEqual({ onebotUrl: "ws://x", accountId: "a", pollMs: 500 });
  });

  it("coerces a number field and refuses one that is not a number", () => {
    expect(pluginConfigWrite(schema(QQ), {}, { onebotUrl: "ws://x", accountId: "a", pollMs: "250" }))
      .toMatchObject({ ok: true, config: { pollMs: 250 } });
    const bad = pluginConfigWrite(schema(QQ), {}, { onebotUrl: "ws://x", accountId: "a", pollMs: "soon" });
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.error).toMatch(/must be a number/);
  });

  it("refuses a value outside a field's enum, and accepts one inside it", () => {
    const withEnum = schema({
      type: "object",
      properties: { mode: { type: "string", enum: ["direct", "group"] } },
    });
    expect(pluginConfigWrite(withEnum, {}, { mode: "direct" }).ok).toBe(true);
    const bad = pluginConfigWrite(withEnum, {}, { mode: "channel" });
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.error).toMatch(/must be one of direct, group/);
  });

  it("refuses a boolean field that is not a boolean, rather than reading \"false\" as true", () => {
    const bad = pluginConfigWrite(schema(QQ), {}, { onebotUrl: "ws://x", accountId: "a", verbose: "false" });
    expect(bad.ok).toBe(false);
  });
});
