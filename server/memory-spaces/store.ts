import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import {
  authorizeMemoryWrite,
  memoryEntrySchema,
  memorySpaceMemberSchema,
  memorySpaceSchema,
  visibleMemoryEntries,
  withMember,
  withoutMember,
  type MemoryEntry,
  type MemoryRequestPrincipal,
  type MemorySensitivity,
  type MemorySpace,
  type MemorySpaceAccess,
  type MemorySpaceMember,
} from "../../shared/plugins/memory-spaces.ts";

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  spaces: z.array(memorySpaceSchema).max(200),
  entries: z.array(memoryEntrySchema).max(50_000),
}).strict();

export class MemorySpaceError extends Error {
  readonly code: "invalid" | "not-found" | "conflict" | "forbidden" | "corrupt";
  constructor(code: MemorySpaceError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface MemorySpaceStoreOptions {
  now?: () => string;
}

const MAX_ENTRIES = 50_000;

/** Named shared memory with a host-enforced ACL, CAS revisions and a revocation epoch. */
export class MemorySpaceStore {
  readonly file: string;
  private state: z.infer<typeof fileSchema> | null = null;
  private readonly now: () => string;

  constructor(dataDir: string, options: MemorySpaceStoreOptions = {}) {
    this.file = join(dataDir, "memory-spaces", "spaces.json");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  list(): MemorySpace[] {
    return this.load().spaces.map((space) => structuredClone(space));
  }

  get(spaceId: string): MemorySpace | null {
    const found = this.load().spaces.find((space) => space.spaceId === spaceId);
    return found ? structuredClone(found) : null;
  }

  create(input: {
    spaceId: string;
    name: string;
    description?: string;
    audience: MemorySpace["audience"];
    members?: Array<{ botId: string; access: MemorySpaceAccess }>;
  }): MemorySpace {
    const at = this.now();
    const members: MemorySpaceMember[] = [];
    for (const candidate of input.members ?? []) {
      const parsed = memorySpaceMemberSchema.safeParse({ ...candidate, addedAt: at });
      if (!parsed.success) throw new MemorySpaceError("invalid", parsed.error.issues[0]?.message ?? "invalid member");
      if (members.some((member) => member.botId === candidate.botId)) {
        throw new MemorySpaceError("invalid", `duplicate memory space member: ${candidate.botId}`);
      }
      members.push(parsed.data);
    }
    const parsed = memorySpaceSchema.safeParse({
      spaceId: input.spaceId,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      audience: input.audience,
      revision: 1,
      epoch: 0,
      members,
      createdAt: at,
      updatedAt: at,
    });
    if (!parsed.success) throw new MemorySpaceError("invalid", parsed.error.issues[0]?.message ?? "invalid memory space");
    const state = this.load();
    if (state.spaces.some((space) => space.spaceId === parsed.data.spaceId)) {
      throw new MemorySpaceError("conflict", "a memory space with this id already exists");
    }
    state.spaces.push(parsed.data);
    this.persist(state);
    return structuredClone(parsed.data);
  }

  addMember(spaceId: string, expectedRevision: number, member: { botId: string; access: MemorySpaceAccess }): MemorySpace {
    const space = this.requireSpace(spaceId);
    this.expectRevision(space, expectedRevision);
    const parsed = memorySpaceMemberSchema.safeParse({ ...member, addedAt: this.now() });
    if (!parsed.success) throw new MemorySpaceError("invalid", parsed.error.issues[0]?.message ?? "invalid member");
    const next = withMember(space, parsed.data, this.now());
    this.replaceSpace(next);
    return structuredClone(next);
  }

  removeMember(spaceId: string, expectedRevision: number, botId: string): MemorySpace {
    const space = this.requireSpace(spaceId);
    this.expectRevision(space, expectedRevision);
    const next = withoutMember(space, botId, this.now());
    if (!next) throw new MemorySpaceError("not-found", "that bot is not a member of the memory space");
    this.replaceSpace(next);
    return structuredClone(next);
  }

  /** Invalidate every cache and provider session built from this space before the next retrieval. */
  revoke(spaceId: string, expectedRevision: number): MemorySpace {
    const space = this.requireSpace(spaceId);
    this.expectRevision(space, expectedRevision);
    const next: MemorySpace = {
      ...space,
      revision: space.revision + 1,
      epoch: space.epoch + 1,
      updatedAt: this.now(),
    };
    this.replaceSpace(next);
    return structuredClone(next);
  }

  writeEntry(spaceId: string, expectedRevision: number, input: {
    text: string;
    sensitivity: MemorySensitivity;
    provenance: MemoryEntry["provenance"];
    principal: MemoryRequestPrincipal;
  }): MemoryEntry {
    const space = this.requireSpace(spaceId);
    this.expectRevision(space, expectedRevision);
    const authorization = authorizeMemoryWrite(space, input.provenance.botId, input.principal);
    if (!authorization.allowed) throw new MemorySpaceError("forbidden", authorization.error);
    const at = this.now();
    const revision = space.revision + 1;
    const parsed = memoryEntrySchema.safeParse({
      entryId: randomUUID(),
      spaceId,
      revision,
      epoch: space.epoch,
      text: input.text,
      sensitivity: input.sensitivity,
      provenance: input.provenance,
      createdAt: at,
      updatedAt: at,
    });
    if (!parsed.success) throw new MemorySpaceError("invalid", parsed.error.issues[0]?.message ?? "invalid memory entry");
    const state = this.load();
    state.entries.push(parsed.data);
    const index = state.spaces.findIndex((candidate) => candidate.spaceId === spaceId);
    state.spaces[index] = { ...space, revision, updatedAt: at };
    this.persist(state);
    return structuredClone(parsed.data);
  }

  /** A deletion leaves a tombstone in the revision history; retrieval and derived caches must not resurrect it. */
  deleteEntry(spaceId: string, expectedRevision: number, entryId: string): { space: MemorySpace; entry: MemoryEntry } {
    const space = this.requireSpace(spaceId);
    this.expectRevision(space, expectedRevision);
    const state = this.load();
    const index = state.entries.findIndex((entry) => entry.spaceId === spaceId && entry.entryId === entryId && !entry.deletedAt);
    if (index < 0) throw new MemorySpaceError("not-found", "no such live memory entry");
    const at = this.now();
    const entry = { ...state.entries[index]!, deletedAt: at, updatedAt: at, revision: space.revision + 1 };
    state.entries[index] = entry;
    const next: MemorySpace = { ...space, revision: space.revision + 1, updatedAt: at };
    const spaceIndex = state.spaces.findIndex((candidate) => candidate.spaceId === spaceId);
    state.spaces[spaceIndex] = next;
    this.persist(state);
    return { space: structuredClone(next), entry: structuredClone(entry) };
  }

  entries(spaceId: string, botId: string, principal: MemoryRequestPrincipal): MemoryEntry[] {
    const space = this.requireSpace(spaceId);
    return visibleMemoryEntries(this.load().entries, space, botId, principal).map((entry) => structuredClone(entry));
  }

  exportSpace(spaceId: string, botId: string, principal: MemoryRequestPrincipal): { space: MemorySpace; entries: MemoryEntry[] } {
    return { space: structuredClone(this.requireSpace(spaceId)), entries: this.entries(spaceId, botId, principal) };
  }

  private expectRevision(space: MemorySpace, expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || expectedRevision !== space.revision) {
      throw new MemorySpaceError("conflict", `the memory space changed (revision ${space.revision}); read it again`);
    }
  }

  private replaceSpace(next: MemorySpace): void {
    const state = this.load();
    const index = state.spaces.findIndex((space) => space.spaceId === next.spaceId);
    if (index < 0) throw new MemorySpaceError("not-found", "no such memory space");
    state.spaces[index] = next;
    this.persist(state);
  }

  private requireSpace(spaceId: string): MemorySpace {
    const space = this.load().spaces.find((candidate) => candidate.spaceId === spaceId);
    if (!space) throw new MemorySpaceError("not-found", "no such memory space");
    return space;
  }

  private load(): z.infer<typeof fileSchema> {
    if (this.state) return this.state;
    if (!existsSync(this.file)) {
      this.state = { schemaVersion: 1, spaces: [], entries: [] };
      return this.state;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new MemorySpaceError("corrupt", "memory-spaces/spaces.json is not valid JSON");
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) throw new MemorySpaceError("corrupt", "memory-spaces/spaces.json does not match schema version 1");
    this.state = parsed.data;
    return this.state;
  }

  private persist(state: z.infer<typeof fileSchema>): void {
    if (state.entries.length > MAX_ENTRIES) throw new MemorySpaceError("conflict", "the memory store is full; delete entries first");
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    this.state = state;
  }
}
