import { createHash } from "node:crypto";

/** The subset of RFC 6455 this server needs: the handshake and whole messages
 * in both directions. A browser's WebSocket sends masked client frames; this
 * server sends unmasked ones. No extension is negotiated.
 *
 * Hand-rolled because the alternative is a dependency for one endpoint whose
 * payloads are keystrokes and terminal bytes. */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_MESSAGE_BYTES = 1 << 20;

export const Opcode = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export interface WebSocketAccept {
  readonly headers: readonly string[];
}

export function acceptKey(clientKey: string): string {
  return createHash("sha1").update(`${clientKey}${GUID}`, "utf8").digest("base64");
}

/** Returns the 101 response lines, or undefined when the request is not a
 * conforming WebSocket upgrade. */
export function handshakeHeaders(req: { headers: Record<string, string | string[] | undefined> }): WebSocketAccept | undefined {
  const upgrade = header(req, "upgrade");
  const connection = header(req, "connection");
  const key = header(req, "sec-websocket-key");
  const version = header(req, "sec-websocket-version");
  if (upgrade?.toLowerCase() !== "websocket") return undefined;
  if (connection === undefined || !/(^|,)\s*upgrade\s*(,|$)/iu.test(connection)) return undefined;
  if (key === undefined || key.length === 0) return undefined;
  if (version !== "13") return undefined;
  return {
    headers: [
      "HTTP/1.1 101 Switching Protocols",
      "upgrade: websocket",
      "connection: Upgrade",
      `sec-websocket-accept: ${acceptKey(key)}`,
    ],
  };
}

export interface Frame {
  readonly opcode: number;
  readonly payload: Uint8Array;
}

export class FrameError extends Error {
  readonly code: "too_large" | "unmasked" | "malformed";

  constructor(code: FrameError["code"], message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

/** Decodes client frames. A browser masks every frame it sends, so an unmasked
 * one is not a browser and is refused rather than trusted. */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Frame[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const frames: Frame[] = [];
    for (;;) {
      const frame = this.#next();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  #next(): Frame | undefined {
    if (this.#buffer.length < 2) return undefined;
    const first = this.#buffer[0] as number;
    const second = this.#buffer[1] as number;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (this.#buffer.length < 4) return undefined;
      length = this.#buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.#buffer.length < 10) return undefined;
      const big = this.#buffer.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) throw new FrameError("too_large", "a frame exceeds the size limit");
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_MESSAGE_BYTES) throw new FrameError("too_large", "a frame exceeds the size limit");
    if (!masked) throw new FrameError("unmasked", "a client frame must be masked");
    if (this.#buffer.length < offset + 4 + length) return undefined;

    const mask = this.#buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = (this.#buffer[offset + index] as number) ^ (mask[index % 4] as number);
    }
    this.#buffer = this.#buffer.subarray(offset + length);
    return { opcode, payload };
  }
}

export function encodeFrame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.byteLength;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65_536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, Buffer.from(payload)]);
}

export function encodeText(text: string): Buffer {
  return encodeFrame(Opcode.text, Buffer.from(text, "utf8"));
}

export function encodeBinary(payload: Uint8Array): Buffer {
  return encodeFrame(Opcode.binary, payload);
}

export function encodeClose(code = 1000, reason = ""): Buffer {
  const body = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2, "utf8");
  return encodeFrame(Opcode.close, body);
}

export function encodePong(payload: Uint8Array): Buffer {
  return encodeFrame(Opcode.pong, payload);
}

function header(req: { headers: Record<string, string | string[] | undefined> }, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
