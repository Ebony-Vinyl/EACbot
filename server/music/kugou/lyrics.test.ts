import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  decodeKrc,
  decodeKrcLanguageBlock,
  emptyLyrics,
  looksLikeKrc,
  parseKrcLines,
  parseLrcLines,
  parsePlainLines,
  parseQrcLines,
  parseVttLines,
  parseYrcLines,
  splitTranslation,
  toLyricLines,
} from "./lyrics.ts";

/** Builds a KRC payload the way Kugou serves one: base64, four header bytes, XOR, zlib. */
function encodeKrc(text: string): string {
  const mask = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
  const compressed = deflateSync(Buffer.from(text, "utf8"));
  const body = Buffer.from(compressed);
  for (let index = 0; index < body.length; index++) body[index] = body[index]! ^ mask[index % mask.length]!;
  return Buffer.concat([Buffer.from([0x01, 0x02, 0x03, 0x04]), body]).toString("base64");
}

describe("decodeKrc", () => {
  it("round-trips a payload through base64, the four-byte header, the mask and zlib", () => {
    const text = "[1000,2000]<0,500,0>Hel<500,500,0>lo";
    expect(decodeKrc(encodeKrc(text))).toBe(text);
  });

  it("accepts a data-URI prefix", () => {
    const text = "[0,1000]<0,1000,0>x";
    expect(decodeKrc(`data:application/octet-stream;base64,${encodeKrc(text)}`)).toBe(text);
  });

  it("refuses a payload that is not KRC", () => {
    expect(() => decodeKrc(Buffer.from("not a lyric").toString("base64"))).toThrow(/decompress|too short/);
  });
});

describe("parseKrcLines", () => {
  it("reads a line's start, duration and word spans", () => {
    const lines = parseKrcLines("[1000,2000]<0,400,0>Hello <400,600,0>world");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.atMs).toBe(1_000);
    expect(lines[0]!.durationMs).toBe(2_000);
    expect(lines[0]!.text).toBe("Hello world");
    expect(lines[0]!.words).toEqual([
      { text: "Hello ", atMs: 1_000, durationMs: 400 },
      { text: "world", atMs: 1_400, durationMs: 600 },
    ]);
  });

  it("keeps a line with no word spans as one span over the line", () => {
    const lines = parseKrcLines("[500,1500]plain words");
    expect(lines[0]!.words).toEqual([{ text: "plain words", atMs: 500, durationMs: 1_500 }]);
  });

  it("sorts lines by time and skips metadata", () => {
    const lines = parseKrcLines("[3000,1000]<0,1000,0>second\n[1000,1000]<0,1000,0>first");
    expect(lines.map((line) => line.text)).toEqual(["first", "second"]);
  });
});

describe("parseLrcLines", () => {
  it("reads timestamps with two- or three-digit fractions", () => {
    const lines = parseLrcLines("[00:01.50]one\n[00:03.250]two");
    expect(lines.map((line) => line.atMs)).toEqual([1_500, 3_250]);
  });

  it("gives a repeated timestamp one line per stamp", () => {
    const lines = parseLrcLines("[00:05.00][00:10.00]chorus");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.text)).toEqual(["chorus", "chorus"]);
  });

  it("carries the gap to the next line as the duration", () => {
    const lines = parseLrcLines("[00:01.00]a\n[00:04.00]b");
    expect(lines[0]!.durationMs).toBe(3_000);
  });

  it("skips metadata rows", () => {
    const lines = parseLrcLines("[ti:Title]\n[ar:Someone]\n[00:01.00]a");
    expect(lines).toHaveLength(1);
  });
});

describe("looksLikeKrc", () => {
  it("recognises a KRC body and not a plain LRC one", () => {
    expect(looksLikeKrc("[1000,2000]<0,500,0>x")).toBe(true);
    expect(looksLikeKrc("[00:01.00]x")).toBe(false);
  });
});

describe("splitTranslation", () => {
  it("splits a body at the language marker", () => {
    const { main, translation } = splitTranslation("[1000,1000]<0,1000,0>a\n[language:en]\n[1000,1000]<0,1000,0>hello");
    expect(main).toContain("a");
    expect(main).not.toContain("language");
    expect(translation).toContain("hello");
  });

  it("returns the whole body when there is no marker", () => {
    expect(splitTranslation("[0,1]<0,1,0>x")).toEqual({ main: "[0,1]<0,1,0>x", translation: "" });
  });
});

