// Lyrics: the KRC decode, the word-by-word timeline, and the LRC / QRC / YRC /
// VTT / plain-text parsers the local library and embedded tags can produce.
// KRC is Kugou's own format: base64, four leading bytes, an XOR against a fixed
// mask, then zlib. The mask is a published constant of the format.
import { inflateSync } from "node:zlib";

import type { LyricLine, LyricWord, MusicLyricFormat, MusicLyrics } from "../../../shared/music.ts";
import type { KugouTransport } from "./transport.ts";
import { KugouError } from "./transport.ts";

/** The 16-byte mask every KRC payload is XORed with, after its four-byte header. */
const KRC_MASK = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105] as const;

/**
 * Decodes a KRC payload into its text. A payload that is not KRC (an LRC served
 * under the krc name) is returned as-is by the caller's format check.
 */
export function decodeKrc(payload: string): string {
  const base64 = payload.trim().replace(/^data:.*?;base64,/, "");
  if (!base64) throw new KugouError("not_found", "the lyric payload was empty", false);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    throw new KugouError("not_found", "the lyric payload is not base64", false);
  }
  if (bytes.length <= 4) throw new KugouError("not_found", "the lyric payload is too short", false);
  const body = Buffer.from(bytes.subarray(4));
  for (let index = 0; index < body.length; index++) body[index] = body[index]! ^ KRC_MASK[index % KRC_MASK.length]!;
  try {
    return inflateSync(body).toString("utf8");
  } catch {
    throw new KugouError("not_found", "the lyric payload did not decompress", false);
  }
}

/** `[mm:ss.xxx]` or `[mm:ss:xxx]`; LRC fractions scale by their width, as upstream's parser does. */
function parseTimestamp(raw: string): number | null {
  const match = raw.trim().match(/^(\d{1,3}):(\d{2})(?:[.:](\d{1,4}))?$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const digits = match[3] ?? "";
  let fraction = 0;
  if (digits.length === 1) fraction = Number(digits) * 100;
  else if (digits.length === 2) fraction = Number(digits) * 10;
  else if (digits.length === 3) fraction = Number(digits);
  else fraction = Math.round(Number(digits) / 10);
  return minutes * 60_000 + seconds * 1_000 + fraction;
}

export interface RawLine {
  atMs: number;
  durationMs: number;
  words: LyricWord[];
  text: string;
  /** The line's translation, when the source carried one beside the text. */
  translation?: string | null;
  /** The line's phonetic reading, when the source carried one. */
  romanization?: string | null;
}

/** Decodes a KRC `[language:...]` payload: base64url JSON whose rows are line-indexed strings. */
export function decodeKrcLanguageBlock(token: string): { translations: string[][]; romanizations: string[][] } {
  const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let parsed: { content?: Array<{ type?: number; lyricContent?: string[][] }> };
  try {
    parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return { translations: [], romanizations: [] };
  }
  const translations: string[][] = [];
  const romanizations: string[][] = [];
  for (const entry of parsed.content ?? []) {
    const rows = Array.isArray(entry.lyricContent) ? entry.lyricContent : [];
    if (entry.type === 1) translations.push(...rows);
    else romanizations.push(...rows);
  }
  return { translations, romanizations };
}

/** Splits a KRC body at its `[language:...]` marker and decodes what follows it. */
export function splitTranslation(body: string): { main: string; translation: string } {
  const marker = body.search(/\[language:[^\]]*\]/i);
  if (marker < 0) return { main: body, translation: "" };
  return { main: body.slice(0, marker), translation: body.slice(marker) };
}

/**
 * Parses a KRC body: one `[start,duration]` header per line, then the line's
 * words as `<offset,duration,0>text`. A `[language:...]` block carries the
 * translation and romanization rows, aligned by lyric-line index.
 */
