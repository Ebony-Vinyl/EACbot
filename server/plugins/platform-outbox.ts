import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";

const messageSchema = z.object({
  id: z.string().min(1).max(120),
  accountId: z.string().uuid(),
  conversationId: z.string().min(1).max(200),
  conversationKind: z.enum(["direct", "group", "channel", "comment"]),
  text: z.string().min(1).max(20_000),
  replyToEventId: z.string().min(1).max(200).nullable(),
  threadId: z.string().min(1).max(120),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  messages: z.array(messageSchema).max(500),
}).strict();

export type PlatformOutboxMessage = z.infer<typeof messageSchema>;

export class PlatformOutboxError extends Error {
  readonly code: "invalid" | "not-found" | "corrupt" | "full";
  constructor(code: PlatformOutboxError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The bot's replies to platform conversations, until their bridge takes them. A bridge lists what arrived after the id
 * it last took and acknowledges the ids it delivered; nothing here talks to a platform itself.
 */
export class PlatformOutboxStore {
  readonly file: string;
  private state: z.infer<typeof fileSchema> | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, "platforms", "outbox.json");
  }

  /** Appends one reply. A caller-supplied idempotency key (same key, same reply) is the only dedup: a turn settles once. */
  append(input: {
    accountId: string;
    conversationId: string;
    conversationKind: PlatformOutboxMessage["conversationKind"];
    text: string;
    replyToEventId?: string | null;
    threadId: string;
    idempotencyKey?: string;
    now?: () => string;
  }): PlatformOutboxMessage {
    const state = this.load();
    const id = (input.idempotencyKey ?? `msg_${randomUUID().replaceAll("-", "")}`).slice(0, 120);
    const held = this.get(id);
    if (held) return held;
    const message: PlatformOutboxMessage = {
      id,
      accountId: input.accountId,
      conversationId: input.conversationId,
      conversationKind: input.conversationKind,
      text: input.text,
      replyToEventId: input.replyToEventId ?? null,
      threadId: input.threadId,
      createdAt: (input.now ?? (() => new Date().toISOString()))(),
    };
    const parsed = messageSchema.safeParse(message);
    if (!parsed.success) throw new PlatformOutboxError("invalid", parsed.error.issues[0]?.message ?? "invalid outbox message");
    state.messages.push(parsed.data);
    this.persist(state);
    return parsed.data;
  }

  list(accountId: string, sinceId?: string): PlatformOutboxMessage[] {
    const state = this.load();
    const at = sinceId ? state.messages.findIndex((message) => message.id === sinceId) : -1;
    const from = at >= 0 ? at + 1 : 0;
    return state.messages.slice(from).filter((message) => message.accountId === accountId).map((message) => ({ ...message }));
  }

  /** Removes everything a bridge took, or nothing when one id is already gone (an ack may arrive twice). */
  ack(accountId: string, ids: string[]): number {
    if (ids.length > 200) throw new PlatformOutboxError("invalid", "at most 200 ids per ack");
    const state = this.load();
    const wanted = new Set(ids);
    const kept = state.messages.filter((message) => !(message.accountId === accountId && wanted.has(message.id)));
    const removed = state.messages.length - kept.length;
    if (removed) this.persist({ schemaVersion: 1, messages: kept });
    return removed;
  }

  get(id: string): PlatformOutboxMessage | null {
    return this.load().messages.find((message) => message.id === id) ?? null;
  }

  private load(): z.infer<typeof fileSchema> {
    if (this.state) return this.state;
    if (!existsSync(this.file)) {
      this.state = { schemaVersion: 1, messages: [] };
      return this.state;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new PlatformOutboxError("corrupt", "platforms/outbox.json is not valid JSON");
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) throw new PlatformOutboxError("corrupt", "platforms/outbox.json does not match schema version 1");
    this.state = parsed.data;
    return this.state;
  }

  private persist(state: z.infer<typeof fileSchema>): void {
    if (state.messages.length > 500) throw new PlatformOutboxError("full", "the platform outbox is full; a bridge must ack its deliveries");
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    this.state = state;
  }
}
