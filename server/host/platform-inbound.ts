// Platform inbound events become Bot turns: one conversation maps to one EACbot thread, the bot's reply lands in an
// outbox its bridge takes away. The account store decides routing and dedup; this file only admits the turn.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import {
  PlatformAccountError,
  type PlatformAccountStore,
  type PlatformRoute,
} from "../plugins/platform-accounts.ts";
import { type PlatformOutboxStore } from "../plugins/platform-outbox.ts";
import { readBatch, shouldSpeak, type ReplyChanceInput } from "../../shared/reply-chance.ts";
import type { PlatformTurnContext } from "./memory-context.ts";

const threadsSchema = z.object({
  schemaVersion: z.literal(1),
  threads: z.array(z.object({
    key: z.string().min(1).max(450),
    accountId: z.string().uuid(),
    conversationId: z.string().min(1).max(200),
    conversationKind: z.enum(["direct", "group", "channel", "comment"]).optional(),
    platform: z.enum(["qq", "bilibili", "xianyu", "douyin", "xiaohongshu", "tieba"]),
    botId: z.string().min(1).max(120),
    threadId: z.string().min(1).max(120),
    createdAt: z.string().datetime({ offset: true }),
  }).strict()).max(1_000),
}).strict();

type ThreadsFile = z.infer<typeof threadsSchema>;

export interface PlatformInboundDeps {
  accounts: PlatformAccountStore;
  outbox: PlatformOutboxStore;
  dataDir: string;
  store: {
    taskByThread(botId: string, threadId: string): { threadId: string } | null | undefined;
    createTask(botId: string, title?: string, activate?: boolean, projectId?: string, openedBy?: unknown, approvalMode?: "ask" | "full"): { threadId: string } | null;
  };
  canStart(botId: string, threadId: string | undefined): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  /** The bot's name and aliases, so a message that names it is always answered. */
  namesOf?(botId: string): string[];
  /**
   * The last few minutes of this conversation, oldest last, for the "am I already talking too much" reading. Absent
   * means the gate cannot tell, and it answers only what names the bot.
   */
  recent?(botId: string, threadId: string): Array<{ role: string; text: string; at: number }>;
  /** Share of replies this conversation wants, 0–1. Absent or 1 keeps the old behaviour of answering every message. */
  replyShare?(): number;
  startTurn(botId: string, text: string, opts: {
    threadId: string;
    sender?: { name: string; id?: string };
    unattended?: boolean;
    automationSource?: "webhook";
    platformContext: PlatformTurnContext;
    onSettled(outcome: { ok: boolean; text: string }): void;
  }): Promise<unknown>;
  now?: () => string;
}

const PLATFORM_LABELS: Record<ThreadsFile["threads"][number]["platform"], string> = {
  qq: "QQ", bilibili: "Bilibili", xianyu: "Xianyu", douyin: "Douyin", xiaohongshu: "Xiaohongshu", tieba: "Tieba",
};

export type PlatformDelivery =
  | { status: 200; body: { route: PlatformRoute } }
  /** Delivered, and deliberately not answered: the gate judged this message not for the bot. */
  | { status: 200; body: { route: PlatformRoute; threadId: string; silent: true } }
  | { status: 202; body: { route: PlatformRoute; threadId: string; accepted: true } }
  | { status: 404; body: { route: PlatformRoute } }
  | { status: 409; body: { route: PlatformRoute; threadId?: string; error: string; code?: string } }
  | { status: 502; body: { route?: PlatformRoute; threadId?: string; error: string; code: string } }
  | { status: number; body: { error: string; code: string } };

