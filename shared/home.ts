import { z } from "zod";

/**
 * The smart-home wire contract. An adapter (Home Assistant, Matter, a vendor LAN
 * protocol, a paired phone) turns its own vocabulary into these entities and
 * receipts; the domain, the /home view and the bot tools know nothing else.
 *
 * `zone` is a place in the home ("living-room", "upstairs"). The word is
 * deliberate: `room` in EACbot already means a group of bots.
 */

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const instant = z.string().datetime({ offset: true });

/** The vocabulary an adapter must translate to. An entity outside it is `other` and stays read-only. */
export const HOME_DOMAINS = [
  "light",
  "switch",
  "plug",
  "cover",
  "climate",
  "fan",
  "lock",
  "sensor",
  "binary_sensor",
  "camera",
  "media_player",
  "vacuum",
  "scene",
  "script",
  "humidifier",
  "water_heater",
  "air_purifier",
  "other",
] as const;
export type HomeDomain = (typeof HOME_DOMAINS)[number];

/** Actions the domain understands, whatever the adapter calls them underneath. */
export const HOME_ACTIONS = [
  "turn_on",
  "turn_off",
  "toggle",
  "set_brightness",
  "set_color_temperature",
  "set_color",
  "open",
  "close",
  "stop",
  "set_position",
  "set_temperature",
  "set_mode",
  "set_fan_speed",
  "lock",
  "unlock",
  "play",
  "pause",
  "set_volume",
  "activate",
  "send_command",
] as const;
export type HomeAction = (typeof HOME_ACTIONS)[number];

/** Actions that change a security-relevant state and need their own confirmation. */
export const HOME_SENSITIVE_ACTIONS: ReadonlySet<HomeAction> = new Set(["unlock", "lock", "open", "close"]);
/** Domains whose every action is security-relevant. */
export const HOME_SENSITIVE_DOMAINS: ReadonlySet<HomeDomain> = new Set(["lock", "camera"]);

export const homeAttributeValueSchema = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

export const homeEntitySchema = z.object({
  /** `<adapterId>:<adapter's own id>`, stable across restarts of this host. */
  entityId: z.string().trim().min(1).max(200),
  adapterId: z.string().trim().min(1).max(60),
  domain: z.enum(HOME_DOMAINS),
  name: z.string().trim().min(1).max(120),
  zone: identifier.nullable(),
  /** The adapter's own name for this entity, so a person can match it in their own app. */
  nativeId: z.string().trim().max(200),
  available: z.boolean(),
  /** Actions this entity accepts; the domain refuses anything else before it reaches the adapter. */
  actions: z.array(z.enum(HOME_ACTIONS)).max(24),
  state: z.string().max(200),
  attributes: z.record(z.string().max(60), homeAttributeValueSchema),
  lastChangedAt: instant,
}).strict();
export type HomeEntity = z.infer<typeof homeEntitySchema>;

export const homeZoneSchema = z.object({
  zone: identifier,
  name: z.string().trim().min(1).max(120),
}).strict();
export type HomeZone = z.infer<typeof homeZoneSchema>;

/** One instruction. `value` is whatever the action needs: a brightness, a temperature, a colour. */
export const homeCommandSchema = z.object({
  entityId: z.string().trim().min(1).max(200),
  action: z.enum(HOME_ACTIONS),
  value: z.union([z.string().max(200), z.number().finite(), z.boolean()]).optional(),
}).strict();
export type HomeCommand = z.infer<typeof homeCommandSchema>;

export const HOME_RECEIPT_STATUSES = ["succeeded", "failed", "indeterminate"] as const;
export type HomeReceiptStatus = (typeof HOME_RECEIPT_STATUSES)[number];

/**
 * What happened. `indeterminate` means the command may or may not have taken
 * effect: a timeout, a dropped connection. It is never retried and never
 * reported as success, and `observed` is the state read back afterwards when
 * the adapter could read one.
 */
export const homeReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  entityId: z.string().trim().min(1).max(200),
  action: z.enum(HOME_ACTIONS),
  status: z.enum(HOME_RECEIPT_STATUSES),
  observed: homeEntitySchema.nullable(),
  code: z.string().max(120).optional(),
  message: z.string().max(2_000).optional(),
  at: instant,
}).strict();
export type HomeReceipt = z.infer<typeof homeReceiptSchema>;

