import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import {
  commandCheck,
  deviceCommandSchema,
  devicePairingSchema,
  deviceSchema,
  type Device,
  type DeviceCommand,
  type DeviceCommandStatus,
  type DeviceKind,
} from "../../shared/plugins/devices.ts";

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  devices: z.array(deviceSchema).max(500),
  pairings: z.array(devicePairingSchema).max(500),
  commands: z.array(deviceCommandSchema).max(20_000),
}).strict();

export class DeviceError extends Error {
  readonly code: "invalid" | "not-found" | "conflict" | "forbidden" | "expired" | "corrupt";
  constructor(code: DeviceError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface DeviceRegistryOptions {
  now?: () => string;
  pairingTtlMs?: number;
  commandTtlMs?: number;
}

const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
const DEFAULT_COMMAND_TTL_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_COMMANDS = 20_000;

const hashCode = (code: string): string => createHash("sha256").update(code).digest("hex");

function sameCode(code: string, hash: string): boolean {
  const candidate = Buffer.from(hashCode(code), "hex");
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Device pairing, capability checks and idempotent command receipts. */
export class DeviceRegistry {
  readonly file: string;
  private state: z.infer<typeof fileSchema> | null = null;
  private readonly now: () => string;
  private readonly pairingTtlMs: number;
  private readonly commandTtlMs: number;

  constructor(dataDir: string, options: DeviceRegistryOptions = {}) {
    this.file = join(dataDir, "devices", "devices.json");
    this.now = options.now ?? (() => new Date().toISOString());
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.commandTtlMs = options.commandTtlMs ?? DEFAULT_COMMAND_TTL_MS;
  }

  list(): Device[] {
    return this.load().devices.map((device) => structuredClone(device));
  }

  device(deviceId: string): Device | null {
    const found = this.load().devices.find((device) => device.deviceId === deviceId);
    return found ? structuredClone(found) : null;
  }

  createPairing(input: { name: string; kind: DeviceKind; capabilities: string[] }): { pairingId: string; code: string; expiresAt: string } {
    const at = this.now();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const parsed = devicePairingSchema.safeParse({
      pairingId: randomUUID(),
      codeHash: hashCode(code),
      name: input.name,
      kind: input.kind,
      capabilities: [...new Set(input.capabilities)],
      expiresAt: new Date(Date.parse(at) + this.pairingTtlMs).toISOString(),
      attempts: 0,
    });
    if (!parsed.success) throw new DeviceError("invalid", parsed.error.issues[0]?.message ?? "invalid pairing");
    const state = this.load();
    // Expired and spent pairings never become valid again, so they are dropped before the cap can be reached.
    state.pairings = state.pairings.filter((pairing) => !pairing.usedAt && Date.parse(pairing.expiresAt) > Date.parse(at));
    state.pairings.push(parsed.data);
    this.persist(state);
    return { pairingId: parsed.data.pairingId, code, expiresAt: parsed.data.expiresAt };
  }

  redeem(pairingId: string, code: string): Device {
    const state = this.load();
    const pairing = state.pairings.find((candidate) => candidate.pairingId === pairingId);
    if (!pairing) throw new DeviceError("not-found", "no such pairing");
    if (pairing.usedAt) throw new DeviceError("conflict", "this pairing was already used");
    if (Date.parse(pairing.expiresAt) <= Date.parse(this.now())) throw new DeviceError("expired", "the pairing code expired");
    if (pairing.attempts >= MAX_ATTEMPTS) throw new DeviceError("forbidden", "too many wrong pairing codes");
    pairing.attempts += 1;
    if (!sameCode(code, pairing.codeHash)) {
      this.persist(state);
      throw new DeviceError("forbidden", "the pairing code is wrong");
    }
    const at = this.now();
    const device = deviceSchema.parse({
      deviceId: randomUUID(),
      name: pairing.name,
      kind: pairing.kind,
      capabilities: pairing.capabilities,
      status: "paired",
      pairedAt: at,
      lastSeenAt: at,
    });
    pairing.usedAt = at;
    state.devices.push(device);
    this.persist(state);
    return structuredClone(device);
  }

  revoke(deviceId: string): Device {
    const state = this.load();
    const device = state.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device) throw new DeviceError("not-found", "no such device");
    const at = this.now();
    device.status = "revoked";
    device.revokedAt = at;
    for (const command of state.commands) {
      if (command.deviceId === deviceId && (command.status === "queued")) command.status = "failed";
    }
    this.persist(state);
    return structuredClone(device);
  }

  touch(deviceId: string): Device {
    const state = this.load();
    const device = state.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device) throw new DeviceError("not-found", "no such device");
    if (device.status !== "revoked") {
      device.lastSeenAt = this.now();
      if (device.status === "offline") device.status = "paired";
      this.persist(state);
    }
    return structuredClone(device);
  }

  /** Sending the same command id twice returns the first command, so a retry cannot actuate a lock twice. */
  send(input: {
    commandId?: string;
    deviceId: string;
    capability: string;
    args?: Record<string, unknown>;
    ttlMs?: number;
  }): DeviceCommand {
    const state = this.load();
    if (input.commandId) {
      const existing = state.commands.find((command) => command.commandId === input.commandId);
      if (existing) {
        if (existing.deviceId !== input.deviceId) {
          throw new DeviceError("conflict", "that command id belongs to another device");
        }
        return structuredClone(existing);
      }
    }
    const device = state.devices.find((candidate) => candidate.deviceId === input.deviceId);
    const at = this.now();
    const check = commandCheck(device, input.capability, at);
    if (!check.ok) {
      if (check.code === "REVOKED") throw new DeviceError("forbidden", check.error);
      if (check.code === "CAPABILITY_MISSING") throw new DeviceError("forbidden", check.error);
      throw new DeviceError("not-found", check.error);
    }
    const parsed = deviceCommandSchema.safeParse({
      commandId: input.commandId ?? randomUUID(),
      deviceId: input.deviceId,
      capability: input.capability,
      ...(input.args ? { args: input.args } : {}),
      status: "queued",
      issuedAt: at,
      expiresAt: new Date(Date.parse(at) + (input.ttlMs ?? this.commandTtlMs)).toISOString(),
    });
    if (!parsed.success) throw new DeviceError("invalid", parsed.error.issues[0]?.message ?? "invalid command");
    state.commands.push(parsed.data);
    // Finished commands are history only; keeping a bounded window stops the on-disk cap from ever being exceeded.
    if (state.commands.length > MAX_COMMANDS) {
      const terminal = state.commands.filter((command) => command.status !== "queued");
      const keep = new Set(terminal.slice(Math.max(0, terminal.length - (MAX_COMMANDS - state.commands.filter((c) => c.status === "queued").length))));
      state.commands = state.commands.filter((command) => command.status === "queued" || keep.has(command));
      if (state.commands.length > MAX_COMMANDS) throw new DeviceError("conflict", "too many unfinished device commands");
    }
    this.persist(state);
    return structuredClone(parsed.data);
  }

  complete(deviceId: string, commandId: string, status: Exclude<DeviceCommandStatus, "queued">, result?: Record<string, unknown>): DeviceCommand {
    const state = this.load();
    const command = state.commands.find((candidate) => candidate.commandId === commandId && candidate.deviceId === deviceId);
    if (!command) throw new DeviceError("not-found", "no such command");
    if (command.status === status) return structuredClone(command);
    if (command.status !== "queued") throw new DeviceError("conflict", "the command already has a different result");
    const at = this.now();
    command.status = Date.parse(command.expiresAt) <= Date.parse(at) && status === "succeeded" ? "unknown" : status;
    command.completedAt = at;
    if (result) command.result = result;
    this.persist(state);
    return structuredClone(command);
  }

  pending(deviceId: string): DeviceCommand[] {
    const at = this.now();
    return this.load().commands
      .filter((command) => command.deviceId === deviceId && command.status === "queued" && Date.parse(command.expiresAt) > Date.parse(at))
      .map((command) => structuredClone(command));
  }

  private load(): z.infer<typeof fileSchema> {
    if (this.state) return this.state;
    if (!existsSync(this.file)) {
      this.state = { schemaVersion: 1, devices: [], pairings: [], commands: [] };
      return this.state;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new DeviceError("corrupt", "devices/devices.json is not valid JSON");
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) throw new DeviceError("corrupt", "devices/devices.json does not match schema version 1");
    this.state = parsed.data;
    return this.state;
  }

  private persist(state: z.infer<typeof fileSchema>): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    this.state = state;
  }
}
