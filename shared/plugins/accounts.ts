import { z } from "zod";

/** Platforms EAC may bind to a bot. A platform adapter reports which of these it can actually serve. */
export const PLATFORM_IDS = ["qq", "bilibili", "xianyu", "douyin", "xiaohongshu", "tieba", "feishu"] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const PLATFORM_STATUSES = ["connected", "expired", "revoked", "unavailable"] as const;
export type PlatformStatus = (typeof PLATFORM_STATUSES)[number];

/** An opaque name in the host secret store. A credential itself is never a field here. */
const credentialRef = z.string().max(120).regex(/^[a-z0-9][a-z0-9._-]{1,119}$/, "must be an opaque secret-store key");

const instant = z.string().datetime({ offset: true });

export const platformAccountSchema = z.object({
  accountId: z.string().uuid(),
  platform: z.enum(PLATFORM_IDS),
  externalAccountId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(120),
  credentialRef: credentialRef.nullable(),
  status: z.enum(PLATFORM_STATUSES),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(64),
  createdAt: instant,
  updatedAt: instant,
}).strict();

export type PlatformAccount = z.infer<typeof platformAccountSchema>;

/** Who a platform account's inbound sender is inside EAC. The host stores this mapping; a message cannot set it. */
export const platformIdentitySchema = z.object({
  accountId: z.string().uuid(),
  externalPersonId: z.string().trim().min(1).max(200),
  personId: z.string().trim().min(1).max(200),
  role: z.enum(["owner", "member"]),
  createdAt: instant,
}).strict();

export type PlatformIdentity = z.infer<typeof platformIdentitySchema>;

export const platformBotBindingSchema = z.object({
  accountId: z.string().uuid(),
  botId: z.string().min(1).max(120),
  mode: z.enum(["existing", "dedicated"]),
  externalBotId: z.string().trim().min(1).max(200).optional(),
  createdAt: instant,
}).strict();

export type PlatformBotBinding = z.infer<typeof platformBotBindingSchema>;

export const platformConversationSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum(["direct", "group", "channel", "comment"]),
}).strict();

export const platformSenderSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().max(200).optional(),
}).strict();

/** One platform event as an adapter delivers it. `echoOf` names an outbound message that came back. */
export const platformInboundEventSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  platform: z.enum(PLATFORM_IDS),
  accountId: z.string().uuid(),
  conversation: platformConversationSchema,
  sender: platformSenderSchema,
  receivedAt: instant,
  text: z.string().max(20_000).optional(),
  replyTo: z.string().trim().min(1).max(200).optional(),
  echoOf: z.string().trim().min(1).max(200).optional(),
}).strict();

export type PlatformInboundEvent = z.infer<typeof platformInboundEventSchema>;

export type PlatformPrincipal =
  | { kind: "owner"; platform: PlatformId; accountId: string; personId: string }
  | { kind: "guest"; platform: PlatformId; accountId: string; personId: string; role: "member" };

export interface PrincipalDerivation {
  principal: PlatformPrincipal;
  audienceId: string;
  /** False when the host has no identity mapping; the sender then holds only guest rights. */
  known: boolean;
}

/** Audience is the conversation, not the platform account: two groups never share a model session. */
export function platformAudienceId(event: Pick<PlatformInboundEvent, "platform" | "accountId" | "conversation">): string {
  return `platform:${event.platform}:${event.accountId}:${event.conversation.kind}:${event.conversation.id}`;
}

/**
 * Resolve the person behind an event from the host's identity table. A sender absent from the table is a guest, never
 * the account owner: the message body cannot promote itself.
 */
export function derivePlatformPrincipal(
  event: Pick<PlatformInboundEvent, "platform" | "accountId" | "sender" | "conversation">,
  identities: readonly PlatformIdentity[],
): PrincipalDerivation {
  const matched = identities.find(
    (identity) => identity.accountId === event.accountId && identity.externalPersonId === event.sender.id,
  );
  const audienceId = platformAudienceId(event);
  if (!matched) {
    return {
      principal: {
        kind: "guest",
        platform: event.platform,
        accountId: event.accountId,
        personId: `platform:${event.platform}:${event.accountId}:guest:${event.sender.id}`,
        role: "member",
      },
      audienceId,
      known: false,
    };
  }
  const principal: PlatformPrincipal = matched.role === "owner"
    ? { kind: "owner", platform: event.platform, accountId: event.accountId, personId: matched.personId }
    : { kind: "guest", platform: event.platform, accountId: event.accountId, personId: matched.personId, role: "member" };
  return { principal, audienceId, known: true };
}

export function isEchoEvent(event: Pick<PlatformInboundEvent, "sender">, account: Pick<PlatformAccount, "externalAccountId">): boolean {
  return event.sender.id === account.externalAccountId;
}
