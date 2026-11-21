// The lyric timeline the views read. A KRC line carries word timings, so the
// highlight moves through a line rather than jumping line to line; an LRC line
// has one span covering it, which the same code treats as a single word.
import type { LyricLine, MusicLyrics } from "../../../shared/music.ts";

/** Which line is current at `positionMs`, or -1 before the first one. */
export function lineIndexAt(lines: readonly LyricLine[], positionMs: number): number {
  if (!lines.length) return -1;
  // Lines are sorted, so a binary search beats a scan on a 300-line song.
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid]!.atMs <= positionMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** How far through the current line the playhead is, 0-1, for a progress wash. */
export function lineProgress(line: LyricLine | null | undefined, positionMs: number): number {
  if (!line || line.durationMs <= 0) return 0;
  return Math.min(Math.max((positionMs - line.atMs) / line.durationMs, 0), 1);
}

/** Which word inside the line is sounding, and how far into it, for word-by-word highlighting. */
export function wordProgress(line: LyricLine | null | undefined, positionMs: number): { index: number; progress: number } {
  if (!line || !line.words.length) return { index: -1, progress: 0 };
  let index = -1;
  for (let at = 0; at < line.words.length; at++) {
    if (line.words[at]!.atMs <= positionMs) index = at;
    else break;
  }
  if (index < 0) return { index: -1, progress: 0 };
  const word = line.words[index]!;
  const progress = word.durationMs > 0 ? Math.min(Math.max((positionMs - word.atMs) / word.durationMs, 0), 1) : 0;
  return { index, progress };
}

/** The lines around the current one, for a windowed lyric view that does not re-render 300 rows. */
export function lyricWindow(lines: readonly LyricLine[], index: number, before = 4, after = 8): Array<{ line: LyricLine; offset: number }> {
  if (index < 0) return lines.slice(0, after + 1).map((line, offset) => ({ line, offset }));
  const from = Math.max(0, index - before);
  const to = Math.min(lines.length - 1, index + after);
  const window: Array<{ line: LyricLine; offset: number }> = [];
  for (let at = from; at <= to; at++) window.push({ line: lines[at]!, offset: at - index });
  return window;
}

/** A lyric that has nothing to show, said once so the view does not repeat the reason. */
export function lyricsPlaceholder(lyrics: MusicLyrics | null): string | null {
  if (!lyrics) return null;
  if (lyrics.lines.length) return null;
  return lyrics.unavailableReason ?? "No lyrics for this track";
}

/** Whether a lyric file beside a local track is KRC (word timings) or LRC. */
export function lyricFormatOf(path: string): "krc" | "lrc" {
  return path.toLowerCase().endsWith(".krc") ? "krc" : "lrc";
}
