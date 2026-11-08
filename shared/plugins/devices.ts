import { z } from "zod";

export const DEVICE_KINDS = ["phone", "watch", "desktop", "speaker", "home", "tablet", "other"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const DEVICE_STATUSES = ["paired", "offline", "revoked"] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

const instant = z.string().datetime({ offset: true });

export const deviceSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(DEVICE_KINDS),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(64),
  status: z.enum(DEVICE_STATUSES),
  pairedAt: instant,
  lastSeenAt: instant.optional(),
  revokedAt: instant.optional(),
}).strict();

export type Device = z.infer<typeof deviceSchema>;

export const devicePairingSchema = z.object({
  pairingId: z.string().uuid(),
  codeHash: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(DEVICE_KINDS),
  name: z.string().trim().min(1).max(120),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(64),
  expiresAt: instant,
  usedAt: instant.optional(),
  attempts: z.number().int().min(0).max(20),
}).strict();

export type DevicePairing = z.infer<typeof devicePairingSchema>;

export const DEVICE_COMMAND_STATUSES = ["queued", "succeeded", "failed", "unknown"] as const;
export type DeviceCommandStatus = (typeof DEVICE_COMMAND_STATUSES)[number];

export const deviceCommandSchema = z.object({
  commandId: z.string().uuid(),
  deviceId: z.string().uuid(),
  capability: z.string().trim().min(1).max(120),
  args: z.record(z.string().max(100), z.unknown()).optional(),
  status: z.enum(DEVICE_COMMAND_STATUSES),
  issuedAt: instant,
  expiresAt: instant,
  completedAt: instant.optional(),
  result: z.record(z.string().max(100), z.unknown()).optional(),
}).strict();

export type DeviceCommand = z.infer<typeof deviceCommandSchema>;

export type DeviceRefusalCode =
  | "UNKNOWN_DEVICE"
  | "REVOKED"
  | "CAPABILITY_MISSING"
  | "COMMAND_EXPIRED"
  | "PAIRING_EXPIRED"
  | "PAIRING_USED"
  | "PAIRING_CODE";

export type DeviceCheck = { ok: true } | { ok: false; code: DeviceRefusalCode; error: string };

export function deviceAllows(device: Device, capability: string): DeviceCheck {
  if (device.status === "revoked") return { ok: false, code: "REVOKED", error: "the device was revoked" };
  if (!device.capabilities.includes(capability)) {
    return { ok: false, code: "CAPABILITY_MISSING", error: `the device does not offer ${capability}` };
  }
  return { ok: true };
}

export function commandLive(command: Pick<DeviceCommand, "expiresAt">, now: string): boolean {
  return Date.parse(command.expiresAt) > Date.parse(now);
}

export function commandCheck(device: Device | undefined, capability: string, now: string, command?: Pick<DeviceCommand, "expiresAt">): DeviceCheck {
  if (!device) return { ok: false, code: "UNKNOWN_DEVICE", error: "no such device" };
  const allowed = deviceAllows(device, capability);
  if (!allowed.ok) return allowed;
  if (command && !commandLive(command, now)) return { ok: false, code: "COMMAND_EXPIRED", error: "the command expired before it ran" };
  return { ok: true };
}