describe("toLyricLines", () => {
  it("folds a translation that starts at the same time into its line", () => {
    const main = parseKrcLines("[1000,1000]<0,1000,0>你好");
    const translation = parseLrcLines("[00:01.00]hello");
    const lines = toLyricLines(main, translation);
    expect(lines[0]!.translation).toBe("hello");
    expect(lines[0]!.romanization).toBeNull();
  });
});

describe("emptyLyrics", () => {
  it("is the shape every caller can branch on without a null check", () => {
    expect(emptyLyrics("kugou:x", "no lyrics")).toEqual({
      trackId: "kugou:x",
      format: "none",
      lines: [],
      credits: [],
      unavailableReason: "no lyrics",
    });
  });
});

describe("parseQrcLines", () => {
  it("reads word spans whose times are absolute milliseconds", () => {
    const lines = parseQrcLines("[1200,3000]Hello(1200,600) world(1800,1200)");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("Hello world");
    expect(lines[0]!.words).toEqual([
      { text: "Hello", atMs: 1_200, durationMs: 600 },
      { text: " world", atMs: 1_800, durationMs: 1_200 },
    ]);
  });

  it("drops a line with no words at all", () => {
    expect(parseQrcLines("[500,1000](500,1000)")).toHaveLength(0);
  });
});

describe("parseYrcLines", () => {
  it("reads word spans and turns a JSON credit row into a plain line", () => {
    const body = JSON.stringify({ t: 0, c: [{ tx: "词:" }, { tx: "someone" }] });
    const lines = parseYrcLines(`${body}\n[1000,2000](1000,500,0)word(1500,500,0)two`);
    expect(lines[0]!.atMs).toBe(0);
    expect(lines[0]!.durationMs).toBe(3_000);
    expect(lines[0]!.text).toBe("词:someone");
    expect(lines[1]!.text).toBe("wordtwo");
    expect(lines[1]!.words).toEqual([
      { text: "word", atMs: 1_000, durationMs: 500 },
      { text: "two", atMs: 1_500, durationMs: 500 },
    ]);
  });
});

describe("parseVttLines", () => {
  it("reads cue times and folds the cue's text lines", () => {
    const lines = parseVttLines("WEBVTT\n\n00:01.000 --> 00:03.500\nfirst\nsecond\n\n1\n00:05.000 --> 00:06.000\nlast");
    expect(lines.map((line) => line.text)).toEqual(["first\nsecond", "last"]);
    expect(lines[0]!.atMs).toBe(1_000);
    expect(lines[0]!.durationMs).toBe(2_500);
  });
});

describe("parsePlainLines", () => {
  it("lays untimed text out at five seconds a row", () => {
    const lines = parsePlainLines("a\n\nb");
    expect(lines.map((line) => line.atMs)).toEqual([0, 5_000]);
    expect(lines[1]!.durationMs).toBe(5_000);
  });
});

describe("decodeKrcLanguageBlock", () => {
  it("splits type 1 from type 0 rows and aligns them by lyric line", () => {
    const payload = { content: [{ type: 0, lyricContent: [["ni"], ["hao"]] }, { type: 1, lyricContent: [["你好"], ["世界"]] }] };
    const token = Buffer.from(JSON.stringify(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")).toString("base64");
    const decoded = decodeKrcLanguageBlock(token.replace(/\+/g, "-").replace(/\//g, "_"));
    expect(decoded.translations).toEqual([["你好"], ["世界"]]);
    expect(decoded.romanizations).toEqual([["ni"], ["hao"]]);
  });
});

describe("KRC translations ride on the parsed lines", () => {
  it("pairs a language block's rows with the lyric lines by index", () => {
    const payload = { content: [{ type: 1, lyricContent: [["hello"]] }] };
    const token = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const lines = parseKrcLines(`[1000,1000]<0,1000,0>你好\n[language:${token}]`);
    expect(lines[0]!.translation).toBe("hello");
    expect(lines[0]!.romanization).toBeNull();
  });
});
