// Home Assistant's REST API: read states, call services. This adapter owns the HA vocabulary and nothing else:
// it maps HA's domains and services onto the domain's entities and actions, and reports what HA answered.
// The WebSocket API is not used here; a poll on read is enough for a view and a chat turn.
import { randomUUID } from "node:crypto";

import {
  HOME_ACTIONS,
  homeDomainAllows,
  type HomeAction,
  type HomeAdapter,
  type HomeAdapterStatus,
  type HomeCommand,
  type HomeDomain,
  type HomeEntity,
  type HomeReceipt,
  type HomeZone,
} from "../../../shared/home.ts";

/** HA domains this adapter maps; anything else becomes `other` and stays read-only. */
const DOMAIN_MAP: Readonly<Record<string, HomeDomain>> = {
  light: "light",
  switch: "switch",
  input_boolean: "switch",
  outlet: "plug",
  plug: "plug",
  cover: "cover",
  climate: "climate",
  fan: "fan",
  lock: "lock",
  sensor: "sensor",
  binary_sensor: "binary_sensor",
  camera: "camera",
  media_player: "media_player",
  vacuum: "vacuum",
  scene: "scene",
  script: "script",
  humidifier: "humidifier",
  water_heater: "water_heater",
};

/** HA services that carry the domain's actions, per domain. */
const ACTION_SERVICE: Partial<Record<HomeAction, string>> = {
  turn_on: "turn_on",
  turn_off: "turn_off",
  toggle: "toggle",
  open: "open_cover",
  close: "close_cover",
  stop: "stop",
  lock: "lock",
  unlock: "unlock",
  play: "media_play",
  pause: "media_pause",
  activate: "turn_on",
};

export interface HomeAssistantConfig {
  baseUrl: string;
  token: string;
  /** Optional name for the home, shown instead of the host. */
  label?: string;
  /** Entity ids or `domain.` prefixes to leave out entirely. */
  exclude?: readonly string[];
}

