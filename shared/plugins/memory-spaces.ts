import { z } from "zod";

import { PLATFORM_IDS, type PlatformId } from "./accounts.ts";

export const MEMORY_SPACE_ACCESS = ["read", "read-write"] as const;
export type MemorySpaceAccess = (typeof MEMORY_SPACE_ACCESS)[number];

export const MEMORY_SENSITIVITIES = ["normal", "private", "restricted"] as const;
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];

const spaceIdPattern = /^[a-z0-9][a-z0-9-]{1,63}$/;
const instant = z.string().datetime({ offset: true });

export const memorySpaceMemberSchema = z.object({
  botId: z.string().min(1).max(120),
  access: z.enum(MEMORY_SPACE_ACCESS),
  addedAt: instant,
}).strict();

export type MemorySpaceMember = z.infer<typeof memorySpaceMemberSchema>;

export const memorySpaceSchema = z.object({
  spaceId: z.string().regex(spaceIdPattern),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).optional(),
  /** `owner`: only the account owner's principal may retrieve through a platform bot. */
  audience: z.enum(["owner", "shared"]),
  revision: z.number().int().min(0),
  /** Raised when membership or access is withdrawn, so caches and provider sessions built before it fail closed. */
  epoch: z.number().int().min(0),
  members: z.array(memorySpaceMemberSchema).max(100),
  createdAt: instant,
  updatedAt: instant,
}).strict();

export type MemorySpace = z.infer<typeof memorySpaceSchema>;

export const memoryProvenanceSchema = z.object({
  botId: z.string().min(1).max(120),
  platform: z.enum(PLATFORM_IDS).optional(),
  accountId: z.string().max(200).optional(),
  conversationId: z.string().max(200).optional(),
  messageId: z.string().max(200).optional(),
}).strict();

export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;

export const memoryEntrySchema = z.object({
  entryId: z.string().uuid(),
  spaceId: z.string().regex(spaceIdPattern),
  /** The space revision that included this write; a cache keyed on an older revision must not serve it. */
  revision: z.number().int().min(0),
  epoch: z.number().int().min(0),
  text: z.string().trim().min(1).max(8_000),
  sensitivity: z.enum(MEMORY_SENSITIVITIES),
  provenance: memoryProvenanceSchema,
  createdAt: instant,
  updatedAt: instant,
  deletedAt: instant.optional(),
}).strict();

export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

export interface MemoryRequestPrincipal {
  kind: "owner" | "guest";
  personId: string;
  platform?: PlatformId;
  accountId?: string;
}

export type MemoryAuthorizationCode =
  | "NOT_A_MEMBER"
  | "OWNER_AUDIENCE"
  | "READ_ONLY"
  | "GUEST_CANNOT_WRITE"
  | "SENSITIVITY";

export type MemoryAuthorization =
  | { allowed: true }
  | { allowed: false; code: MemoryAuthorizationCode; error: string };

function memberOf(space: MemorySpace, botId: string): MemorySpaceMember | undefined {
  return space.members.find((member) => member.botId === botId);
}

export function authorizeMemoryRead(space: MemorySpace, botId: string, principal: MemoryRequestPrincipal): MemoryAuthorization {
  const member = memberOf(space, botId);
  if (!member) return { allowed: false, code: "NOT_A_MEMBER", error: "this bot is not a member of the memory space" };
  if (principal.kind === "guest" && space.audience !== "shared") {
    return { allowed: false, code: "OWNER_AUDIENCE", error: "this space is only for its owner" };
  }
  return { allowed: true };
}

/** Guests never write, and a read-only member never writes, whatever the model says. */
export function authorizeMemoryWrite(space: MemorySpace, botId: string, principal: MemoryRequestPrincipal): MemoryAuthorization {
  const member = memberOf(space, botId);
  if (!member) return { allowed: false, code: "NOT_A_MEMBER", error: "this bot is not a member of the memory space" };
  if (principal.kind !== "owner") return { allowed: false, code: "GUEST_CANNOT_WRITE", error: "only the owner's own request may write memory" };
  if (member.access !== "read-write") return { allowed: false, code: "READ_ONLY", error: "this bot may only read the memory space" };
  return { allowed: true };
}

/** Retrieval sees live entries this principal may read; deleted entries never come back through a cache. */
export function visibleMemoryEntries(
  entries: readonly MemoryEntry[],
  space: MemorySpace,
  botId: string,
  principal: MemoryRequestPrincipal,
): MemoryEntry[] {
  if (!authorizeMemoryRead(space, botId, principal).allowed) return [];
  return entries.filter((entry) => {
    if (entry.spaceId !== space.spaceId || entry.deletedAt) return false;
    if (principal.kind === "guest" && entry.sensitivity !== "normal") return false;
    return true;
  });
}

const ACCESS_RANK: Readonly<Record<MemorySpaceAccess, number>> = { read: 1, "read-write": 2 };

/** Adding or changing a member raises the revision; narrowing access also raises the epoch, so caches built while it could
 * write are rebuilt. */
export function withMember(space: MemorySpace, member: MemorySpaceMember, at: string): MemorySpace {
  const previous = space.members.find((current) => current.botId === member.botId);
  const narrowed = previous !== undefined && ACCESS_RANK[member.access] < ACCESS_RANK[previous.access];
  const members = space.members.filter((current) => current.botId !== member.botId);
  members.push(member);
  return {
    ...space,
    members,
    revision: space.revision + 1,
    ...(narrowed ? { epoch: space.epoch + 1 } : {}),
    updatedAt: at,
  };
}

export function withoutMember(space: MemorySpace, botId: string, at: string): MemorySpace | null {
  const members = space.members.filter((member) => member.botId !== botId);
  if (members.length === space.members.length) return null;
  return { ...space, members, revision: space.revision + 1, epoch: space.epoch + 1, updatedAt: at };
}