/** Delivers one raw platform event: routing, the thread, the turn, and the reply's ride to the outbox. */
export function createPlatformInboundHost(deps: PlatformInboundDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const threadsFile = join(deps.dataDir, "platforms", "threads.json");
  let threads: ThreadsFile | null = null;

  const loadThreads = (): ThreadsFile => {
    if (threads) return threads;
    if (!existsSync(threadsFile)) {
      threads = { schemaVersion: 1, threads: [] };
      return threads;
    }
    const parsed = threadsSchema.safeParse(JSON.parse(readFileSync(threadsFile, "utf8")));
    if (!parsed.success) {
      console.warn("platform inbound: platforms/threads.json does not match schema version 1; starting a new mapping");
      threads = { schemaVersion: 1, threads: [] };
      return threads;
    }
    threads = parsed.data;
    return threads;
  };

  const persistThreads = (state: ThreadsFile): void => {
    mkdirSync(dirname(threadsFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(threadsFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    threads = state;
  };

  const conversationKey = (accountId: string, conversationId: string, kind: string) => `${accountId}\u0000${kind}\u0000${conversationId}`;

  /** One conversation, one thread for as long as its task exists; an unbound event never opens one. */
  const threadFor = (botId: string, platform: ThreadsFile["threads"][number]["platform"], accountId: string, conversationId: string, conversationKind: PlatformTurnContext["conversation"]["kind"]): string | null => {
    const state = loadThreads();
    const key = conversationKey(accountId, conversationId, conversationKind);
    const found = state.threads.find((row) => row.key === key);
    if (found?.botId === botId && deps.store.taskByThread(botId, found.threadId)) return found.threadId;
    if (!deps.canStart(botId, undefined)) return null;
    const task = deps.store.createTask(botId, `${PLATFORM_LABELS[platform]}: ${conversationId.slice(0, 60)}`, false, undefined, undefined, "ask");
    if (!task) return null;
    const next: ThreadsFile = {
      schemaVersion: 1,
      threads: [...state.threads.filter((row) => row.key !== key), {
        key,
        accountId,
        conversationId,
        conversationKind,
        platform,
        botId,
        threadId: task.threadId,
        createdAt: now(),
      }].slice(-1_000),
    };
    persistThreads(next);
    return task.threadId;
  };

  /** Whether this message is one to answer, from the bot's names and the room's last few minutes. */
  const speakDecision = (botId: string, threadId: string, text: string): { speak: boolean } => {
    const share = deps.replyShare?.();
    // No share configured, or a full one: answer as before, which is what every existing binding expects.
    if (share === undefined || share >= 1) return { speak: true };
    const names = deps.namesOf?.(botId) ?? [];
    const named = names.some((name) => name.length > 0 && text.includes(name));
    const batch = readBatch([text], named);
    const recent = deps.recent?.(botId, threadId) ?? [];
    const cutoff = Date.now() - 5 * 60_000;
    const inWindow = recent.filter((message) => message.at >= cutoff);
    const mine = inWindow.filter((message) => message.role === "assistant");
    const lastMine = mine.at(-1);
    const input: ReplyChanceInput = {
      named,
      ...batch,
      selfShare: inWindow.length ? mine.length / inWindow.length : 0,
      recentMessages: inWindow.length,
      secondsSinceSelf: lastMine ? (Date.now() - lastMine.at) / 1000 : 3600,
      pending: 1,
    };
    return { speak: shouldSpeak(input, share).speak };
  };

  return {
    /** A conversation's EACbot thread, for the platform dashboard to link to. */
    threadOf(accountId: string, conversationId: string, kind: PlatformTurnContext["conversation"]["kind"] = "direct"): string | null {
      const found = loadThreads().threads.find((row) => row.key === conversationKey(accountId, conversationId, kind));
      return found && deps.store.taskByThread(found.botId, found.threadId) ? found.threadId : null;
    },

    async deliver(raw: unknown): Promise<PlatformDelivery> {
      let route: PlatformRoute;
      try {
        route = deps.accounts.resolveInbound(raw, { remember: false });
      } catch (error) {
        if (error instanceof PlatformAccountError) {
          const status = error.code === "invalid" ? 400 : error.code === "corrupt" ? 500 : 422;
          return { status, body: { error: error.message, code: error.code } };
        }
        return { status: 500, body: { error: "platform delivery failed", code: "internal" } };
      }
      if (route.action === "unknown-account") return { status: 404, body: { route } };
      if (route.action === "ignored") {
        if (route.reason !== "duplicate") deps.accounts.markSeen(route.event.accountId, route.event.eventId);
        return { status: 200, body: { route } };
      }
      if (route.action === "unbound") return { status: 200, body: { route } };

      const event = route.event;
      const text = event.text ?? "";
      if (!text.trim()) {
        deps.accounts.markSeen(event.accountId, event.eventId);
        return { status: 200, body: { route } };
      }

      const threadId = threadFor(route.botId, event.platform, event.accountId, event.conversation.id, event.conversation.kind);
      if (!threadId) {
        return { status: 409, body: { route, error: "this bot cannot open another conversation", code: "thread_limit" } };
      }
      if (deps.threadBusy(route.botId, threadId)) {
        return { status: 409, body: { route, threadId, error: "this conversation is already being answered", code: "thread_busy" } };
      }
      // A group chat is not a request queue. Answering every message makes the bot noise, so a message that does not
      // name it has to clear a gate whose odds a person set. The event is still marked seen either way: this is a
      // decision not to answer, not a failure to deliver, and re-delivering it would only ask the same question again.
      const decision = speakDecision(route.botId, threadId, text);
      if (!decision.speak) {
        deps.accounts.markSeen(event.accountId, event.eventId);
        return { status: 200, body: { route, threadId, silent: true } };
      }
      const senderName = event.sender.name ?? `${PLATFORM_LABELS[event.platform]} user`;
      const senderId = route.principal.personId;
      try {
        await deps.startTurn(route.botId, text, {
          threadId,
          sender: { name: senderName, id: senderId },
          unattended: true,
          automationSource: "webhook",
          platformContext: { platform: event.platform, accountId: event.accountId, conversation: event.conversation, sender: event.sender },
          // startTurn resolves at dispatch; the reply lands in the outbox when the turn settles, for the bridge to pull.
          onSettled: (outcome) => {
            if (!outcome.ok || !outcome.text.trim()) return;
            try {
              const current = deps.accounts.resolveInbound(raw, { remember: false, ignoreDuplicate: true });
              if (current.action !== "delivered" || current.botId !== route.botId || current.audienceId !== route.audienceId ||
                  JSON.stringify(current.principal) !== JSON.stringify(route.principal)) return;
              deps.outbox.append({
                accountId: event.accountId,
                conversationId: event.conversation.id,
                conversationKind: event.conversation.kind,
                text: outcome.text,
                replyToEventId: event.eventId,
                threadId,
              });
            } catch (error) {
              console.warn("platform inbound: the reply could not be queued:", error instanceof Error ? error.message : error);
            }
          },
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        const message = error instanceof Error ? error.message : String(error);
        // The event stays unseen: the same delivery again is allowed once the blocking reason is gone.
        if (code === "thread_busy" || code === "thread_limit") {
          return { status: 409, body: { route, threadId, error: message, code } };
        }
        return { status: 502, body: { route, threadId, error: message, code: "turn-failed" } };
      }
      deps.accounts.markSeen(event.accountId, event.eventId);
      return { status: 202, body: { route, threadId, accepted: true } };
    },
  };
}

export type PlatformInboundHost = ReturnType<typeof createPlatformInboundHost>;