export class HomeAssistantError extends Error {
  readonly code: "unreachable" | "unauthorized" | "not_found" | "bad_request" | "server" | "timeout";
  constructor(code: HomeAssistantError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const ENTITY = /^[a-z0-9_]+\.[a-z0-9_]+$/;

function domainOf(entityId: string): string {
  return entityId.slice(0, entityId.indexOf("."));
}

/** HA reports a light's brightness 0-255; the domain speaks percent. */
function brightnessPercent(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round((number / 255) * 100);
}

function actionsFor(domain: HomeDomain, state: string): HomeAction[] {
  const base = HOME_ACTIONS.filter((action) => homeDomainAllows(domain, action));
  if (domain === "scene" || domain === "script") return ["activate"];
  // A lock is read from its own state: `locked` can be unlocked and the reverse, never both from a blind guess.
  if (domain === "lock") return state === "locked" ? ["unlock"] : ["lock"];
  return base;
}

/** The service call for one action, and the data that goes with it. Null when this domain has no such service. */
export function serviceCallFor(entity: HomeEntity, command: HomeCommand): { domain: string; service: string; data: Record<string, unknown> } | null {
  const native = entity.nativeId.slice(0, entity.nativeId.indexOf("."));
  const data: Record<string, unknown> = { entity_id: entity.nativeId };
  switch (command.action) {
    case "set_brightness": {
      const percent = Number(command.value);
      if (!Number.isFinite(percent)) return null;
      return { domain: "light", service: "turn_on", data: { ...data, brightness_pct: Math.min(Math.max(Math.round(percent), 1), 100) } };
    }
    case "set_color_temperature": {
      const kelvin = Number(command.value);
      if (!Number.isFinite(kelvin)) return null;
      return { domain: "light", service: "turn_on", data: { ...data, kelvin: Math.min(Math.max(Math.round(kelvin), 2000), 6500) } };
    }
    case "set_color": {
      if (typeof command.value !== "string") return null;
      return { domain: "light", service: "turn_on", data: { ...data, color_name: command.value.slice(0, 40) } };
    }
    case "set_position": {
      const position = Number(command.value);
      if (!Number.isFinite(position)) return null;
      return { domain: "cover", service: "set_cover_position", data: { ...data, position: Math.min(Math.max(Math.round(position), 0), 100) } };
    }
    case "set_temperature": {
      const temperature = Number(command.value);
      if (!Number.isFinite(temperature)) return null;
      return { domain: "climate", service: "set_temperature", data: { ...data, temperature } };
    }
    case "set_mode": {
      if (typeof command.value !== "string") return null;
      return { domain: "climate", service: "set_hvac_mode", data: { ...data, hvac_mode: command.value.slice(0, 40) } };
    }
    case "set_fan_speed": {
      const percent = Number(command.value);
      if (!Number.isFinite(percent)) return null;
      return { domain: "fan", service: "set_percentage", data: { ...data, percentage: Math.min(Math.max(Math.round(percent), 0), 100) } };
    }
    case "set_volume": {
      const volume = Number(command.value);
      if (!Number.isFinite(volume)) return null;
      return { domain: "media_player", service: "volume_set", data: { ...data, volume_level: Math.min(Math.max(volume, 0), 1) } };
    }
    case "send_command": {
      if (typeof command.value !== "string") return null;
      return { domain: native, service: "send_command", data: { ...data, command: command.value.slice(0, 200) } };
    }
    default: {
      const service = ACTION_SERVICE[command.action];
      if (!service) return null;
      // Cover services carry the domain in the name; everything else uses the entity's own domain.
      const serviceDomain = command.action === "open" || command.action === "close" ? "cover" : native;
      return { domain: serviceDomain, service, data };
    }
  }
}

/** Home Assistant as a home adapter. Reads `/api/states`; sends one service call per command. */
export function homeAssistantAdapter(config: HomeAssistantConfig): HomeAdapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const label = config.label?.trim() || new URL(baseUrl).host;
  const excluded = (config.exclude ?? []).map((entry) => entry.trim()).filter(Boolean);

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", ...init.headers },
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string }; name?: string }).cause?.code ?? (error as { name?: string }).name;
      if (cause === "TimeoutError") throw new HomeAssistantError("timeout", `Home Assistant did not answer within 12 s`);
      throw new HomeAssistantError("unreachable", `Home Assistant is unreachable (${String(cause).slice(0, 60)})`);
    }
    if (response.status === 401 || response.status === 403) throw new HomeAssistantError("unauthorized", "Home Assistant rejected the token");
    if (response.status === 404) throw new HomeAssistantError("not_found", "no such entity or service");
    if (response.status >= 500) throw new HomeAssistantError("server", `Home Assistant answered ${response.status}`);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new HomeAssistantError("bad_request", `Home Assistant refused the call (${response.status}): ${detail.slice(0, 200)}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  function toEntity(state: Record<string, unknown>): HomeEntity | null {
    const entityId = typeof state.entity_id === "string" ? state.entity_id : "";
    if (!ENTITY.test(entityId)) return null;
    if (excluded.some((entry) => entityId === entry || (entry.endsWith(".") && entityId.startsWith(entry)))) return null;
    const attributes = state.attributes && typeof state.attributes === "object" ? state.attributes as Record<string, unknown> : {};
    const domain = DOMAIN_MAP[domainOf(entityId)] ?? "other";
    const rawState = typeof state.state === "string" ? state.state : String(state.state ?? "");
    const flattened: HomeEntity["attributes"] = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === "string" || typeof value === "boolean") flattened[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) flattened[key] = value;
    }
    if (domain === "light") {
      const brightness = brightnessPercent(attributes.brightness);
      if (brightness !== null) flattened.brightness_pct = brightness;
    }
    return {
      entityId: `home-assistant:${entityId}`,
      adapterId: "home-assistant",
      domain,
      name: typeof attributes.friendly_name === "string" && attributes.friendly_name.trim() ? attributes.friendly_name.trim().slice(0, 120) : entityId,
      zone: typeof attributes.area === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(attributes.area) ? attributes.area : null,
      nativeId: entityId,
      available: rawState !== "unavailable" && rawState !== "unknown",
      actions: rawState === "unavailable" ? [] : actionsFor(domain, rawState),
      state: rawState.slice(0, 200),
      attributes: flattened,
      lastChangedAt: typeof state.last_changed === "string" ? state.last_changed : new Date().toISOString(),
    };
  }

  async function readStates(): Promise<HomeEntity[]> {
    const states = await request("/api/states");
    if (!Array.isArray(states)) throw new HomeAssistantError("server", "Home Assistant did not return a state list");
    return states.flatMap((state) => {
      const entity = state && typeof state === "object" ? toEntity(state as Record<string, unknown>) : null;
      return entity ? [entity] : [];
    });
  }

  return {
    adapterId: "home-assistant",
    label,
    kind: "home-assistant",
    controllable: true,

    async snapshot() {
      try {
        const entities = await readStates();
        const zones: HomeZone[] = [];
        const seen = new Set<string>();
        for (const entity of entities) {
          if (!entity.zone || seen.has(entity.zone)) continue;
          seen.add(entity.zone);
          zones.push({ zone: entity.zone, name: entity.zone.replace(/[-_]/g, " ") });
        }
        return { status: "ready" as HomeAdapterStatus, zones, entities };
      } catch (error) {
        const code = error instanceof HomeAssistantError ? error.code : "unreachable";
        const status: HomeAdapterStatus = code === "unauthorized" ? "unauthorized" : "unreachable";
        return { status, reason: error instanceof Error ? error.message.slice(0, 500) : String(error), zones: [], entities: [] };
      }
    },

    async control(command: HomeCommand): Promise<HomeReceipt> {
      const receiptId = randomUUID();
      const at = new Date().toISOString();
      let entity: HomeEntity | null = null;
      try {
        const entities = await readStates();
        entity = entities.find((candidate) => candidate.entityId === command.entityId) ?? null;
      } catch (error) {
        return { receiptId, entityId: command.entityId, action: command.action, status: "indeterminate", observed: null, at,
          code: "unreachable", message: error instanceof Error ? error.message.slice(0, 500) : String(error) };
      }
      if (!entity) return { receiptId, entityId: command.entityId, action: command.action, status: "failed", observed: null, at, code: "unknown_entity", message: "no such entity" };
      const call = serviceCallFor(entity, command);
      if (!call) return { receiptId, entityId: command.entityId, action: command.action, status: "failed", observed: entity, at, code: "unsupported_action", message: `${entity.name} cannot ${command.action}` };
      try {
        await request(`/api/services/${call.domain}/${call.service}`, { method: "POST", body: JSON.stringify(call.data) });
      } catch (error) {
        const code = error instanceof HomeAssistantError ? error.code : "server";
        // A timeout or a dropped connection after the request went out may still have taken effect: never claim either way.
        const status = code === "timeout" || code === "unreachable" || code === "server" ? "indeterminate" : "failed";
        return { receiptId, entityId: command.entityId, action: command.action, status, observed: entity, at, code,
          message: error instanceof Error ? error.message.slice(0, 500) : String(error) };
      }
      // Read back, so the receipt carries the state HA actually holds rather than the one asked for.
      let observed: HomeEntity | null = entity;
      try {
        observed = (await readStates()).find((candidate) => candidate.entityId === command.entityId) ?? entity;
      } catch {}
      return { receiptId, entityId: command.entityId, action: command.action, status: "succeeded", observed, at };
    },
  };
}
