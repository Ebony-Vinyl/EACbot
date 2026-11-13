import type { MemoryContextSnapshot, PlatformTurnContext } from "../host/memory-context.ts";
import type { MemorySpaceStore } from "../memory-spaces/store.ts";
import { PASS, type RouteContext } from "./table.ts";

export async function handleSharedMemoryWrite(context: Pick<RouteContext, "req" | "res" | "path" | "method" | "json"> & { readBody(): Promise<Record<string, any>> }, deps: Parameters<typeof writeSharedMemory>[2]): Promise<typeof PASS | void> {
  if (context.method !== "POST" || context.path !== "/api/internal/memory") return PASS;
  const body = await context.readBody();
  if (typeof body?.spaceId !== "string") return PASS;
  return writeSharedMemory(body, context, deps);
}

export function privateMemoryWriteRefused(method: string, path: string, snapshot: MemoryContextSnapshot): boolean {
  return method === "POST" && !snapshot.privateMemory && (path === "/api/internal/memory/log" || path === "/api/internal/team-memory");
}

export function writeSharedMemory(body: Record<string, any>, context: Pick<RouteContext, "res" | "json">, deps: {
  memory: MemorySpaceStore;
  snapshot: MemoryContextSnapshot;
  botId: string;
  platform?: PlatformTurnContext;
  enabled: boolean;
}): void {
  const { res, json } = context;
  const space = typeof body?.spaceId === "string" ? deps.memory.get(body.spaceId) : null;
  const member = space?.members.find((entry) => entry.botId === deps.botId);
  if (!deps.enabled || !space || member?.access !== "read-write" || deps.snapshot.principal.kind !== "owner" ||
      (!deps.snapshot.privateMemory && space.audience !== "shared")) {
    return json(res, 403, { error: "This request cannot write that shared memory space." });
  }
  try {
    if (body.action === "append") {
      const entry = deps.memory.writeEntry(space.spaceId, body.expectedRevision, { text: body.text, sensitivity: "normal", principal: deps.snapshot.principal,
        provenance: { botId: deps.botId, ...(deps.platform ? { platform: deps.platform.platform, accountId: deps.platform.accountId, conversationId: deps.platform.conversation.id } : {}) } });
      return json(res, 200, { ok: true, entryId: entry.entryId, revision: entry.revision });
    }
    if (body.action === "remove") {
      const deleted = deps.memory.deleteEntry(space.spaceId, body.expectedRevision, body.entryId);
      return json(res, 200, { ok: true, entryId: deleted.entry.entryId, revision: deleted.space.revision });
    }
    return json(res, 400, { error: "Shared memory supports append with text or remove with entryId, each with expectedRevision." });
  } catch (error) {
    return json(res, (error as { code?: string }).code === "conflict" ? 409 : 400, { error: error instanceof Error ? error.message : "Shared memory update failed." });
  }
}
