// The home tools a bot may call. A read is a read; every change goes through the policy first, and a sensitive
// one waits for the person's own yes before the adapter is touched.
import type { HomeAudit } from "./audit.ts";
import type { HomePolicy } from "./policy.ts";
import { homeVerdict } from "./policy.ts";
import type { HomeRegistry } from "./registry.ts";
import {
  HOME_ACTIONS,
  HOME_DOMAINS,
  type HomeAction,
  type HomeCommand,
  type HomeEntity,
  type HomeReceipt,
} from "../../shared/home.ts";

export interface HomeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TEXT = (max: number, description: string) => ({ type: "string", maxLength: max, description });

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): HomeTool {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

export const HOME_TOOLS: readonly HomeTool[] = [
  tool("HOME_LIST", "List the home's devices: name, zone, kind, whether it is reachable, and the commands it accepts. Read only.",
    {
      zone: TEXT(64, "Only this zone, e.g. living-room."),
      domain: { type: "string", enum: [...HOME_DOMAINS], description: "Only devices of this kind, e.g. light." },
      query: TEXT(120, "Only devices whose name contains this text."),
    }),
  tool("HOME_GET", "Read one device's state and attributes by its id from HOME_LIST.", {
    entityId: TEXT(200, "The device id from HOME_LIST."),
  }),
  tool("HOME_ZONES", "List the home's zones and how many devices each holds. Read only.", {}),
  tool("HOME_CONTROL", "Send one command to one device. Say what you changed and read the state back before claiming it worked.",
    {
      entityId: TEXT(200, "The device id from HOME_LIST."),
      action: { type: "string", enum: [...HOME_ACTIONS], description: "What to do, e.g. turn_on." },
      value: { type: ["string", "number", "boolean"], description: "What the action needs: 60 for brightness percent, 21.5 for a temperature, \"warm_white\" for a mode." },
    }, ["entityId", "action"]),
  tool("HOME_HISTORY", "Recent home commands and what came back. Read only.", {
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Entries to return. Default 20." },
  }),
];

export type HomeToolName = (typeof HOME_TOOLS)[number]["name"];

const byName = new Map(HOME_TOOLS.map((entry) => [entry.name, entry]));

export function isHomeToolName(name: unknown): name is HomeToolName {
  return typeof name === "string" && byName.has(name);
}

export function homeTool(name: HomeToolName): HomeTool {
  return byName.get(name)!;
}

export interface HomeToolContext {
  registry: HomeRegistry;
  audit: HomeAudit;
  policy(): HomePolicy;
  /** Asks the person to approve a sensitive action; false means they did not, or nothing could ask. */
  confirm?(command: HomeCommand, entity: HomeEntity): Promise<boolean>;
  actor(): { id: string; threadId?: string };
}

export interface HomeToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const ok = (value: unknown): HomeToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (code: string, message: string): HomeToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
  isError: true,
});

/** A device as a bot should see it: no vendor internals, only what a person would read on a card. */
function brief(entity: HomeEntity) {
  return {
    entityId: entity.entityId,
    name: entity.name,
    domain: entity.domain,
    zone: entity.zone,
    available: entity.available,
    state: entity.state,
    actions: entity.actions,
    attributes: entity.attributes,
  };
}

