import type { ReadableLike } from "./types.ts";

/** omp's advertised cap on one reassembled frame; protocol v2's chunked frames must fit it. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** omp's cap on one decoded chunk piece, which also bounds the piece count. */
export const MAX_PIECE_BYTES = 256 * 1024;
export const MAX_CHUNK_COUNT = MAX_FRAME_BYTES / MAX_PIECE_BYTES;
/** Protocol v1 has no chunking: a line over 1 MiB is not a frame any engine sends. */
export const MAX_LINE_BYTES = MAX_FRAME_BYTES;

export type Frame = Record<string, unknown>;

function isRecord(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reassembles omp's `rpc_chunk` frames. Any inconsistency drops the sequence rather than
 * producing a spliced frame: a partial frame is never delivered as if it were whole. */
export class ChunkReassembler {
  private chunkId: string | null = null;
  private count = 0;
  private byteLength = 0;
  private parts: Buffer[] = [];
  private bytes = 0;

  accept(frame: Frame): Frame | null {
    const { chunkId, index, count, byteLength, data } = frame;
    if (
      typeof chunkId !== "string" || chunkId.length === 0 ||
      typeof data !== "string" || data.length === 0 ||
      data.length > Math.ceil(MAX_PIECE_BYTES / 3) * 4 ||
      !Number.isInteger(index) || !Number.isInteger(count) || !Number.isInteger(byteLength) ||
      (index as number) < 0 || (count as number) < 2 || (count as number) > MAX_CHUNK_COUNT ||
      (index as number) >= (count as number) ||
      (byteLength as number) <= 0 || (byteLength as number) > MAX_FRAME_BYTES
    ) {
      this.reset();
      return null;
    }
    if (chunkId !== this.chunkId) {
      if (index !== 0) {
        this.reset();
        return null;
      }
      this.chunkId = chunkId;
      this.count = count as number;
      this.byteLength = byteLength as number;
      this.parts = [];
      this.bytes = 0;
    } else if (count !== this.count || byteLength !== this.byteLength) {
      this.reset();
      return null;
    }
    const part = Buffer.from(data, "base64");
    if (
      index !== this.parts.length || part.length === 0 || part.length > MAX_PIECE_BYTES ||
      this.bytes + part.length > this.byteLength
    ) {
      this.reset();
      return null;
    }
    this.parts.push(part);
    this.bytes += part.length;
    if (this.parts.length < this.count) return null;
    const complete = this.bytes === this.byteLength;
    const text = Buffer.concat(this.parts).toString("utf8");
    this.reset();
    if (!complete) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  reset(): void {
    this.chunkId = null;
    this.count = 0;
    this.byteLength = 0;
    this.parts = [];
    this.bytes = 0;
  }
}

/** Turns newline-delimited JSON into frames, reassembling chunked ones. An oversized or
 * malformed line is dropped whole: the stream resynchronizes at the next newline. */
export class JsonlDecoder {
  private buffer = "";
  private dropping = false;
  readonly chunks = new ChunkReassembler();
  private readonly onFrame: (frame: Frame) => void;

  constructor(onFrame: (frame: Frame) => void) {
    this.onFrame = onFrame;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (this.dropping) this.dropping = false;
      else this.line(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = "";
      this.dropping = true;
      this.chunks.reset();
    }
  }

  private line(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const frame = parsed.type === "rpc_chunk" ? this.chunks.accept(parsed) : parsed;
    if (frame) this.onFrame(frame);
  }
}

/** Attaches a decoder to a child's stdout. Returns a detach function. */
export function readJsonl(stream: ReadableLike | null, onFrame: (frame: Frame) => void): () => void {
  if (!stream) return () => {};
  const decoder = new JsonlDecoder(onFrame);
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk) => decoder.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
  return () => {};
}