export function parseKrcLines(body: string): RawLine[] {
  const { translations, romanizations } = splitTranslation(body).translation
    ? decodeKrcLanguageBlock(body.slice(body.search(/\[language:[^\]]*\]/i) + "[language:".length).replace(/\].*$/s, ""))
    : { translations: [], romanizations: [] };
  const lines: RawLine[] = [];
  let lineIndex = 0;
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^\[language:/i.test(trimmed)) continue;
    if (/^\[(ti|ar|al|by|offset|length):/i.test(trimmed)) continue;
    const header = trimmed.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!header) continue;
    const atMs = Number(header[1]);
    const durationMs = Number(header[2]);
    const rest = header[3] ?? "";
    const words: LyricWord[] = [];
    let text = "";
    // Each word: <offset,duration,0>its text. Offsets are relative to the line.
    const wordPattern = /<(\d+),(\d+),\d+>([^<]+)/g;
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = wordPattern.exec(rest)) !== null) {
      const gap = rest.slice(consumed, match.index);
      if (gap) text += gap;
      const wordText = match[3] ?? "";
      text += wordText;
      words.push({ text: wordText, atMs: atMs + Number(match[1]), durationMs: Number(match[2]) });
      consumed = match.index + match[0].length;
    }
    const tail = rest.slice(consumed);
    if (tail) text += tail;
    // A line with no word spans is still a line; give it one span covering it.
    if (!words.length && text.trim()) words.push({ text, atMs, durationMs: durationMs || 1_000 });
    const row = translations[lineIndex];
    const phonetic = romanizations[lineIndex];
    lines.push({
      atMs,
      durationMs: durationMs || (words.at(-1) ? words.at(-1)!.atMs + words.at(-1)!.durationMs - atMs : 0),
      words,
      text,
      translation: row?.[0]?.trim() || null,
      romanization: phonetic?.join("")?.trim() || null,
    });
    lineIndex += 1;
  }
  return lines.sort((a, b) => a.atMs - b.atMs);
}

/** Parses enhanced-LRC word tags: relative `<offset,duration[,0]>` first, then absolute `<mm:ss.xx>`. */
function parseEnhancedWords(text: string, lineAtMs: number, lineDurationMs: number): { words: LyricWord[]; plain: string } {
  const words: LyricWord[] = [];
  let plain = "";
  const pattern = /<(?:(\d+),(\d+)(?:,\d+)*|(\d{1,3}):(\d{2})(?:[.:](\d{1,4}))?)>/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  let spanEnd = lineAtMs + lineDurationMs;
  while ((match = pattern.exec(text)) !== null) {
    const gap = text.slice(consumed, match.index);
    if (match[1] !== undefined) {
      const wordStart = lineAtMs + Number(match[1]);
      const wordSpan = Number(match[2]);
      words.push({ text: gap, atMs: wordStart, durationMs: wordSpan });
      spanEnd = Math.max(spanEnd, wordStart + wordSpan);
    } else {
      const at = parseTimestamp(`${match[3]}:${match[4]}${match[5] ? `.${match[5]}` : ""}`) ?? lineAtMs;
      words.push({ text: gap, atMs: at, durationMs: 0 });
      spanEnd = Math.max(spanEnd, at);
    }
    plain += gap;
    consumed = match.index + match[0].length;
  }
  plain += text.slice(consumed);
  if (words.length && plain.trim()) {
    // A word with no width takes the run to the next word, at least 80 ms, like upstream's completion pass.
    for (let index = 0; index < words.length; index++) {
      const word = words[index]!;
      const next = words[index + 1];
      const end = next ? next.atMs : spanEnd;
      if (word.durationMs <= 0) word.durationMs = Math.max(end - word.atMs, 80);
    }
  }
  return { words: words.filter((word) => word.text.length > 0), plain };
}