export async function runHomeTool(context: HomeToolContext, name: string, args: Record<string, unknown>): Promise<HomeToolResult> {
  if (!isHomeToolName(name)) return fail("unknown_tool", `no home tool named "${String(name).slice(0, 60)}"`);
  try {
    switch (name) {
      case "HOME_LIST": {
        const snapshot = await context.registry.snapshot();
        const zone = typeof args.zone === "string" && args.zone.trim() ? args.zone.trim() : null;
        const domain = typeof args.domain === "string" && (HOME_DOMAINS as readonly string[]).includes(args.domain) ? args.domain : null;
        const query = typeof args.query === "string" && args.query.trim() ? args.query.trim().toLowerCase() : null;
        const entities = snapshot.entities.filter((entity) => {
          if (zone && entity.zone !== zone) return false;
          if (domain && entity.domain !== domain) return false;
          if (query && !`${entity.name} ${entity.nativeId} ${entity.zone ?? ""}`.toLowerCase().includes(query)) return false;
          return true;
        });
        return ok({
          adapters: snapshot.adapters.map((adapter) => ({ adapterId: adapter.adapterId, label: adapter.label, status: adapter.status, entityCount: adapter.entityCount })),
          count: entities.length,
          entities: entities.slice(0, 300).map(brief),
        });
      }
      case "HOME_GET": {
        if (typeof args.entityId !== "string") return fail("unknown_entity", `entityId is required: e.g. "home-assistant:light.kitchen"`);
        const entity = await context.registry.entity(args.entityId);
        if (!entity) return fail("unknown_entity", `no device "${args.entityId.slice(0, 120)}"; call HOME_LIST first`);
        return ok(brief(entity));
      }
      case "HOME_ZONES": {
        const snapshot = await context.registry.snapshot();
        const counts = new Map<string, number>();
        for (const entity of snapshot.entities) counts.set(entity.zone ?? "", (counts.get(entity.zone ?? "") ?? 0) + 1);
        return ok({
          zones: snapshot.zones.map((zone) => ({ ...zone, devices: counts.get(zone.zone) ?? 0 })),
          unzoned: counts.get("") ?? 0,
        });
      }
      case "HOME_CONTROL": {
        if (typeof args.entityId !== "string") return fail("unknown_entity", `entityId is required: e.g. "home-assistant:light.kitchen"`);
        if (!HOME_ACTIONS.includes(args.action as HomeAction)) {
          return fail("unsupported_action", `action must be one of ${HOME_ACTIONS.join(", ")}: e.g. "turn_on"`);
        }
        const entity = await context.registry.entity(args.entityId);
        if (!entity) return fail("unknown_entity", `no device "${args.entityId.slice(0, 120)}"; call HOME_LIST first`);
        const action = args.action as HomeAction;
        const verdict = homeVerdict(context.policy(), entity, action);
        if (!verdict.ok) return fail(verdict.code, verdict.message);
        const command: HomeCommand = {
          entityId: entity.entityId,
          action,
          ...(args.value === undefined ? {} : { value: args.value as string | number | boolean }),
        };
        if (verdict.needsConfirmation) {
          const approved = context.confirm ? await context.confirm(command, entity) : false;
          if (!approved) return fail("sensitive_requires_confirmation", `the person did not approve ${action} on ${entity.name}`);
        }
        const adapter = context.registry.adapter(entity.adapterId);
        if (!adapter) return fail("unknown_adapter", `no adapter named "${entity.adapterId}"`);
        if (!adapter.controllable) return fail("adapter_unavailable", `${adapter.label} can only be read in this build`);
        const receipt = await adapter.control(command);
        const actor = context.actor();
        context.audit.record(receipt, actor.id, { ...(actor.threadId ? { threadId: actor.threadId } : {}), entityName: entity.name, ...(command.value === undefined ? {} : { value: command.value }) });
        context.registry.invalidate(entity.adapterId);
        return ok(receiptReport(receipt));
      }
      case "HOME_HISTORY": {
        const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 200) : 20;
        return ok({ entries: context.audit.recent(limit) });
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unknown_entity";
    return fail(code, error instanceof Error ? error.message : String(error));
  }
  return fail("unknown_tool", `no home tool named "${String(name).slice(0, 60)}"`);
}

/**
 * A receipt as a bot should read it. `indeterminate` is spelled out, because the one thing a bot must not do
 * with it is claim the change happened or repeat it.
 */
function receiptReport(receipt: HomeReceipt) {
  return {
    receiptId: receipt.receiptId,
    entityId: receipt.entityId,
    action: receipt.action,
    status: receipt.status,
    ...(receipt.code ? { code: receipt.code } : {}),
    ...(receipt.message ? { message: receipt.message } : {}),
    state: receipt.observed ? { state: receipt.observed.state, available: receipt.observed.available, attributes: receipt.observed.attributes } : null,
    ...(receipt.status === "indeterminate"
      ? { note: "The command may or may not have taken effect. Read the device again before saying anything about it, and do not send it twice." }
      : {}),
  };
}

export const HOME_INSTRUCTIONS = [
  "The home's devices are the person's real house. Read before you act, and read the state back after a change.",
  "A receipt marked indeterminate means the command may or may not have arrived: read the device again, and never send it twice.",
  "A lock, a door and a camera always need the person's own confirmation; do not route around it.",
  "Say which device and which room you changed, in the person's own words for them.",
].join(" ");
