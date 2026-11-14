// Matter over IP, through matter.js (@matter/main, Apache-2.0). This adapter owns the Matter vocabulary and the
// controller's lifetime; it never writes to the store and never decides who may command what.
//
// Facts forced by matter.js 0.18 and the Matter specification, each checked against the library's own declarations:
// - A controller is a ServerNode whose root carries `ControllerBehavior`; peers are commissioned into its fabric.
// - Commissioning takes a pairing code (manual `XXXX-XXX-XXXX` or a QR payload) or a passcode + discriminator.
// - `Peers.commission()` discovers over mDNS and resolves once the node is online with its attributes read.
// - State lives on the peer's endpoints; `endpoint.stateOf("<cluster>")` reads the cached attributes, and
//   `endpoint.act(agent => agent.<behavior>.<command>())` sends a command over CASE.
// - Storage is rooted at `MATTER_PATH_ROOT` (the nodejs platform reads it before any node exists), so the whole
//   fabric lives under the app's data directory instead of the platform's default.
import { randomUUID } from "node:crypto";

import {
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

export interface MatterConfig {
  /** Where the controller keeps its fabric and node state; the adapter's own subdirectory. */
  dataDir: string;
  label?: string;
  /** Devices already on the fabric, by their operational node id. A new one is paired through the view. */
  nodes?: ReadonlyArray<{ nodeId: string; name?: string; zone?: string }>;
  /**
   * A simulated network instead of the real IP stack, for a fixture that must not touch mDNS or a radio. Absent in
   * every real configuration.
   */
  simulator?: unknown;
  /**
   * The UDP port the controller binds. Matter's own default is 5540, which a device on the same simulated network
   * also takes, so a fixture gives each node its own.
   */
  networkPort?: number;
}

export class MatterError extends Error {
  readonly code: "not_ready" | "unknown_node" | "unsupported_action" | "unreachable" | "timeout" | "bad_command";
  constructor(code: MatterError["code"], message: string) {
    super(message);
    this.name = "MatterError";
    this.code = code;
  }
}

/**
 * The Matter device types this adapter maps onto the domain. The key is the device type id from the endpoint's
 * Descriptor cluster; a type outside this table becomes `other` and stays read-only.
 */
const DEVICE_TYPE_DOMAIN: Readonly<Record<number, HomeDomain>> = {
  0x0100: "light",            // On/Off Light
  0x0101: "light",            // Dimmable Light
  0x0102: "light",            // Color Temperature Light
  0x0103: "light",            // Extended Color Light
  0x010a: "plug",             // On/Off Plug-in Unit
  0x010b: "plug",             // Dimmable Plug-in Unit
  0x010c: "light",            // Color Temperature Light (alternate)
  0x0200: "fan",              // Fan
  0x0201: "cover",            // Window Covering
  0x0202: "cover",            // Window Covering Controller
  0x0300: "air_purifier",     // Air Purifier
  0x0301: "air_purifier",     // Air Quality Sensor (read-only in practice)
  0x0302: "air_purifier",     // Air Quality Sensor
  0x0307: "humidifier",       // Humidifier
  0x0309: "sensor",           // Air Quality Sensor (read-only)
  0x030a: "climate",          // Thermostat
  0x030b: "climate",          // Thermostat Controller
  0x030c: "climate",          // Temperature Sensor
  0x030f: "sensor",           // Temperature Sensor (read-only)
  0x000a: "lock",             // Door Lock
  0x000b: "lock",             // Door Lock Controller
  0x0042: "media_player",     // Speaker
  0x0028: "other",            // Basic Video Player
  0x0074: "vacuum",           // Robotic Vacuum Cleaner
  0x0075: "vacuum",           // Robotic Vacuum Cleaner
  0x0016: "other",            // Root Node
};

/** Clusters whose attributes this adapter reads, by the name matter.js gives them on a client endpoint. */
const STATE_CLUSTERS = ["onOff", "levelControl", "colorControl", "doorLock", "windowCovering", "thermostat", "fanControl", "temperatureMeasurement", "relativeHumidityMeasurement", "occupancySensing", "booleanState"] as const;

/**
 * The attributes this domain actually reports, per cluster. A live read asks for exactly these: a cluster's full
 * attribute list includes optional ones a device may refuse, and one refusal would fail the whole read.
 */
const STATE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  onOff: ["onOff"],
  levelControl: ["currentLevel"],
  colorControl: ["colorTemperatureMireds"],
  doorLock: ["lockState"],
  windowCovering: ["currentPositionLiftPercent100ths", "targetPositionLiftPercent100ths"],
  thermostat: ["localTemperature", "occupiedHeatingSetpoint", "systemMode"],
  fanControl: ["percentSetting", "percentCurrent"],
  temperatureMeasurement: ["measuredValue"],
  relativeHumidityMeasurement: ["measuredValue"],
  occupancySensing: ["occupancy"],
  booleanState: ["stateValue"],
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The device type a peer endpoint declares, from its Descriptor cluster. */
function deviceTypeOf(descriptor: unknown): number | null {
  if (!isRecord(descriptor)) return null;
  const list = descriptor.deviceTypeList;
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (isRecord(entry) && typeof entry.deviceType === "number") return entry.deviceType;
  }
  return null;
}