/** Parses a plain LRC body: `[mm:ss.xx]text`, with repeated stamps and repeated timestamps for translations. */
export function parseLrcLines(body: string): RawLine[] {
  const collected: Array<{ atMs: number; text: string; order: number }> = [];
  let order = 0;
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^\[(ti|ar|al|by|offset|length):\s*(.*)\]$/i.test(trimmed)) continue;
    const stamps = [...trimmed.matchAll(/\[([^\]]+)\]/g)]
      .map((match) => parseTimestamp(match[1]!))
      .filter((value): value is number => value !== null);
    if (!stamps.length) continue;
    const text = trimmed.replace(/\[[^\]]+\]/g, "").trim();
    for (const atMs of stamps) collected.push({ atMs, text, order: order++ });
  }
  collected.sort((a, b) => a.atMs - b.atMs || a.order - b.order);

  // A second entry at a time that already has a line is its translation, the
  // convention duplicated-stamp LRC files use; anything else is its own line.
  const lines: RawLine[] = [];
  const byTime = new Map<number, RawLine>();
  const enhanced = new Map<RawLine, string>();
  for (const entry of collected) {
    const existing = byTime.get(entry.atMs);
    if (existing && !existing.translation && entry.text && entry.text !== existing.text) {
      existing.translation = entry.text;
      continue;
    }
    const line: RawLine = { atMs: entry.atMs, durationMs: 0, words: [], text: entry.text, translation: null, romanization: null };
    lines.push(line);
    if (!byTime.has(entry.atMs)) byTime.set(entry.atMs, line);
    if (/<(?:\d+,\d+|\d{1,3}:\d{2})/.test(entry.text)) enhanced.set(line, entry.text);
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const next = lines[index + 1];
    line.durationMs = next ? Math.max(next.atMs - line.atMs, 1) : 5_000;
    const tagged = enhanced.get(line);
    if (tagged) {
      const parsed = parseEnhancedWords(tagged, line.atMs, line.durationMs);
      line.words = parsed.words.length ? parsed.words : [{ text: line.text, atMs: line.atMs, durationMs: line.durationMs }];
      line.text = parsed.plain.trim();
    } else {
      line.words = line.text ? [{ text: line.text, atMs: line.atMs, durationMs: line.durationMs }] : [];
    }
  }
  return lines;
}

/** A QRC body: `[start,duration]` headers, word spans as `text(start,duration)` in absolute milliseconds. */
export function parseQrcLines(body: string): RawLine[] {
  const lines: RawLine[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const header = trimmed.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!header) continue;
    const atMs = Number(header[1]);
    const durationMs = Number(header[2]);
    const rest = header[3] ?? "";
    const words: LyricWord[] = [];
    let text = "";
    const wordPattern = /(.*?)\((\d+),(\d+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = wordPattern.exec(rest)) !== null) {
      const wordText = match[1] ?? "";
      text += wordText;
      words.push({ text: wordText, atMs: Number(match[2]), durationMs: Number(match[3]) });
    }
    if (!text.trim()) continue;
    lines.push({
      atMs,
      durationMs,
      words: words.length ? words : [{ text, atMs, durationMs: durationMs || 1_000 }],
      text,
      translation: null,
      romanization: null,
    });
  }
  return lines.sort((a, b) => a.atMs - b.atMs);
}

