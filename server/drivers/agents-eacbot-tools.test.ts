import { describe, expect, it } from "vitest";

import { availableTools, catalogProfileFromEnv, fullInputSchema } from "./agents-catalog.ts";
import { EACBOT_TOOL_DEFINITIONS } from "./agents-eacbot-tools.ts";

const listed = (env: Record<string, string>) => availableTools(catalogProfileFromEnv({ EAC_BOT_ID: "eacbot", EAC_CHIEF_OF_STAFF: "1", ...env }));

describe("EACbot's two notification tools on the wire", () => {
  const eacbot = listed({ EAC_BOT_TOOLS: "1" }).slice(-2) as Array<{ name: string; inputSchema: Record<string, any> }>;

  it("are listed last, in this order, only with EAC_BOT_TOOLS", () => {
    expect(eacbot.map((tool) => tool.name)).toEqual(["list_unread_notifications", "mark_notifications_read"]);
    for (const env of [{}, { EAC_BOT_TOOLS: "0" }, { EAC_BOT_TOOLS: "true" }] as Array<Record<string, string>>) {
      expect(listed(env).map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["mark_notifications_read"]));
    }
  });

  it("keep flat, closed schemas with the required fields", () => {
    expect(eacbot.map((tool) => [tool.inputSchema.type, tool.inputSchema.additionalProperties, Object.keys(tool.inputSchema.properties), tool.inputSchema.required ?? []])).toEqual([
      ["object", false, [], []],
      ["object", false, ["ids"], ["ids"]],
    ]);
    expect(eacbot[1]!.inputSchema.properties.ids).toEqual({ type: "array", items: { type: "string" } });
    expect(fullInputSchema("mark_notifications_read")).toMatchObject({ properties: { ids: { type: "array", maxItems: 40 } } });
    expect(JSON.stringify(EACBOT_TOOL_DEFINITIONS)).not.toMatch(/"(oneOf|anyOf|allOf|const|format)"/);
  });
});