function domainOf(deviceType: number | null): HomeDomain {
  if (deviceType === null) return "other";
  return Object.hasOwn(DEVICE_TYPE_DOMAIN, deviceType) ? DEVICE_TYPE_DOMAIN[deviceType]! : "other";
}

/** A stable zone name from the device's own label, so a device placed in "Living Room" groups under it. */
function zoneOf(label: string | null): string | null {
  if (!label) return null;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return /^[a-z][a-z0-9_-]{0,63}$/.test(slug) ? slug : null;
}

/** Which actions a peer endpoint offers, from the clusters it actually has. */
function actionsFor(domain: HomeDomain, clusters: ReadonlySet<string>, state: string): HomeAction[] {
  const offered = new Set<HomeAction>();
  if (clusters.has("onOff")) {
    if (domain !== "lock" && domain !== "cover") {
      offered.add("turn_on");
      offered.add("turn_off");
      offered.add("toggle");
    }
  }
  if (clusters.has("levelControl") && (domain === "light" || domain === "fan" || domain === "cover")) {
    offered.add(domain === "cover" ? "set_position" : domain === "fan" ? "set_fan_speed" : "set_brightness");
  }
  if (clusters.has("colorControl") && domain === "light") {
    offered.add("set_color_temperature");
    offered.add("set_color");
  }
  if (clusters.has("windowCovering") && domain === "cover") {
    offered.add("open");
    offered.add("close");
    offered.add("stop");
    offered.add("set_position");
  }
  if (clusters.has("doorLock") && domain === "lock") {
    // A lock's own state names the one direction that is safe to offer, exactly as the domain expects.
    if (state === "locked") offered.add("unlock");
    else offered.add("lock");
  }
  if (clusters.has("thermostat") && domain === "climate") {
    offered.add("set_temperature");
    offered.add("set_mode");
  }
  return [...offered].filter((action) => homeDomainAllows(domain, action));
}

/** A person-facing state word from whichever cluster carries the device's primary value. */
function stateOf(domain: HomeDomain, state: Record<string, Record<string, unknown> | undefined>): string {
  const onOff = state.onOff;
  const lock = state.doorLock;
  const cover = state.windowCovering;
  if (domain === "lock" && lock) {
    const value = Number(lock.lockState);
    if (value === 1) return "locked";
    if (value === 2) return "unlocked";
    return "unknown";
  }
  if (domain === "cover" && cover) {
    const target = Number(cover.targetPositionLiftPercent100ths ?? cover.currentPositionLiftPercent100ths);
    if (!Number.isFinite(target)) return "unknown";
    if (target === 0) return "open";
    if (target >= 10_000) return "closed";
    return "partly_open";
  }
  if (onOff) {
    if (typeof onOff.onOff === "boolean") return onOff.onOff ? "on" : "off";
  }
  const temperature = state.temperatureMeasurement;
  if (domain === "sensor" && temperature && typeof temperature.measuredValue === "number") {
    return String(Math.round(temperature.measuredValue) / 100);
  }
  const humidity = state.relativeHumidityMeasurement;
  if (domain === "sensor" && humidity && typeof humidity.measuredValue === "number") {
    return String(Math.round(humidity.measuredValue / 100));
  }
  const occupancy = state.occupancySensing;
  if (occupancy && typeof occupancy.occupancy === "number") return occupancy.occupancy !== 0 ? "on" : "off";
  return "unknown";
}