/** A YRC body: `[start,duration]` headers, word spans as `(start,duration,0)text`; `{…}` rows are credits. */
export function parseYrcLines(body: string): RawLine[] {
  const lines: RawLine[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{")) {
      // A producer/copyright row: JSON with a time and a list of text chunks, shown as a plain line.
      try {
        const parsed = JSON.parse(trimmed) as { t?: number; c?: Array<{ tx?: string }> };
        const text = (parsed.c ?? []).map((chunk) => chunk.tx ?? "").join("");
        const atMs = Number(parsed.t);
        if (text.trim() && Number.isFinite(atMs)) {
          lines.push({ atMs, durationMs: 3_000, words: [{ text, atMs, durationMs: 3_000 }], text, translation: null, romanization: null });
        }
      } catch { /* a malformed credit row is not a lyric; skip it */ }
      continue;
    }
    const header = trimmed.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!header) continue;
    const atMs = Number(header[1]);
    const durationMs = Number(header[2]);
    const rest = header[3] ?? "";
    const words: LyricWord[] = [];
    let text = "";
    const wordPattern = /\((\d+),(\d+),\d+\)([^()]+)/g;
    let match: RegExpExecArray | null;
    while ((match = wordPattern.exec(rest)) !== null) {
      const wordText = match[3] ?? "";
      text += wordText;
      words.push({ text: wordText, atMs: Number(match[1]), durationMs: Number(match[2]) });
    }
    if (!text.trim()) continue;
    lines.push({
      atMs,
      durationMs,
      words: words.length ? words : [{ text, atMs, durationMs: durationMs || 1_000 }],
      text,
      translation: null,
      romanization: null,
    });
  }
  return lines.sort((a, b) => a.atMs - b.atMs);
}

const VTT_STAMP = /(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})/g;

function vttMs(raw: string): number {
  VTT_STAMP.lastIndex = 0;
  const match = VTT_STAMP.exec(raw);
  if (!match) return 0;
  const hours = match[1] ? Number(match[1]) : 0;
  return ((hours * 60 + Number(match[2])) * 60 + Number(match[3])) * 1_000 + Number(match[4]);
}

/** A WebVTT body: cue time rows, the cue's text on the following line(s). */
export function parseVttLines(body: string): RawLine[] {
  const lines: RawLine[] = [];
  const rows = body.split(/\r?\n/);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!.trim();
    const times = row.match(/([0-9:]+\.\d{3})\s*-->\s*([0-9:]+\.\d{3})/);
    if (!times) continue;
    const atMs = vttMs(times[1]!);
    const endMs = vttMs(times[2]!);
    const text: string[] = [];
    for (index += 1; index < rows.length; index++) {
      const line = rows[index]!.trim();
      if (!line) break;
      if (/-->/.test(rows[index + 1] ?? "")) break;
      text.push(line);
    }
    const joined = text.join("\n").trim();
    if (!joined || /^WEBVTT/i.test(joined) || /^NOTE\b/i.test(joined) || /^\d+$/.test(joined)) continue;
    lines.push({
      atMs,
      durationMs: Math.max(endMs - atMs, 1),
      words: [{ text: joined, atMs, durationMs: Math.max(endMs - atMs, 1) }],
      text: joined,
      translation: null,
      romanization: null,
    });
  }
  return lines.sort((a, b) => a.atMs - b.atMs);
}

/** Untimed text: every non-empty line is a row, five seconds each, in file order. */
export function parsePlainLines(body: string): RawLine[] {
  const lines: RawLine[] = [];
  let index = 0;
  for (const raw of body.split(/\r?\n/)) {
    const text = raw.trim();
    if (!text) continue;
    const atMs = index * 5_000;
    lines.push({ atMs, durationMs: 5_000, words: [{ text, atMs, durationMs: 5_000 }], text, translation: null, romanization: null });
    index += 1;
  }
  return lines;
}

/** Decides which parser a payload needs: a KRC body starts with a `[start,duration]` header and carries `<…>`. */
export function looksLikeKrc(body: string): boolean {
  return /^\[\d+,\d+\]/.test(body.trim()) && body.includes("<");
}

/** A QRC body has `[start,duration]` headers and `text(start,duration)` spans with no `<`. */
export function looksLikeQrc(body: string): boolean {
  return /^\[\d+,\d+\]/.test(body.trim()) && !body.includes("<") && /\(\d+,\d+\)/.test(body);
}

/** A YRC body has `[start,duration]` headers and `(start,duration,0)text` spans. */
export function looksLikeYrc(body: string): boolean {
  return /^\[\d+,\d+\]/.test(body.trim()) && /\(\d+,\d+,\d+\)/.test(body);
}