export const HOME_ADAPTER_STATUSES = ["ready", "unreachable", "unauthorized", "disabled"] as const;
export type HomeAdapterStatus = (typeof HOME_ADAPTER_STATUSES)[number];

export const homeAdapterSchema = z.object({
  adapterId: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(120),
  kind: z.enum(["home-assistant", "matter", "midea-lan", "tuya", "phone-home"]),
  status: z.enum(HOME_ADAPTER_STATUSES),
  statusReason: z.string().max(500).optional(),
  entityCount: z.number().int().nonnegative(),
  lastSeenAt: instant.optional(),
  /** False when this adapter cannot take commands in this build; the view says so instead of offering buttons. */
  controllable: z.boolean(),
}).strict();
export type HomeAdapterSummary = z.infer<typeof homeAdapterSchema>;

export const homeSnapshotSchema = z.object({
  adapters: z.array(homeAdapterSchema).max(32),
  zones: z.array(homeZoneSchema).max(64),
  entities: z.array(homeEntitySchema).max(5_000),
  at: instant,
}).strict();
export type HomeSnapshot = z.infer<typeof homeSnapshotSchema>;

export const homeErrorCodeSchema = z.enum([
  "unknown_entity",
  "unknown_adapter",
  "adapter_unavailable",
  "unsupported_action",
  "invalid_value",
  "sensitive_requires_confirmation",
  "forbidden_zone",
  "not_found",
]);
export type HomeErrorCode = z.infer<typeof homeErrorCodeSchema>;

export const homeErrorSchema = z.object({
  code: homeErrorCodeSchema,
  message: z.string().max(2_000),
}).strict();
export type HomeError = z.infer<typeof homeErrorSchema>;

/**
 * What an adapter implements. It owns one vendor's transport and nothing else:
 * no storage, no HTTP routes, no grants. A failing adapter degrades to
 * `unreachable` and its entities to `available: false`; it never throws out of
 * `snapshot()`.
 */
export interface HomeAdapter {
  readonly adapterId: string;
  readonly label: string;
  readonly kind: HomeAdapterSummary["kind"];
  /** False when this build can read but not command (a read-only bridge). */
  readonly controllable: boolean;
  snapshot(): Promise<{ status: HomeAdapterStatus; reason?: string; zones: HomeZone[]; entities: HomeEntity[] }>;
  /** Resolves a receipt for every command, including the ones it could not deliver. */
  control(command: HomeCommand): Promise<HomeReceipt>;
  dispose?(): Promise<void>;
}

export function homeDomainIsSensitive(domain: HomeDomain): boolean {
  return HOME_SENSITIVE_DOMAINS.has(domain);
}

export function homeActionIsSensitive(domain: HomeDomain, action: HomeAction): boolean {
  return HOME_SENSITIVE_DOMAINS.has(domain) || HOME_SENSITIVE_ACTIONS.has(action);
}

/** Actions each domain accepts, so a bad tool call is refused before an adapter sees it. */
export const HOME_DOMAIN_ACTIONS: Readonly<Record<HomeDomain, readonly HomeAction[]>> = {
  light: ["turn_on", "turn_off", "toggle", "set_brightness", "set_color_temperature", "set_color"],
  switch: ["turn_on", "turn_off", "toggle"],
  plug: ["turn_on", "turn_off", "toggle"],
  cover: ["open", "close", "stop", "set_position"],
  climate: ["turn_on", "turn_off", "set_temperature", "set_mode", "set_fan_speed"],
  fan: ["turn_on", "turn_off", "set_fan_speed"],
  lock: ["lock", "unlock"],
  sensor: [],
  binary_sensor: [],
  camera: [],
  media_player: ["turn_on", "turn_off", "play", "pause", "set_volume"],
  vacuum: ["turn_on", "turn_off", "stop", "send_command"],
  scene: ["activate"],
  script: ["activate"],
  humidifier: ["turn_on", "turn_off", "set_mode"],
  water_heater: ["turn_on", "turn_off", "set_temperature"],
  air_purifier: ["turn_on", "turn_off", "set_fan_speed"],
  other: [],
};

export function homeDomainAllows(domain: HomeDomain, action: HomeAction): boolean {
  return HOME_DOMAIN_ACTIONS[domain].includes(action);
}
