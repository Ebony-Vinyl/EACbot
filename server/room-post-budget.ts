import { positiveLimit, quotaLimits, type QuotaLimits } from "./limits.ts";

export interface RoomPostRecord {
  botId: string;
  text: string;
  at: number;
}

export interface RoomPostBudget {
  posts: RoomPostRecord[];
  trippedAt?: number;
}

export type RoomPostRefusal = "duplicate" | "ring" | "breaker" | "sender-rate" | "escalate";

export type RoomPostDecision =
  | { allowed: true; budget: RoomPostBudget }
  | { allowed: false; refusal: RoomPostRefusal; message: string; budget: RoomPostBudget };

export interface RoomPostAttempt {
  botId: string;
  botName: string;
  text: string;
  now: number;
  lastHumanAt?: number;
}

const SENDER_WINDOW_MS = 60_000;
const SENDER_MAX = 10;
const DUPLICATE_WINDOW_MS = 60_000;
const RING_WINDOW_MS = 120_000;
const DEFAULT_BREAKER_MINUTES = 5;
const ESCALATE_WINDOW_MS = 5 * 60_000;
const ESCALATE_MAX = 2;

/** Room posts one bot turn may make: config.json "limits.roomPostsPerTurn", else the original 3. */
export const DEFAULT_ROOM_POSTS_PER_TURN = 3;
export function roomPostsPerTurn(): number {
  return positiveLimit(quotaLimits().roomPostsPerTurn, DEFAULT_ROOM_POSTS_PER_TURN);
}

/** The posting budgets config.json may raise; absent keys keep the original numbers. */
export interface RoomPostLimits {
  /** Posts one bot may make in a room in a minute. */
  senderMax: number;
  /** Unanswered bot posts a room takes before it asks a person; 0 refuses every unanswered post. */
  escalateMax: number;
  /** How long a room stays closed after the loop breaker trips. */
  breakerCooldownMs: number;
  /** How long a record is kept, so a raised budget still sees the posts it must count. */
  retentionMs: number;
}

const nonNegative = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;

export function roomPostLimits(configured: QuotaLimits = quotaLimits()): RoomPostLimits {
  const breakerCooldownMs = positiveLimit(configured.roomBreakerMinutes, DEFAULT_BREAKER_MINUTES) * 60_000;
  return {
    senderMax: positiveLimit(configured.roomPostsPerMinute, SENDER_MAX),
    escalateMax: nonNegative(configured.roomPostsWithoutReply, ESCALATE_MAX),
    breakerCooldownMs,
    retentionMs: Math.max(SENDER_WINDOW_MS, DUPLICATE_WINDOW_MS, RING_WINDOW_MS, ESCALATE_WINDOW_MS, breakerCooldownMs),
  };
}

export function emptyRoomPostBudget(): RoomPostBudget {
  return { posts: [] };
}

function recentSenders(posts: RoomPostRecord[], now: number): string[] {
  return posts.filter((post) => now - post.at < RING_WINDOW_MS).map((post) => post.botId);
}

function closesRing(senders: string[], candidate: string): boolean {
  const tail = [...senders.slice(-3), candidate];
  if (tail.length < 4) return false;
  const [first, second, third, last] = tail;
  return first === last && new Set([first, second, third]).size === 3;
}

/** Refusals are never recorded: counting them would let a blocked bot deepen its own block. */
export function decideRoomPost(
  budget: RoomPostBudget,
  attempt: RoomPostAttempt,
  limits: RoomPostLimits = roomPostLimits(),
): RoomPostDecision {
  const { botId, botName, text, now, lastHumanAt } = attempt;
  const posts = budget.posts.filter((post) => now - post.at < limits.retentionMs);
  const tripped = budget.trippedAt !== undefined && now - budget.trippedAt < limits.breakerCooldownMs
    ? budget.trippedAt
    : undefined;
  const kept: RoomPostBudget = tripped === undefined ? { posts } : { posts, trippedAt: tripped };
  const refuse = (refusal: RoomPostRefusal, message: string, next = kept): RoomPostDecision => ({
    allowed: false,
    refusal,
    message,
    budget: next,
  });

  if (tripped !== undefined) {
    return refuse(
      "breaker",
      "Posting into this room is closed: its bots were answering each other in a loop. Do not call post_to_room again for this room — say what you wanted to post in your own reply, where the user will read it.",
    );
  }
  const duplicate = posts.some(
    (post) => post.botId === botId && post.text === text && now - post.at < DUPLICATE_WINDOW_MS,
  );
  if (duplicate) {
    return refuse(
      "duplicate",
      "You already posted that exact message in this room a moment ago, and it is still there. Do not post it again; treat it as delivered and move on.",
    );
  }
  if (closesRing(recentSenders(posts, now), botId)) {
    return refuse(
      "ring",
      `Posting into this room is now closed: ${botName} is completing a loop the room's bots have been passing between themselves. Do not retry, and do not post to another room instead — tell the user what is going round and let them decide.`,
      { posts, trippedAt: now },
    );
  }
  const bySender = posts.filter((post) => post.botId === botId && now - post.at < SENDER_WINDOW_MS).length;
  if (bySender >= limits.senderMax) {
    return refuse(
      "sender-rate",
      `You have posted ${limits.senderMax} times in this room in the last minute, which is the limit. Do not retry this call — finish your turn and say anything further to the user directly.`,
    );
  }
  const unanswered = posts.filter(
    (post) => now - post.at < ESCALATE_WINDOW_MS && (lastHumanAt === undefined || post.at > lastHumanAt),
  ).length;
  if (unanswered >= limits.escalateMax) {
    return refuse(
      "escalate",
      `This room has already taken ${unanswered} bot posts that nobody has answered, which is as far as bots go without a person. Stop posting and ask the user what they want said in the room — tell them that anything they write in the room themselves re-opens it, and that it also re-opens by itself after a few minutes. Do not retry this call.`,
    );
  }
  return { allowed: true, budget: { posts: [...posts, { botId, text, at: now }] } };
}
