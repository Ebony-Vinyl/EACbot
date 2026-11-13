import { readMessageText, recallMessages, recentMessages } from "../message-db.ts";
import { claimRecallCrossings, recallCrossingLabel } from "../recall-disclosure.ts";
import { parseSince, parseUntil } from "../recent-work.ts";
import { searchMemoryFiles } from "../workspace.ts";
import type { Store, BotRecord, GroupRecord } from "../store.ts";
import type { MemoryContextSnapshot } from "../host/memory-context.ts";
import type { TeamMemory } from "../team-memory.ts";
import { PASS, type RouteContext } from "./table.ts";

const SESSION_READ_MAX_CHARS = 8_000;

export async function sessionRecallRoute(context: Pick<RouteContext, "method" | "path" | "url" | "res" | "json">, deps: {
  store: Pick<Store, "bot" | "taskByThread" | "groupByThread" | "appendMessage">;
  threadId: string;
  capability: { threadId: string };
  memory: MemoryContextSnapshot;
  memoryIds(botId: string, threadId: string): string[];
  messageReadable(threadId: string, messageId: string): boolean;
  connectorThread(botId: string, threadId: string): unknown;
  threadLanguage(threadId: string): string | undefined;
  recallThreads(bot: BotRecord, capability: { threadId: string }): { roomByThread: Map<string, GroupRecord>; ownThreads: string[] };
  teamSearch: TeamMemory["search"];
}): Promise<typeof PASS | void> {
  const { method, path, url, res, json } = context;
  const { store } = deps;
  const discloseRecall = (bot: BotRecord, roomThreadId: string, sourceThreadIds: readonly string[]): void => {
    const crossing = claimRecallCrossings(roomThreadId, sourceThreadIds);
    if (!crossing.count) return;
    store.appendMessage(roomThreadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: { name: recallCrossingLabel(bot.name, crossing.count, deps.threadLanguage(roomThreadId)), ok: true },
    });
  };
  if (method === "GET" && path === "/api/internal/session-search") {
    const fromBotId = String(url.searchParams.get("fromBotId") ?? "");
    const from = store.bot(fromBotId);
    if (!from) return json(res, 403, { error: "unknown sender" });
    const fromThreadId = deps.threadId;
    if (!deps.connectorThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const q = String(url.searchParams.get("q") ?? "").trim();
    const now = Date.now();
    const sinceRaw = url.searchParams.get("since");
    const untilRaw = url.searchParams.get("until");
    const since = sinceRaw ? parseSince(sinceRaw, now) : null;
    const until = untilRaw ? parseUntil(untilRaw, now) : null;
    if (sinceRaw && since === null) return json(res, 400, { error: "since must be a date, or a span like 24h, 3d, today, yesterday" });
    if (untilRaw && until === null) return json(res, 400, { error: "until must be a date, or a span like 24h, 3d, today, yesterday" });
    if (!q && since === null) return json(res, 400, { error: "q or since is required" });
    const range = since !== null || until !== null
      ? { ...(since !== null ? { since } : {}), ...(until !== null ? { until } : {}) }
      : undefined;
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 25) : 12;
    const scope = url.searchParams.get("scope") ?? "all";
    if (scope !== "all" && scope !== "conversations" && scope !== "memory" && scope !== "team") {
      return json(res, 400, { error: "scope must be all, conversations, memory, or team" });
    }
    const words = q.toLocaleLowerCase().split(/\s+/);
    const sharedHits = scope === "conversations" || scope === "team" || !q || from.memoryEnabled === false ? [] : deps.memory.entries
      .filter((entry) => words.every((word) => entry.text.toLocaleLowerCase().includes(word)))
      .filter((entry) => (since === null || Date.parse(entry.updatedAt) >= since) && (until === null || Date.parse(entry.updatedAt) <= until))
      .slice(0, limit)
      .map((entry) => ({ file: `shared/${entry.spaceId}/${entry.entryId}`, snippet: entry.text, at: Date.parse(entry.updatedAt) }));
    const memoryHits = [...sharedHits, ...(scope === "conversations" || scope === "team" || !q || from.memoryEnabled === false || !deps.memory.privateMemory ? [] : deps.memoryIds(from.id, fromThreadId).flatMap((id) => searchMemoryFiles(id, q, limit)))].slice(0, limit);
    if (scope === "memory" || scope === "team") return json(res, 200, { hits: [], memoryHits, teamHits: scope === "team" && deps.memory.privateMemory ? deps.teamSearch(from.section, q, limit, range) : [] });
    const { roomByThread, ownThreads } = deps.recallThreads(from, deps.capability);
    const inRoom = Boolean(store.groupByThread(fromThreadId));
    const found = (q ? recallMessages(q, ownThreads, limit, range) : recentMessages(ownThreads, range ?? {}, limit))
      .filter((hit) => deps.messageReadable(hit.threadId, hit.messageId));
    const hits = found.map((hit) => {
      const room = roomByThread.get(hit.threadId);
      return {
        ...hit,
        task: room
          ? (room.tasks ?? []).find((task) => task.threadId === hit.threadId)?.title
          : store.taskByThread(from.id, hit.threadId)?.title,
        ...(room ? { room: room.name } : {}),
        current: hit.threadId === fromThreadId,
        crossed: inRoom && !room && hit.threadId !== fromThreadId,
      };
    });
    if (inRoom) {
      discloseRecall(from, fromThreadId, hits.filter((hit) => hit.crossed).map((hit) => hit.threadId));
    }
    return json(res, 200, { hits, memoryHits, teamHits: scope === "conversations" || !deps.memory.privateMemory ? [] : deps.teamSearch(from.section, q, limit, range) });
  }
  // 安全约束：其他会话的消息标识统一返回缺失，避免暴露消息是否存在。
  if (method === "GET" && path === "/api/internal/session-read") {
    const fromBotId = String(url.searchParams.get("fromBotId") ?? "");
    const from = store.bot(fromBotId);
    if (!from) return json(res, 403, { error: "unknown sender" });
    const fromThreadId = deps.threadId;
    if (!deps.connectorThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const threadId = String(url.searchParams.get("threadId") ?? "").trim();
    const messageId = String(url.searchParams.get("messageId") ?? "").trim();
    if (!threadId || !messageId) return json(res, 400, { error: "threadId and messageId are required" });
    const recall = deps.recallThreads(from, deps.capability);
    const own = recall.ownThreads.includes(threadId);
    const allowed = own && deps.messageReadable(threadId, messageId);
    const message = allowed ? readMessageText(threadId, messageId) : null;
    if (!message) return json(res, 404, { error: "no such message in your conversations" });
    const readInRoom = Boolean(store.groupByThread(fromThreadId));
    const readCrossed = readInRoom && threadId !== fromThreadId && !recall.roomByThread.has(threadId);
    if (readCrossed) discloseRecall(from, fromThreadId, [threadId]);
    return json(res, 200, {
      ...message,
      crossed: readCrossed,
      text: message.text.length > SESSION_READ_MAX_CHARS ? `${message.text.slice(0, SESSION_READ_MAX_CHARS)}…` : message.text,
      task: store.taskByThread(from.id, threadId)?.title,
    });
  }
  return PASS;
}
