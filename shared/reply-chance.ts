// Whether a bot speaks in a conversation nobody addressed it in. A group chat is not a request queue: most messages
// are not for the bot, and a bot that answers every one is noise. This decides by probability, from the same shape of
// evidence a person reads: was I named, is someone asking a question, am I already dominating the last few minutes.
//
// The weights are fitted, not chosen: they come from a logistic model fitted over logged group-chat rounds that had
// new messages and no mention of the bot. Keeping the numbers here rather than inventing new ones means the gate
// behaves as measured, and the module stays a pure function that tests can pin.

/** Features of one batch of new messages, plus the recent room. */
export interface ReplyChanceInput {
  /** The bot's name or alias appeared in the new messages. */
  named: boolean;
  /** Someone @-mentioned a person other than the bot, so the exchange is between them. */
  toSomeoneElse: boolean;
  /** A question mark in the new messages. */
  question: boolean;
  /** Every new message was media only (an image, a sticker, a file), so there is no text to answer. */
  mediaOnly: boolean;
  /** Share of the last five minutes' messages the bot itself sent, 0–1. */
  selfShare: number;
  /** Messages in the last five minutes. */
  recentMessages: number;
  /** Seconds since the bot last said anything. */
  secondsSinceSelf: number;
  /** New messages waiting in this batch. */
  pending: number;
}

/** The fitted intercept and weights, unchanged. */
const INTERCEPT = -1.2005;
const W_NAMED = 1.5852;
const W_TO_SOMEONE_ELSE = -1.1157;
const W_QUESTION = 0.4807;
const W_MEDIA_ONLY = -1.0281;
const W_SELF_SHARE = 2.6525;
const W_RECENT_MESSAGES = -0.0367;
const W_LOG_SECONDS = 0.0571;
const W_PENDING = 0.1012;

/** Above this many pending messages the batch is treated as this many, as the fit was truncated there. */
const MAX_PENDING = 20;

/** Used when the bot has not spoken in the visible history. */
const DEFAULT_SECONDS_SINCE_SELF = 3600;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The chance this batch is one the bot should answer, 0–1. */
export function replyChance(input: ReplyChanceInput): number {
  const seconds = Number.isFinite(input.secondsSinceSelf) && input.secondsSinceSelf > 0 ? input.secondsSinceSelf : DEFAULT_SECONDS_SINCE_SELF;
  const logit = INTERCEPT
    + W_NAMED * (input.named ? 1 : 0)
    + W_TO_SOMEONE_ELSE * (input.toSomeoneElse ? 1 : 0)
    + W_QUESTION * (input.question ? 1 : 0)
    + W_MEDIA_ONLY * (input.mediaOnly ? 1 : 0)
    + W_SELF_SHARE * clamp01(input.selfShare)
    + W_RECENT_MESSAGES * Math.max(0, input.recentMessages)
    + W_LOG_SECONDS * Math.log1p(Math.min(seconds, 86_400))
    + W_PENDING * Math.min(Math.max(0, input.pending), MAX_PENDING);
  return 1 / (1 + Math.exp(-logit));
}

/**
 * The probability a batch must beat to be answered, for a wanted share of the conversation's replies. The table is
 * The offline fit: keeping 30% of the replies a bot would otherwise send means only answering the top 30% by chance.
 * Interpolated so a person can pick any share, not just the tabulated ones.
 */
const KEEP_RATIO_THRESHOLDS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0.1, 0.605], [0.2, 0.482], [0.3, 0.43], [0.4, 0.376], [0.5, 0.336],
  [0.6, 0.313], [0.7, 0.29], [0.8, 0.25], [0.9, 0.206], [1, 0],
];

export function replyThreshold(keepRatio: number): number {
  const wanted = clamp01(keepRatio);
  for (let index = 0; index < KEEP_RATIO_THRESHOLDS.length - 1; index += 1) {
    const [lowRatio, lowThreshold] = KEEP_RATIO_THRESHOLDS[index]!;
    const [highRatio, highThreshold] = KEEP_RATIO_THRESHOLDS[index + 1]!;
    if (wanted <= highRatio) {
      const progress = highRatio === lowRatio ? 0 : (wanted - lowRatio) / (highRatio - lowRatio);
      return lowThreshold + (highThreshold - lowThreshold) * progress;
    }
  }
  return 0;
}

export interface SpeakDecision {
  speak: boolean;
  chance: number;
  threshold: number;
}

/**
 * Whether to answer. A message that names the bot is always answered, which is the one case a person clearly asked
 * for a reply; everything else has to clear the threshold.
 */
export function shouldSpeak(input: ReplyChanceInput, keepRatio: number): SpeakDecision {
  const chance = replyChance(input);
  const threshold = replyThreshold(keepRatio);
  return { speak: input.named || chance >= threshold, chance, threshold };
}

/** Media-only placeholders a bridge may pass through as text; a batch of only these has nothing to answer. */
const MEDIA_PREFIXES = ["[表情包", "[图片", "[消息类型]", "[CQ:image", "[语音", "[文件]", "[卡片"];

/** Reads the three facts about a batch that its texts alone decide. `named` is decided by the caller. */
export function readBatch(texts: readonly string[], named: boolean): Pick<ReplyChanceInput, "toSomeoneElse" | "question" | "mediaOnly"> {
  const bodies = texts.map((text) => text.trim()).filter(Boolean);
  return {
    toSomeoneElse: !named && bodies.some((text) => text.includes("@")),
    question: bodies.some((text) => text.includes("?") || text.includes("？")),
    mediaOnly: bodies.length > 0 && bodies.every((text) => MEDIA_PREFIXES.some((prefix) => text.startsWith(prefix))),
  };
}
