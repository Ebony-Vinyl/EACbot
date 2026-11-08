import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import {
  derivePlatformPrincipal,
  isEchoEvent,
  platformAccountSchema,
  platformBotBindingSchema,
  platformIdentitySchema,
  platformInboundEventSchema,
  type PlatformAccount,
  type PlatformBotBinding,
  type PlatformIdentity,
  type PlatformInboundEvent,
  type PlatformPrincipal,
  type PlatformStatus,
} from "../../shared/plugins/accounts.ts";

const routeSchema = z.object({
  accountId: z.string().uuid(),
  conversationId: z.string().min(1).max(200),
  botId: z.string().min(1).max(120),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

const seenSchema = z.object({
  accountId: z.string().uuid(),
  eventId: z.string().min(1).max(200),
  at: z.string().datetime({ offset: true }),
}).strict();

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  accounts: z.array(platformAccountSchema).max(200),
  identities: z.array(platformIdentitySchema).max(2_000),
  bindings: z.array(platformBotBindingSchema).max(200),
  routes: z.array(routeSchema).max(1_000),
  seen: z.array(seenSchema).max(5_000),
}).strict();

export class PlatformAccountError extends Error {
  readonly code: "invalid" | "duplicate" | "not-found" | "conflict" | "corrupt";
  constructor(code: PlatformAccountError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type PlatformRoute =
  | {
    action: "delivered";
    event: PlatformInboundEvent;
    account: PlatformAccount;
    botId: string;
    principal: PlatformPrincipal;
    audienceId: string;
    known: boolean;
    /** A conversation-level override was used rather than the account's default binding. */
    overridden: boolean;
  }
  | { action: "unbound"; event: PlatformInboundEvent; account: PlatformAccount }
  | { action: "ignored"; event: PlatformInboundEvent; reason: "duplicate" | "echo" | "account-not-connected" }
  | { action: "unknown-account"; event: PlatformInboundEvent };

export interface PlatformAccountStoreOptions {
  now?: () => string;
  seenLimit?: number;
}

const DEFAULT_SEEN_LIMIT = 2_000;

/**
 * Platform accounts, the host-owned identity mapping and the one bot that answers each conversation. Credentials are
 * referenced by secret-store key only; no token is persisted here.
 */
export class PlatformAccountStore {
  readonly file: string;
  private state: z.infer<typeof fileSchema> | null = null;
  private readonly now: () => string;
  private readonly seenLimit: number;

  constructor(dataDir: string, options: PlatformAccountStoreOptions = {}) {
    this.file = join(dataDir, "platforms", "accounts.json");
    this.now = options.now ?? (() => new Date().toISOString());
    this.seenLimit = options.seenLimit ?? DEFAULT_SEEN_LIMIT;
  }

  listAccounts(): PlatformAccount[] {
    return this.load().accounts.map((account) => structuredClone(account));
  }

  account(accountId: string): PlatformAccount | null {
    const found = this.load().accounts.find((account) => account.accountId === accountId);
    return found ? structuredClone(found) : null;
  }

  addAccount(input: {
    platform: PlatformAccount["platform"];
    externalAccountId: string;
    displayName: string;
    credentialRef?: string | null;
    capabilities?: string[];
    status?: PlatformStatus;
  }): PlatformAccount {
    const at = this.now();
    const parsed = platformAccountSchema.safeParse({
      accountId: randomUUID(),
      platform: input.platform,
      externalAccountId: input.externalAccountId,
      displayName: input.displayName,
      credentialRef: input.credentialRef ?? null,
      status: input.status ?? "connected",
      capabilities: input.capabilities ?? [],
      createdAt: at,
      updatedAt: at,
    });
    if (!parsed.success) throw new PlatformAccountError("invalid", parsed.error.issues[0]?.message ?? "invalid account");
    const state = this.load();
    if (state.accounts.some((account) => account.platform === parsed.data.platform && account.externalAccountId === parsed.data.externalAccountId)) {
      throw new PlatformAccountError("duplicate", "this platform account is already connected");
    }
    state.accounts.push(parsed.data);
    this.persist(state);
    return structuredClone(parsed.data);
  }

  setStatus(accountId: string, status: PlatformStatus): PlatformAccount {
    const state = this.load();
    const index = state.accounts.findIndex((account) => account.accountId === accountId);
    if (index < 0) throw new PlatformAccountError("not-found", "no such platform account");
    const parsed = platformAccountSchema.safeParse({ ...state.accounts[index]!, status, updatedAt: this.now() });
    if (!parsed.success) throw new PlatformAccountError("invalid", parsed.error.issues[0]?.message ?? "invalid status");
    state.accounts[index] = parsed.data;
    this.persist(state);
    return structuredClone(parsed.data);
  }

  removeAccount(accountId: string): PlatformAccount {
    const state = this.load();
    const index = state.accounts.findIndex((account) => account.accountId === accountId);
    if (index < 0) throw new PlatformAccountError("not-found", "no such platform account");
    const [removed] = state.accounts.splice(index, 1);
    state.identities = state.identities.filter((identity) => identity.accountId !== accountId);
    state.bindings = state.bindings.filter((binding) => binding.accountId !== accountId);
    state.routes = state.routes.filter((route) => route.accountId !== accountId);
    this.persist(state);
    return structuredClone(removed!);
  }

  identities(accountId: string): PlatformIdentity[] {
    return this.load().identities
      .filter((identity) => identity.accountId === accountId)
      .map((identity) => structuredClone(identity));
  }

  /** The host, not an inbound message, records who the account's owner is. */
  upsertIdentity(accountId: string, input: { externalPersonId: string; personId: string; role: PlatformIdentity["role"] }): PlatformIdentity {
    this.requireAccount(accountId);
    const parsed = platformIdentitySchema.safeParse({
      accountId,
      externalPersonId: input.externalPersonId,
      personId: input.personId,
      role: input.role,
      createdAt: this.now(),
    });
    if (!parsed.success) throw new PlatformAccountError("invalid", parsed.error.issues[0]?.message ?? "invalid identity");
    const state = this.load();
    state.identities = state.identities.filter(
      (identity) => !(identity.accountId === accountId && identity.externalPersonId === input.externalPersonId),
    );
    state.identities.push(parsed.data);
    this.persist(state);
    return structuredClone(parsed.data);
  }

  removeIdentity(accountId: string, externalPersonId: string): boolean {
    const state = this.load();
    const before = state.identities.length;
    state.identities = state.identities.filter(
      (identity) => !(identity.accountId === accountId && identity.externalPersonId === externalPersonId),
    );
    if (state.identities.length === before) return false;
    this.persist(state);
    return true;
  }

  bind(accountId: string, botId: string, mode: PlatformBotBinding["mode"], externalBotId?: string): PlatformBotBinding {
    this.requireAccount(accountId);
    const state = this.load();
    if (state.bindings.some((binding) => binding.accountId === accountId)) {
      throw new PlatformAccountError("conflict", "this platform account already has a bot; unbind it first");
    }
    const parsed = platformBotBindingSchema.safeParse({
      accountId,
      botId,
      mode,
      ...(externalBotId ? { externalBotId } : {}),
      createdAt: this.now(),
    });
    if (!parsed.success) throw new PlatformAccountError("invalid", parsed.error.issues[0]?.message ?? "invalid binding");
    state.bindings.push(parsed.data);
    this.persist(state);
    return structuredClone(parsed.data);
  }

  unbind(accountId: string): PlatformBotBinding {
    const state = this.load();
    const index = state.bindings.findIndex((binding) => binding.accountId === accountId);
    if (index < 0) throw new PlatformAccountError("not-found", "this platform account has no bot");
    const [removed] = state.bindings.splice(index, 1);
    state.routes = state.routes.filter((route) => route.accountId !== accountId);
    this.persist(state);
    return structuredClone(removed!);
  }

  binding(accountId: string): PlatformBotBinding | null {
    const found = this.load().bindings.find((binding) => binding.accountId === accountId);
    return found ? structuredClone(found) : null;
  }

  bindings(): PlatformBotBinding[] {
    return this.load().bindings.map((binding) => structuredClone(binding));
  }

  /** A single conversation may go to another bot; every other conversation keeps the account's default bot. */
  setConversationRoute(accountId: string, conversationId: string, botId: string): void {
    this.requireAccount(accountId);
    if (botId !== this.binding(accountId)?.botId) {
      // A conversation override does not need a binding of its own, but it must never point at an empty id.
      if (!botId.trim()) throw new PlatformAccountError("invalid", "botId is required");
    }
    const state = this.load();
    state.routes = state.routes.filter(
      (route) => !(route.accountId === accountId && route.conversationId === conversationId),
    );
    state.routes.push({ accountId, conversationId, botId, createdAt: this.now() });
    this.persist(state);
  }

  clearConversationRoute(accountId: string, conversationId: string): boolean {
    const state = this.load();
    const before = state.routes.length;
    state.routes = state.routes.filter(
      (route) => !(route.accountId === accountId && route.conversationId === conversationId),
    );
    if (state.routes.length === before) return false;
    this.persist(state);
    return true;
  }

  /**
   * Deliver an event to exactly one bot. Duplicate delivery, an echoed outbound message and a paused account are
   * consumed here, before any queue or model call. `remember: false` leaves the event unseen, so an admission that
   * failed for a busy or full reason can be delivered again later by the same bridge retry.
   */
  resolveInbound(raw: unknown, options: { remember?: boolean } = {}): PlatformRoute {
    const remember = options.remember !== false;
    const parsed = platformInboundEventSchema.safeParse(raw);
    if (!parsed.success) throw new PlatformAccountError("invalid", parsed.error.issues[0]?.message ?? "invalid inbound event");
    const event = parsed.data;
    const state = this.load();
    const account = state.accounts.find((candidate) => candidate.accountId === event.accountId);
    if (!account) return { action: "unknown-account", event };
    if (account.platform !== event.platform) throw new PlatformAccountError("invalid", "the event platform does not match the account");

    if (state.seen.some((seen) => seen.eventId === event.eventId && seen.accountId === event.accountId)) {
      return { action: "ignored", event, reason: "duplicate" };
    }
    if (remember) this.rememberSeen(state, event.accountId, event.eventId);
    if (isEchoEvent(event, account)) {
      if (remember) this.persist(state);
      return { action: "ignored", event, reason: "echo" };
    }
    if (account.status !== "connected") {
      if (remember) this.persist(state);
      return { action: "ignored", event, reason: "account-not-connected" };
    }
    const override = state.routes.find(
      (route) => route.accountId === event.accountId && route.conversationId === event.conversation.id,
    );
    const binding = state.bindings.find((candidate) => candidate.accountId === event.accountId);
    const botId = override?.botId ?? binding?.botId;
    if (!botId) {
      if (remember) this.persist(state);
      return { action: "unbound", event, account };
    }
    const derivation = derivePlatformPrincipal(event, state.identities);
    if (remember) this.persist(state);
    return {
      action: "delivered",
      event,
      account,
      botId,
      principal: derivation.principal,
      audienceId: derivation.audienceId,
      known: derivation.known,
      overridden: override !== undefined,
    };
  }

  /** Marks an event delivered under `remember: false` as consumed once its turn has been admitted. */
  markSeen(accountId: string, eventId: string): void {
    const state = this.load();
    if (state.seen.some((seen) => seen.eventId === eventId && seen.accountId === accountId)) return;
    this.rememberSeen(state, accountId, eventId);
    this.persist(state);
  }

  private rememberSeen(state: z.infer<typeof fileSchema>, accountId: string, eventId: string): void {
    state.seen.push({ accountId, eventId, at: this.now() });
    if (state.seen.length > this.seenLimit) state.seen = state.seen.slice(state.seen.length - this.seenLimit);
  }

  private requireAccount(accountId: string): PlatformAccount {
    const state = this.load();
    const account = state.accounts.find((candidate) => candidate.accountId === accountId);
    if (!account) throw new PlatformAccountError("not-found", "no such platform account");
    return account;
  }

  /** The on-disk schema caps each array; a write that would exceed a cap is refused instead of making the file unreadable. */
  private assertCapacity(state: z.infer<typeof fileSchema>): void {
    const caps: Array<[keyof z.infer<typeof fileSchema>, number]> = [["accounts", 200], ["identities", 2_000], ["bindings", 200], ["routes", 1_000]];
    for (const [key, cap] of caps) {
      const rows = state[key];
      if (Array.isArray(rows) && rows.length > cap) {
        throw new PlatformAccountError("conflict", `the platform store is full (${key}); remove an entry first`);
      }
    }
  }

  private load(): z.infer<typeof fileSchema> {
    if (this.state) return this.state;
    if (!existsSync(this.file)) {
      this.state = { schemaVersion: 1, accounts: [], identities: [], bindings: [], routes: [], seen: [] };
      return this.state;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new PlatformAccountError("corrupt", "platforms/accounts.json is not valid JSON");
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) throw new PlatformAccountError("corrupt", "platforms/accounts.json does not match schema version 1");
    this.state = parsed.data;
    return this.state;
  }

  private persist(state: z.infer<typeof fileSchema>): void {
    this.assertCapacity(state);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    this.state = state;
  }
}