/** The attributes a card shows, flattened to what the domain's attribute schema accepts. */
function attributesOf(state: Record<string, Record<string, unknown> | undefined>): HomeEntity["attributes"] {
  const out: HomeEntity["attributes"] = {};
  const level = state.levelControl;
  if (level && typeof level.currentLevel === "number") out.brightness_pct = Math.round((level.currentLevel / 254) * 100);
  const color = state.colorControl;
  if (color && typeof color.colorTemperatureMireds === "number" && color.colorTemperatureMireds > 0) {
    out.color_temp_k = Math.round(1_000_000 / color.colorTemperatureMireds);
  }
  const thermostat = state.thermostat;
  if (thermostat && typeof thermostat.localTemperature === "number") out.current_temperature = Math.round(thermostat.localTemperature) / 100;
  if (thermostat && typeof thermostat.occupiedHeatingSetpoint === "number") out.target_temperature = Math.round(thermostat.occupiedHeatingSetpoint) / 100;
  const temperature = state.temperatureMeasurement;
  if (temperature && typeof temperature.measuredValue === "number") {
    out.measured_value = Math.round(temperature.measuredValue) / 100;
    out.unit_of_measurement = "°C";
  }
  const humidity = state.relativeHumidityMeasurement;
  if (humidity && typeof humidity.measuredValue === "number") {
    out.measured_value = Math.round(humidity.measuredValue / 100);
    out.unit_of_measurement = "%";
  }
  const cover = state.windowCovering;
  if (cover && typeof cover.currentPositionLiftPercent100ths === "number") {
    out.position_pct = Math.round(100 - cover.currentPositionLiftPercent100ths / 100);
  }
  return out;
}

/**
 * The controller. One instance owns the fabric; `start()` is idempotent and `dispose()` closes it, so the host can
 * reload config without leaking a node.
 */
export interface MatterPairing {
  /** A manual code (`XXXX-XXX-XXXX`) or a QR payload (`MT:…`). */
  code?: string;
  /** Or the two numbers printed beside the code. */
  passcode?: number;
  discriminator?: number;
  /** How long to search, in seconds. Default 30. */
  timeoutSeconds?: number;
}

