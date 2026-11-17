import { describe, expect, it } from "vitest";

import { FrameDecoder, FrameError, Opcode, acceptKey, encodeClose, encodeFrame, encodePong, encodeText, handshakeHeaders } from "./websocket.ts";

describe("websocket handshake", () => {
  it("computes the RFC 6455 accept value", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("refuses a request that is not a version 13 websocket upgrade", () => {
    const good = {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    };
    expect(handshakeHeaders(good)?.headers[0]).toBe("HTTP/1.1 101 Switching Protocols");
    expect(handshakeHeaders({ headers: { ...good.headers, "sec-websocket-version": "8" } })).toBeUndefined();
    expect(handshakeHeaders({ headers: { ...good.headers, upgrade: "h2c" } })).toBeUndefined();
    expect(handshakeHeaders({ headers: { ...good.headers, "sec-websocket-key": "" } })).toBeUndefined();
  });
});

describe("frame codec", () => {
  it("decodes a masked client text frame", () => {
    const frame = maskFrame(Opcode.text, Buffer.from("hello", "utf8"));
    const decoder = new FrameDecoder();
    const [decoded] = decoder.push(frame);
    expect(decoded?.opcode).toBe(Opcode.text);
    expect(Buffer.from(decoded?.payload ?? []).toString("utf8")).toBe("hello");
  });

  it("reassembles a frame split across two chunks", () => {
    const frame = maskFrame(Opcode.binary, Buffer.from([1, 2, 3, 4, 5]));
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toHaveLength(0);
    const [decoded] = decoder.push(frame.subarray(3));
    expect([...(decoded?.payload ?? [])]).toEqual([1, 2, 3, 4, 5]);
  });

  it("decodes two frames from one chunk", () => {
    const decoder = new FrameDecoder();
    const both = Buffer.concat([maskFrame(Opcode.text, Buffer.from("a")), maskFrame(Opcode.text, Buffer.from("b"))]);
    expect(decoder.push(both).map((frame) => Buffer.from(frame.payload).toString("utf8"))).toEqual(["a", "b"]);
  });

  it("refuses an unmasked client frame and an oversized one", () => {
    const unmasked = encodeFrame(Opcode.text, Buffer.from("x"));
    expect(() => new FrameDecoder().push(unmasked)).toThrow(FrameError);

    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(2 * 1024 * 1024), 2);
    expect(() => new FrameDecoder().push(header)).toThrow(/size limit/u);
  });

  it("encodes server frames unmasked with the right length forms", () => {
    const small = encodeText("hi");
    expect(small[0]).toBe(0x81);
    expect(small[1]).toBe(2);

    const medium = encodeText("x".repeat(300));
    expect(medium[1]).toBe(126);
    expect(medium.readUInt16BE(2)).toBe(300);

    const large = encodeText("x".repeat(70_000));
    expect(large[1]).toBe(127);
    expect(Number(large.readBigUInt64BE(2))).toBe(70_000);
  });

  it("encodes a close with its code and a pong that echoes the payload", () => {
    const close = encodeClose(1009, "too big");
    expect(close[0]).toBe(0x88);
    expect(close.readUInt16BE(2)).toBe(1009);

    const pong = encodePong(Buffer.from("ping"));
    expect(pong[0]).toBe(0x8a);
    expect(Buffer.from(pong.subarray(2)).toString("utf8")).toBe("ping");
  });
});

function maskFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  const header = Buffer.allocUnsafe(2);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | payload.byteLength;
  const masked = Buffer.allocUnsafe(payload.byteLength);
  for (let index = 0; index < payload.byteLength; index += 1) {
    masked[index] = (payload[index] as number) ^ (mask[index % 4] as number);
  }
  return Buffer.concat([header, mask, masked]);
}
