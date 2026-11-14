import { describe, expect, it } from "vitest";
import { ChunkReassembler, JsonlDecoder, MAX_FRAME_BYTES, MAX_PIECE_BYTES } from "../transport/jsonl.ts";

function frames(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const decoder = new JsonlDecoder((frame) => out.push(frame));
  decoder.push(text);
  return out;
}

function chunk(chunkId: string, index: number, count: number, data: string, byteLength: number): Record<string, unknown> {
  return { type: "rpc_chunk", chunkId, index, count, byteLength, data };
}

describe("JSONL framing", () => {
  it("reads one frame per line and holds a partial line", () => {
    const out: Array<Record<string, unknown>> = [];
    const decoder = new JsonlDecoder((frame) => out.push(frame));
    decoder.push('{"type":"a"}\n{"type":"b"');
    expect(out).toEqual([{ type: "a" }]);
    decoder.push('}\n');
    expect(out).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("skips blank lines, CRLF endings and lines that are not a JSON object", () => {
    expect(frames('\n\r\n{"type":"a"}\r\nnot json\n[1,2]\n"text"\n')).toEqual([{ type: "a" }]);
  });

  it("drops an oversized line whole and resynchronizes at the next newline", () => {
    const out: Array<Record<string, unknown>> = [];
    const decoder = new JsonlDecoder((frame) => out.push(frame));
    decoder.push(`${"x".repeat(MAX_FRAME_BYTES + 10)}`);
    decoder.push('\n{"type":"after"}\n');
    expect(out).toEqual([{ type: "after" }]);
  });
});

describe("omp chunk reassembly", () => {
  it("reassembles a frame split across pieces", () => {
    const reassembler = new ChunkReassembler();
    const payload = Buffer.from(JSON.stringify({ type: "turn_end", big: "x".repeat(200) }), "utf8");
    const first = payload.subarray(0, 100).toString("base64");
    const second = payload.subarray(100).toString("base64");
    expect(reassembler.accept(chunk("c1", 0, 2, first, payload.length))).toBeNull();
    const frame = reassembler.accept(chunk("c1", 1, 2, second, payload.length));
    expect(frame).toMatchObject({ type: "turn_end" });
  });

  it("refuses a sequence whose pieces do not add up to the declared length", () => {
    const reassembler = new ChunkReassembler();
    const payload = Buffer.from(JSON.stringify({ type: "x" }), "utf8");
    const first = payload.subarray(0, 4).toString("base64");
    const second = payload.subarray(4, 8).toString("base64");
    expect(reassembler.accept(chunk("c1", 0, 2, first, payload.length))).toBeNull();
    // Short by the rest of the frame: the declared length is never reached.
    expect(reassembler.accept(chunk("c1", 1, 2, second, payload.length))).toBeNull();
  });

  it("refuses a sequence that starts at a non-zero index or changes its own count", () => {
    const reassembler = new ChunkReassembler();
    expect(reassembler.accept(chunk("c1", 1, 2, "e30=", 2))).toBeNull();
    expect(reassembler.accept(chunk("c2", 0, 3, "e30=", 10))).toBeNull();
    expect(reassembler.accept(chunk("c2", 1, 4, "e30=", 10))).toBeNull();
  });

  it("refuses a piece larger than omp's own cap, and a count beyond the frame cap", () => {
    const reassembler = new ChunkReassembler();
    const oversized = Buffer.alloc(MAX_PIECE_BYTES + 1, 0x61).toString("base64");
    expect(reassembler.accept(chunk("c1", 0, 2, oversized, 1000))).toBeNull();
    expect(reassembler.accept(chunk("c2", 0, 999_999, "e30=", 10))).toBeNull();
  });

  it("refuses a gap in the indexes and a sequence that mixes with an ordinary frame", () => {
    const reassembler = new ChunkReassembler();
    expect(reassembler.accept(chunk("c1", 0, 3, "e30=", 9))).toBeNull();
    expect(reassembler.accept(chunk("c1", 2, 3, "e30=", 9))).toBeNull();
  });

  it("returns null rather than a spliced frame when the pieces are not valid JSON", () => {
    const reassembler = new ChunkReassembler();
    const payload = Buffer.from("not json at all", "utf8");
    const first = payload.subarray(0, 6).toString("base64");
    const second = payload.subarray(6).toString("base64");
    expect(reassembler.accept(chunk("c1", 0, 2, first, payload.length))).toBeNull();
    expect(reassembler.accept(chunk("c1", 1, 2, second, payload.length))).toBeNull();
  });

  it("delivers a chunked frame through the decoder as one frame", () => {
    const out: Array<Record<string, unknown>> = [];
    const decoder = new JsonlDecoder((frame) => out.push(frame));
    const payload = Buffer.from(JSON.stringify({ type: "agent_end", isTerminal: false }), "utf8");
    const half = Math.ceil(payload.length / 2);
    const pieces = [payload.subarray(0, half), payload.subarray(half)];
    pieces.forEach((piece, index) => {
      decoder.push(`${JSON.stringify(chunk("k1", index, 2, piece.toString("base64"), payload.length))}\n`);
    });
    expect(out).toEqual([{ type: "agent_end", isTerminal: false }]);
  });
});
