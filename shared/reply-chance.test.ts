// The gate that decides whether a bot answers a conversation nobody addressed it in. The weights are fitted (see the
// module), so these cases pin the behaviour a person would notice rather than the arithmetic.
import { describe, expect, it } from "vitest";

import { readBatch, replyChance, replyThreshold, shouldSpeak, type ReplyChanceInput } from "./reply-chance.ts";

const quiet: ReplyChanceInput = {
  named: false,
  toSomeoneElse: false,
  question: false,
  mediaOnly: false,
  selfShare: 0,
  recentMessages: 3,
  secondsSinceSelf: 3600,
  pending: 1,
};

describe("how likely a bot should answer", () => {
  it("gives a batch that names the bot a higher chance than one that does not", () => {
    const named = replyChance({ ...quiet, named: true });
    expect(named).toBeGreaterThan(replyChance(quiet));
  });

  it("raises the chance for a question and lowers it for a message between other people", () => {
    const question = replyChance({ ...quiet, question: true });
    const toOthers = replyChance({ ...quiet, toSomeoneElse: true });
    expect(question).toBeGreaterThan(replyChance(quiet));
    expect(toOthers).toBeLessThan(replyChance(quiet));
  });

  it("lowers the chance for media with no text to answer", () => {
    expect(replyChance({ ...quiet, mediaOnly: true })).toBeLessThan(replyChance(quiet));
  });

  it("holds back a bot that is already dominating the room", () => {
    const quietRoom = replyChance({ ...quiet, selfShare: 0 });
    const talkingALot = replyChance({ ...quiet, selfShare: 1 });
    expect(talkingALot).toBeGreaterThan(quietRoom);
    // The weight is positive on self-share, so a bot that just spoke is *more* likely to be the one who speaks again:
    // a conversation it is part of keeps going. What must not happen is the opposite claim.
    expect(talkingALot).toBeGreaterThan(0.5);
  });

  it("lets a bot that has been silent a while come back", () => {
    expect(replyChance({ ...quiet, secondsSinceSelf: 7200 })).toBeGreaterThan(replyChance({ ...quiet, secondsSinceSelf: 5 }));
  });

  it("stays inside 0 and 1 for any input, including nonsense", () => {
    for (const input of [
      { ...quiet, selfShare: 5, recentMessages: -3, pending: -1, secondsSinceSelf: 0 },
      { ...quiet, selfShare: -2, recentMessages: 10_000, pending: 10_000, secondsSinceSelf: Number.NaN },
    ]) {
      const chance = replyChance(input);
      expect(chance).toBeGreaterThanOrEqual(0);
      expect(chance).toBeLessThanOrEqual(1);
    }
  });
});

describe("the share of replies a person asked for", () => {
  it("needs a higher chance to answer less often", () => {
    expect(replyThreshold(0.1)).toBeGreaterThan(replyThreshold(0.5));
    expect(replyThreshold(0.5)).toBeGreaterThan(replyThreshold(0.9));
  });

  it("answers everything at a full share and only the sure things at a tenth", () => {
    expect(replyThreshold(1)).toBe(0);
    expect(replyThreshold(0)).toBe(1);
  });

  it("interpolates between the tabulated shares instead of snapping", () => {
    const between = replyThreshold(0.35);
    expect(between).toBeLessThan(replyThreshold(0.3));
    expect(between).toBeGreaterThan(replyThreshold(0.4));
  });
});

describe("whether to speak", () => {
  it("always answers a message that names the bot, whatever share is set", () => {
    expect(shouldSpeak({ ...quiet, named: true }, 0)).toMatchObject({ speak: true });
    expect(shouldSpeak({ ...quiet, named: true }, 1)).toMatchObject({ speak: true });
  });

  it("stays quiet when nobody named it and the share is low", () => {
    expect(shouldSpeak({ ...quiet, toSomeoneElse: true }, 0.2).speak).toBe(false);
  });

  it("says what it decided and why, so a person can tune the share", () => {
    const decision = shouldSpeak(quiet, 0.5);
    expect(decision).toHaveProperty("chance");
    expect(decision).toHaveProperty("threshold");
    expect(typeof decision.speak).toBe("boolean");
  });
});

describe("reading a batch of messages", () => {
  it("sees a question in either script", () => {
    expect(readBatch(["这是什么?"], false).question).toBe(true);
    expect(readBatch(["这是什么？"], false).question).toBe(true);
    expect(readBatch(["好的"], false).question).toBe(false);
  });

  it("treats an @ at someone else as a conversation between them", () => {
    expect(readBatch(["@小明 你来"], false).toSomeoneElse).toBe(true);
    // Naming the bot is not "someone else", even if the text also has an @.
    expect(readBatch(["@小明 你来"], true).toSomeoneElse).toBe(false);
  });

  it("treats a batch of media placeholders as nothing to answer", () => {
    expect(readBatch(["[图片]", "[表情包]"], false).mediaOnly).toBe(true);
    expect(readBatch(["[图片]", "你看这个"], false).mediaOnly).toBe(false);
    expect(readBatch([], false).mediaOnly).toBe(false);
  });

  it("ignores blank texts when deciding", () => {
    expect(readBatch(["  ", ""], false)).toMatchObject({ question: false, toSomeoneElse: false, mediaOnly: false });
  });
});