export function matterAdapter(config: MatterConfig): HomeAdapter & { start(): Promise<void>; pair(input: MatterPairing): Promise<{ nodeId: string }> } {
  let controller: import("@matter/main").ServerNode | null = null;
  let starting: Promise<void> | null = null;
  let lastError: string | null = null;
  let disposed = false;

  const label = config.label?.trim() || "Matter";

  async function boot(): Promise<void> {
    if (controller) return;
    if (starting) return starting;
    starting = (async () => {
      // Read by the nodejs platform before any node exists, so it has to be set here rather than passed in. A person
      // who already pointed it somewhere keeps their choice.
      process.env.MATTER_PATH_ROOT ??= config.dataDir;
      process.env.MATTER_LOG_LEVEL ??= "error";
      const { ControllerBehavior, ServerNode } = await import("@matter/main");
      // A controller is the server root plus ControllerBehavior: that is what `peers` and commissioning hang off.
      const Root = ServerNode.RootEndpoint.with(ControllerBehavior);
      // The network block differs only by the simulator a fixture supplies; matter.js types the two shapes separately.
      const node = await ServerNode.create(Root, {
        id: "eac-home-controller",
        controller: { adminFabricLabel: "EACbot" },
        network: {
          ...(config.simulator ? { simulator: config.simulator } : {}),
          port: config.networkPort ?? 0,
        },
      } as unknown as Parameters<typeof ServerNode.create>[0]);
      await node.start();
      controller = node;
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  /** The peers this controller holds, keyed by the operational node id the config names. */
  function peers(): Array<{ nodeId: string; node: import("@matter/main").ClientNode }> {
    if (!controller) return [];
    return controller.peers.commissioned.map((node) => ({ nodeId: String(node.id), node }));
  }

  function clusterState(peer: import("@matter/main").ClientNode, endpointId: string): Record<string, Record<string, unknown> | undefined> {
    const endpoint = peer.parts.get(endpointId);
    const out: Record<string, Record<string, unknown> | undefined> = {};
    if (!endpoint) return out;
    for (const cluster of STATE_CLUSTERS) {
      try {
        const state = endpoint.stateOf(cluster);
        if (isRecord(state)) out[cluster] = state as Record<string, unknown>;
      } catch {
        // A peer endpoint without this cluster throws; that is the answer, not a failure.
      }
    }
    return out;
  }

  /**
   * Reads the attributes a receipt reports, over CASE rather than from the subscription cache: right after a
   * command the cache still holds the previous value, so a cached read would report a device that never moved.
   */
  async function liveState(peer: import("@matter/main").ClientNode, endpointId: string, clusters: readonly string[]): Promise<Record<string, Record<string, unknown> | undefined>> {
    const endpoint = peer.parts.get(endpointId);
    const out: Record<string, Record<string, unknown> | undefined> = {};
    if (!endpoint) return out;
    for (const cluster of clusters) {
      const cached = (() => {
        try {
          return endpoint.stateOf(cluster);
        } catch {
          return undefined;
        }
      })();
      if (!isRecord(cached)) continue;
      const keys = STATE_ATTRIBUTES[cluster];
      if (!keys?.length) continue;
      try {
        const fresh = await (endpoint as unknown as { getStateOf(type: string, selector: readonly string[]): Promise<unknown> }).getStateOf(cluster, keys);
        // The fresh answer alone: merging the cache back in would restore the value this read exists to replace.
        if (isRecord(fresh)) out[cluster] = fresh as Record<string, unknown>;
      } catch {
        out[cluster] = cached as Record<string, unknown>;
      }
    }
    return out;
  }

  /** One entity per peer endpoint, the root excluded: it carries the node's identity, not a device. */
  function entitiesOf(entry: { nodeId: string; node: import("@matter/main").ClientNode }): HomeEntity[] {
    const out: HomeEntity[] = [];
    for (const endpoint of entry.node.parts) {
      if (endpoint.number === 0) continue;
      let descriptor: unknown;
      try {
        descriptor = endpoint.stateOf("descriptor");
      } catch {
        continue;
      }
      const deviceType = deviceTypeOf(descriptor);
      const domain = domainOf(deviceType);
      const state = clusterState(entry.node, endpoint.id);
      const clusters = new Set(Object.keys(state));
      const name = (() => {
        try {
          const basic = endpoint.stateOf("bridgedBasicInformation") as Record<string, unknown> | undefined;
          const nodeLabel = typeof basic?.nodeLabel === "string" ? basic.nodeLabel : "";
          if (nodeLabel.trim()) return nodeLabel.trim().slice(0, 120);
        } catch {}
        try {
          const basic = endpoint.stateOf("basicInformation") as Record<string, unknown> | undefined;
          const nodeLabel = typeof basic?.nodeLabel === "string" ? basic.nodeLabel : "";
          if (nodeLabel.trim()) return nodeLabel.trim().slice(0, 120);
        } catch {}
        return `Matter ${deviceType === null ? "device" : `0x${deviceType.toString(16)}`} ${endpoint.number}`;
      })();
      const declared = config.nodes?.find((node) => node.nodeId === entry.nodeId);
      const rawState = stateOf(domain, state);
      out.push({
        entityId: `matter:${entry.nodeId}:${endpoint.id}`,
        adapterId: "matter",
        domain,
        name: declared?.name?.trim() || name,
        zone: zoneOf(declared?.zone ?? null) ?? zoneOf(name),
        nativeId: `${entry.nodeId}/${endpoint.id}`,
        available: rawState !== "unknown",
        actions: rawState === "unknown" ? [] : actionsFor(domain, clusters, rawState),
        state: rawState.slice(0, 200),
        attributes: attributesOf(state),
        lastChangedAt: new Date().toISOString(),
      });
    }
    return out;
  }

  /** Sends one command to a peer endpoint. Returns the receipt; never throws. */
  async function send(entry: { nodeId: string; node: import("@matter/main").ClientNode }, endpointId: string, entity: HomeEntity, command: HomeCommand): Promise<HomeReceipt> {
    const receiptId = randomUUID();
    const at = new Date().toISOString();
    const endpoint = entry.node.parts.get(endpointId);
    if (!endpoint) {
      return { receiptId, entityId: command.entityId, action: command.action, status: "failed", observed: entity, at, code: "unknown_entity", message: "the device is no longer on the fabric" };
    }
    const number = (value: unknown, fallback: number): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    try {
      switch (command.action) {
        case "turn_on":
          await endpoint.act((agent) => (agent as unknown as { onOff: { on(): Promise<void> } }).onOff.on());
          break;
        case "turn_off":
          await endpoint.act((agent) => (agent as unknown as { onOff: { off(): Promise<void> } }).onOff.off());
          break;
        case "toggle":
          await endpoint.act((agent) => (agent as unknown as { onOff: { toggle(): Promise<void> } }).onOff.toggle());
          break;
        case "set_brightness": {
          // Matter's level is 1..254; 0 is off, which a brightness command must not silently do.
          const level = Math.min(Math.max(Math.round((number(command.value, 100) / 100) * 254), 1), 254);
          await endpoint.act((agent) => (agent as unknown as { levelControl: { moveToLevel(req: { level: number }): Promise<void> } }).levelControl.moveToLevel({ level }));
          break;
        }
        case "set_fan_speed": {
          const percent = Math.min(Math.max(Math.round(number(command.value, 50)), 0), 100);
          await endpoint.act((agent) => (agent as unknown as { fanControl: { setPercentSetting(req: { percent: number }): Promise<void> } }).fanControl.setPercentSetting({ percent }));
          break;
        }
        case "set_position": {
          const percent = Math.min(Math.max(Math.round(number(command.value, 0)), 0), 100);
          await endpoint.act((agent) => (agent as unknown as { windowCovering: { goToLiftPercentage(req: { liftPercent100thsValue: number }): Promise<void> } }).windowCovering.goToLiftPercentage({ liftPercent100thsValue: percent * 100 }));
          break;
        }
        case "open":
          await endpoint.act((agent) => (agent as unknown as { windowCovering: { open(): Promise<void> } }).windowCovering.open());
          break;
        case "close":
          await endpoint.act((agent) => (agent as unknown as { windowCovering: { close(): Promise<void> } }).windowCovering.close());
          break;
        case "stop":
          await endpoint.act((agent) => (agent as unknown as { windowCovering: { stopMotion(): Promise<void> } }).windowCovering.stopMotion());
          break;
        case "lock":
          await endpoint.act((agent) => (agent as unknown as { doorLock: { lockDoor(): Promise<void> } }).doorLock.lockDoor());
          break;
        case "unlock":
          await endpoint.act((agent) => (agent as unknown as { doorLock: { unlockDoor(): Promise<void> } }).doorLock.unlockDoor());
          break;
        case "set_temperature": {
          const celsius = number(command.value, 21);
          await endpoint.act((agent) => (agent as unknown as { thermostat: { setHeatSetpoint(req: { amount: number }): Promise<void> } }).thermostat.setHeatSetpoint({ amount: Math.round(celsius * 100) }));
          break;
        }
        case "set_mode": {
          const mode = typeof command.value === "string" ? command.value : "";
          if (!mode) throw new MatterError("bad_command", "set_mode needs a mode name");
          await endpoint.act((agent) => (agent as unknown as { thermostat: { setSystemMode(req: { systemMode: string }): Promise<void> } }).thermostat.setSystemMode({ systemMode: mode }));
          break;
        }
        default:
          return { receiptId, entityId: command.entityId, action: command.action, status: "failed", observed: entity, at, code: "unsupported_action", message: `Matter has no ${command.action} for ${entity.name}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
      // A command that timed out over CASE may still have been applied: never claim either way.
      const indeterminate = /timeout|timed out|unreachable|no route|session/i.test(message);
      return { receiptId, entityId: command.entityId, action: command.action, status: indeterminate ? "indeterminate" : "failed", observed: entity, at, code: indeterminate ? "timeout" : "bad_command", message };
    }

    // Read the state back, so the receipt carries what the device holds rather than what was asked for.
    let observed = entity;
    try {
      const state = await liveState(entry.node, endpointId, STATE_CLUSTERS);
      const rawState = stateOf(entity.domain, state);
      observed = { ...entity, state: rawState, attributes: attributesOf(state), lastChangedAt: new Date().toISOString() };
    } catch {}
    return { receiptId, entityId: command.entityId, action: command.action, status: "succeeded", observed, at };
  }

  return {
    adapterId: "matter",
    label,
    kind: "matter",
    controllable: true,

    async start() {
      if (disposed) throw new MatterError("not_ready", "the Matter controller was shut down");
      try {
        await boot();
        lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error.message.slice(0, 500) : String(error);
        throw new MatterError("not_ready", `the Matter controller could not start: ${lastError}`);
      }
    },

    /** Commissions a device onto the fabric. The pairing code is the person's own, never a stored one. */
    async pair(input: MatterPairing): Promise<{ nodeId: string }> {
      if (disposed) throw new MatterError("not_ready", "the Matter controller was shut down");
      await boot();
      const node = controller;
      if (!node) throw new MatterError("not_ready", "the Matter controller did not come online");
      const options = pairingOptions(input);
      if (!options) {
        throw new MatterError("bad_command", `give a pairing code like "3497-011-2332" or a passcode with its discriminator`);
      }
      const commissioned = await node.peers.commission({
        ...options,
        timeout: Math.min(Math.max(input.timeoutSeconds ?? 30, 5), 180) * 1_000,
      } as Parameters<typeof node.peers.commission>[0]);
      return { nodeId: String(commissioned.id) };
    },

    async snapshot() {
      if (disposed) return { status: "disabled" as HomeAdapterStatus, reason: "the Matter controller was shut down", zones: [], entities: [] };
      try {
        await boot();
      } catch (error) {
        return { status: "unreachable" as HomeAdapterStatus, reason: error instanceof Error ? error.message.slice(0, 500) : String(error), zones: [], entities: [] };
      }
      const zones: HomeZone[] = [];
      const entities: HomeEntity[] = [];
      const seen = new Set<string>();
      for (const entry of peers()) {
        for (const entity of entitiesOf(entry)) {
          entities.push(entity);
          if (entity.zone && !seen.has(entity.zone)) {
            seen.add(entity.zone);
            zones.push({ zone: entity.zone, name: entity.zone.replace(/[-_]/g, " ") });
          }
        }
      }
      return { status: "ready" as HomeAdapterStatus, zones, entities };
    },

    async control(command: HomeCommand): Promise<HomeReceipt> {
      const receiptId = randomUUID();
      const at = new Date().toISOString();
      if (disposed) {
        return { receiptId, entityId: command.entityId, action: command.action, status: "failed", observed: null, at, code: "not_ready", message: "the Matter controller was shut down" };
      }
      try {
        await boot();
      } catch (error) {
        return { receiptId, entityId: command.entityId, action: command.action, status: "failed", observed: null, at, code: "not_ready", message: error instanceof Error ? error.message.slice(0, 500) : String(error) };
      }
      // The entity id carries the peer and endpoint: `matter:<nodeId>:<endpointId>`.
      const parts = command.entityId.split(":");
      if (parts.length < 3 || parts[0] !== "matter") {
        return { receiptId, entityId: command.entityId, action: command.action, status: "failed", observed: null, at, code: "unknown_entity", message: "not a Matter entity id" };
      }
      const nodeId = parts[1]!;
      const endpointId = parts.slice(2).join(":");
      const entry = peers().find((candidate) => candidate.nodeId === nodeId);
      if (!entry) {
        return { receiptId, entityId: command.entityId, action: command.action, status: "failed", observed: null, at, code: "unknown_entity", message: `${nodeId} is not on this fabric` };
      }
      const entity = entitiesOf(entry).find((candidate) => candidate.entityId === command.entityId);
      if (!entity) {
        return { receiptId, entityId: command.entityId, action: command.action, status: "failed", observed: null, at, code: "unknown_entity", message: "no such endpoint on that device" };
      }
      return send(entry, endpointId, entity, command);
    },

    async dispose() {
      disposed = true;
      const node = controller;
      controller = null;
      await node?.close().catch(() => {});
    },
  };
}

/** What a person types to pair a device: a manual code, a QR payload, or the two numbers printed beside it. */
export function pairingOptions(input: { code?: string; passcode?: number; discriminator?: number }): { pairingCode: string } | { passcode: number; discriminator?: number } | null {
  const code = input.code?.trim();
  if (code) {
    // A QR payload starts with "MT:"; a manual code is digits and dashes. Both go through the same option.
    if (/^MT:[A-Za-z0-9+/=.:-]+$/.test(code) || /^\d{4}-?\d{3}-?\d{4}$/.test(code)) return { pairingCode: code };
    return null;
  }
  if (typeof input.passcode === "number" && Number.isInteger(input.passcode)) {
    return { passcode: input.passcode, ...(typeof input.discriminator === "number" ? { discriminator: input.discriminator } : {}) };
  }
  return null;
}

export { MatterError as MatterAdapterError, isRecord as matterRecord };