/**
 * The parser registry: one entry point for a body plus the extension it arrived
 * under, so the online download and the local file share one dispatch.
 */
export function parseLyricsByExtension(body: string, extension: string): RawLine[] {
  const ext = extension.replace(/^\./, "").toLowerCase();
  if (ext === "krc" || (ext !== "lrc" && ext !== "qrc" && ext !== "yrc" && ext !== "vtt" && looksLikeKrc(body))) return parseKrcLines(body);
  if (ext === "qrc" || looksLikeQrc(body)) return parseQrcLines(body);
  if (ext === "yrc" || looksLikeYrc(body)) return parseYrcLines(body);
  if (ext === "vtt" || /^\s*WEBVTT/i.test(body)) return parseVttLines(body);
  if (ext === "lrc" || /\[\d{1,3}:\d{2}(?:[.:]\d{1,4})?\]/.test(body)) return parseLrcLines(body);
  return parsePlainLines(body);
}

/** Converts raw lines to the wire shape, folding an adjacent translation line into the line it translates. */
export function toLyricLines(raw: readonly RawLine[], translations: readonly RawLine[] = []): LyricLine[] {
  const byTime = new Map<number, string>();
  for (const line of translations) if (line.text.trim()) byTime.set(line.atMs, line.text.trim());
  return raw.map((line) => ({
    atMs: line.atMs,
    durationMs: line.durationMs,
    text: line.text,
    words: line.words,
    translation: line.translation ?? byTime.get(line.atMs) ?? null,
    romanization: line.romanization ?? null,
  }));
}

/** The empty lyric a source returns when it has none, so callers never branch on null. */
export function emptyLyrics(trackId: string, reason: string | null = null): MusicLyrics {
  return { trackId, format: "none", lines: [], credits: [], unavailableReason: reason };
}

export interface KugouLyricsOptions {
  transport: KugouTransport;
}

export interface KugouLyricCandidate {
  id: string;
  accesskey: string;
  /** `krc` or `lrc`, as the search result says. */
  format: string;
  /** Milliseconds; the download's own duration, used to pick the closest match. */
  durationMs: number;
  singer: string;
  song: string;
}

export interface KugouLyricsClient {
  /** Finds lyric candidates for a track hash; a hash plus duration picks the right version. */
  search(input: { hash?: string; keyword?: string; durationSeconds?: number; albumAudioId?: string }): Promise<KugouLyricCandidate[]>;
  /** Fetches and decodes one candidate. */
  fetch(candidate: KugouLyricCandidate, trackId: string): Promise<MusicLyrics>;
  /** Search then fetch the best match, or empty lyrics when nothing matched. */
  forTrack(input: { trackId: string; hash?: string; keyword?: string; durationSeconds?: number; albumAudioId?: string }): Promise<MusicLyrics>;
}

interface CandidateRow {
  id?: string | number;
  accesskey?: string;
  duration?: number;
  singer?: string;
  song?: string;
  fmt?: string;
  krc?: unknown;
  lrc?: unknown;
}

interface SearchPayload {
  candidates?: CandidateRow[];
  status?: number;
}

interface DownloadPayload {
  content?: string;
  fmt?: string;
  /** Non-zero means the content is plain base64 text, not an encrypted KRC payload. */
  contenttype?: number;
  /** A base64 translation payload the download hands over beside the main text. */
  trans?: string;
  status?: number;
}

function candidateFrom(row: CandidateRow): KugouLyricCandidate | null {
  const id = String(row.id ?? "");
  const accesskey = String(row.accesskey ?? "");
  if (!id || !accesskey) return null;
  return {
    id,
    accesskey,
    format: row.fmt ? String(row.fmt) : row.krc ? "krc" : row.lrc ? "lrc" : "krc",
    durationMs: Number(row.duration ?? 0),
    singer: String(row.singer ?? ""),
    song: String(row.song ?? ""),
  };
}

