import { describe, expect, it } from "vitest";

import {
  FRAME_HEADER_BYTES,
  FrameDecoder,
  FrameError,
  FrameKind,
  MAX_FRAME_PAYLOAD,
  creditPayload,
  decodeCloseReason,
  decodeFrameHeader,
  encodeCloseReason,
  encodeFrame,
  focusPayload,
  readCredit,
  readResize,
  resizePayload,
} from "./wire.ts";

describe("frame codec", () => {
  it("lays out channel, kind and length little-endian, as the core does", () => {
    const frame = encodeFrame(0x0102_0304, FrameKind.RESIZE, Buffer.from([1, 2, 3, 4]));
    expect(frame.byteLength).toBe(FRAME_HEADER_BYTES + 4);
    expect([...frame.subarray(0, 4)]).toEqual([0x04, 0x03, 0x02, 0x01]);
    expect(frame[4]).toBe(FrameKind.RESIZE);
    expect([...frame.subarray(5, 9)]).toEqual([4, 0, 0, 0]);
    expect([...frame.subarray(9)]).toEqual([1, 2, 3, 4]);
  });

  it("round-trips every kind the client sends", () => {
    for (const kind of [
      FrameKind.DATA,
      FrameKind.CREDIT,
      FrameKind.CLOSE,
      FrameKind.RESIZE,
      FrameKind.FOCUS,
      FrameKind.FACTS,
      FrameKind.AUTOMATIC_INPUT,
    ]) {
      const frame = encodeFrame(7, kind, Buffer.from("payload"));
      expect(decodeFrameHeader(frame.subarray(0, FRAME_HEADER_BYTES))).toEqual({ channel: 7, kind, length: 7 });
    }
  });

  it("keeps an empty payload at exactly the header size", () => {
    const frame = encodeFrame(0, FrameKind.CLOSE, Buffer.alloc(0));
    expect(frame.byteLength).toBe(FRAME_HEADER_BYTES);
    expect(decodeFrameHeader(frame)).toEqual({ channel: 0, kind: FrameKind.CLOSE, length: 0 });
  });

  it("accepts a payload of exactly 16 MiB and refuses one byte more", () => {
    const atLimit = Buffer.alloc(MAX_FRAME_PAYLOAD);
    const frame = encodeFrame(1, FrameKind.DATA, atLimit);
    expect(decodeFrameHeader(frame.subarray(0, FRAME_HEADER_BYTES)).length).toBe(MAX_FRAME_PAYLOAD);

    expect(() => encodeFrame(1, FrameKind.DATA, Buffer.alloc(MAX_FRAME_PAYLOAD + 1))).toThrow(FrameError);
  });

  it("refuses a header that announces more than 16 MiB without allocating it", () => {
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt32LE(1, 0);
    header.writeUInt8(FrameKind.DATA, 4);
    header.writeUInt32LE(MAX_FRAME_PAYLOAD + 1, 5);
    expect(() => decodeFrameHeader(header)).toThrow(/exceeds/);
    try {
      decodeFrameHeader(header);
    } catch (error) {
      expect((error as FrameError).code).toBe("oversized");
    }
  });

  it("refuses a channel or kind outside its width", () => {
    expect(() => encodeFrame(-1, FrameKind.DATA, Buffer.alloc(0))).toThrow(/u32/);
    expect(() => encodeFrame(0x1_0000_0000, FrameKind.DATA, Buffer.alloc(0))).toThrow(/u32/);
    expect(() => encodeFrame(1, 256, Buffer.alloc(0))).toThrow(/u8/);
  });

  it("reassembles a frame split across arbitrary chunks", () => {
    const frame = encodeFrame(9, FrameKind.DATA, Buffer.from("hello world"));
    const decoder = new FrameDecoder();
    const collected = [];
    for (const byte of frame) collected.push(...decoder.push(Buffer.from([byte])));
    expect(collected).toHaveLength(1);
    expect(collected[0]!.channel).toBe(9);
    expect(Buffer.from(collected[0]!.payload).toString()).toBe("hello world");
    expect(decoder.buffered).toBe(0);
  });

  it("reassembles frames that share a chunk and a header split mid-way", () => {
    const one = encodeFrame(1, FrameKind.DATA, Buffer.from("abc"));
    const two = encodeFrame(2, FrameKind.CLOSE, Buffer.alloc(0));
    const three = encodeFrame(3, FrameKind.RESIZE, resizePayload(80, 24));
    const all = Buffer.concat([one, two, three]);
    const decoder = new FrameDecoder();
    expect(decoder.push(all.subarray(0, 5))).toHaveLength(0);
    const frames = decoder.push(all.subarray(5));
    expect(frames.map((frame) => frame.channel)).toEqual([1, 2, 3]);
    expect(Buffer.from(frames[0]!.payload).toString()).toBe("abc");
    expect(frames[1]!.payload.byteLength).toBe(0);
    expect(readResize(frames[2]!.payload)).toEqual({ cols: 80, rows: 24 });
  });

  it("holds a partial payload until the rest arrives", () => {
    const frame = encodeFrame(4, FrameKind.DATA, Buffer.from("0123456789"));
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, FRAME_HEADER_BYTES + 4))).toHaveLength(0);
    expect(decoder.buffered).toBe(FRAME_HEADER_BYTES + 4);
    const rest = decoder.push(frame.subarray(FRAME_HEADER_BYTES + 4));
    expect(rest).toHaveLength(1);
    expect(Buffer.from(rest[0]!.payload).toString()).toBe("0123456789");
  });

  it("encodes CREDIT as a u32 and ignores the wrong width", () => {
    expect([...creditPayload(256 * 1024)]).toEqual([0, 0, 4, 0]);
    expect(readCredit(creditPayload(65_535))).toBe(65_535);
    expect(readCredit(Buffer.from([1, 2, 3]))).toBeNull();
    expect(() => creditPayload(-1)).toThrow(RangeError);
    expect(() => creditPayload(0x1_0000_0000)).toThrow(RangeError);
  });

  it("encodes RESIZE as two u16s and ignores the wrong width", () => {
    const payload = resizePayload(200, 120);
    expect([...payload]).toEqual([200, 0, 120, 0]);
    expect(readResize(payload)).toEqual({ cols: 200, rows: 120 });
    expect(readResize(Buffer.from([1, 0, 2]))).toBeNull();
    expect(() => resizePayload(65_536, 24)).toThrow(RangeError);
    expect(() => resizePayload(80, -1)).toThrow(RangeError);
  });

  it("sends FOCUS as one byte", () => {
    expect([...focusPayload(true)]).toEqual([1]);
    expect([...focusPayload(false)]).toEqual([0]);
  });

  it("reads the JSON reason on CLOSE and tolerates an empty or broken one", () => {
    expect(decodeCloseReason(encodeCloseReason({ reason: "exited", exit_code: 0, signal: null }))).toEqual({
      reason: "exited",
      exit_code: 0,
      signal: null,
    });
    expect(decodeCloseReason(Buffer.alloc(0))).toBeNull();
    expect(decodeCloseReason(Buffer.from("not json"))).toBeNull();
    expect(decodeCloseReason(Buffer.from("  "))).toBeNull();
  });
});