export function createKugouLyricsClient(options: KugouLyricsOptions): KugouLyricsClient {
  const { transport } = options;

  const search: KugouLyricsClient["search"] = async (input) => {
    const params: Record<string, string> = {
      album_audio_id: input.albumAudioId ?? "0",
      appid: "3116",
      clientver: "11440",
      // Upstream asks with a zero duration; the candidate list is not duration-filtered here.
      duration: "0",
      hash: input.hash ?? "",
      keyword: input.keyword ?? "",
      lrctxt: "1",
      man: "no",
    };
    let rows: CandidateRow[] = [];
    try {
      const payload = await transport.request<SearchPayload>({ url: "https://lyrics.kugou.com/v1/search", params });
      rows = payload?.candidates ?? [];
    } catch (error) {
      if (!(error instanceof KugouError) || error.code !== "risk_control") throw error;
      rows = [];
    }
    // The search endpoint refuses some addresses outright; the older one still answers.
    if (!rows.length) {
      const fallback = await transport.request<SearchPayload>({
        url: "https://lyrics.kugou.com/search",
        params: { ver: "1", man: "yes", client: "pc", duration: "0", hash: input.hash ?? "", keyword: input.keyword ?? "" },
      }).catch(() => null);
      rows = fallback?.candidates ?? [];
    }
    return rows.map(candidateFrom).filter((row): row is KugouLyricCandidate => row !== null);
  };

  const fetchOne: KugouLyricsClient["fetch"] = async (candidate, trackId) => {
    const payload = await transport.request<DownloadPayload>({
      url: "https://lyrics.kugou.com/download",
      params: { ver: "1", client: "android", id: candidate.id, accesskey: candidate.accesskey, fmt: candidate.format, charset: "utf8" },
    });
    const content = payload?.content;
    if (!content) return emptyLyrics(trackId, "Kugou has no lyric text for this track");
    const wantsKrc = candidate.format === "krc" && Number(payload?.contenttype ?? 0) === 0;
    let body: string;
    try {
      body = wantsKrc ? decodeKrc(content) : Buffer.from(content, "base64").toString("utf8");
    } catch {
      // Some tracks serve a plain LRC under the krc name; try it before giving up.
      body = Buffer.from(content, "base64").toString("utf8");
    }
    const isKrc = looksLikeKrc(body);
    const effective: MusicLyricFormat = isKrc ? "krc" : looksLikeQrc(body) ? "qrc" : looksLikeYrc(body) ? "yrc" : candidate.format === "krc" ? "lrc" : candidate.format === "vtt" ? "vtt" : "lrc";
    const raw = parseLyricsByExtension(body, isKrc ? "krc" : effective);
    if (!raw.length) return emptyLyrics(trackId, "the lyric text had no timed lines");
    const translationLines = payload?.trans ? parseLrcLines(Buffer.from(payload.trans, "base64").toString("utf8")) : [];
    return { trackId, format: effective, lines: toLyricLines(raw, translationLines), credits: [], unavailableReason: null };
  };

  return {
    search,
    fetch: fetchOne,
    async forTrack(input) {
      const candidates = await search({
        ...(input.hash ? { hash: input.hash } : {}),
        ...(input.keyword ? { keyword: input.keyword } : {}),
        ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
        ...(input.albumAudioId ? { albumAudioId: input.albumAudioId } : {}),
      }).catch(() => []);
      if (!candidates.length) return emptyLyrics(input.trackId, "Kugou has no lyrics for this track");
      // A KRC beats an LRC, and among equals the duration closest to the track wins.
      const wanted = (input.durationSeconds ?? 0) * 1_000;
      const ranked = [...candidates].sort((a, b) => {
        if (a.format !== b.format) return a.format === "krc" ? -1 : 1;
        if (!wanted) return 0;
        return Math.abs(a.durationMs - wanted) - Math.abs(b.durationMs - wanted);
      });
      return fetchOne(ranked[0]!, input.trackId);
    },
  };
}
