/**
 * herdr-core framed mode: `[channel u32 LE][kind u8][len u32 LE][payload]`.
 *
 * The layout is fixed by the core's wire format (herdr-core 0.1.21, commit
 * c84d6e76156a6c2aac1da20efbe800f10acfe897, `crates/herdr-core/src/wire.rs`),
 * not by this client: channel 0 carries JSON-RPC, every other channel is one
 * attach or event stream.
 */

export const FRAME_HEADER_BYTES = 9;

/** The core refuses and never emits a payload above this. */
export const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;

/** Credit an attach stream starts with before the viewer acknowledges bytes. */
export const INITIAL_STREAM_CREDIT = 256 * 1024;

/** Largest DATA chunk the core puts in one frame. */
export const MAX_STREAM_CHUNK = 16 * 1024;

export const FrameKind = {
  /** Channel 0: one JSON-RPC message. Other channels: stream bytes. */
  DATA: 0,
  /** u32 LE: bytes the receiver consumed. */
  CREDIT: 1,
  /** The channel is over; from the core, a JSON reason. */
  CLOSE: 2,
  /** u16 LE cols, u16 LE rows. */
  RESIZE: 3,
  /** Viewer to core: 1 gained focus, 0 lost it. */
  FOCUS: 4,
  /** Viewer to core: JSON display facts. */
  FACTS: 5,
  /** Viewer to core: terminal-generated reply bytes, not human activity. */
  AUTOMATIC_INPUT: 6,
} as const;

export type FrameKindValue = (typeof FrameKind)[keyof typeof FrameKind];

export interface Frame {
  readonly channel: number;
  readonly kind: number;
  readonly payload: Buffer;
}

export type FrameErrorCode = "oversized" | "bad_channel" | "bad_kind";

export class FrameError extends Error {
  readonly code: FrameErrorCode;

  constructor(code: FrameErrorCode, message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

function assertChannel(channel: number): void {
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffff_ffff) {
    throw new FrameError("bad_channel", `frame channel ${channel} is not a u32`);
  }
}

function assertKind(kind: number): void {
  if (!Number.isInteger(kind) || kind < 0 || kind > 0xff) {
    throw new FrameError("bad_kind", `frame kind ${kind} is not a u8`);
  }
}

export function encodeFrame(channel: number, kind: number, payload: Uint8Array): Buffer {
  assertChannel(channel);
  assertKind(kind);
  if (payload.byteLength > MAX_FRAME_PAYLOAD) {
    throw new FrameError("oversized", `frame payload of ${payload.byteLength} bytes exceeds ${MAX_FRAME_PAYLOAD}`);
  }
  const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  out.writeUInt32LE(channel, 0);
  out.writeUInt8(kind, 4);
  out.writeUInt32LE(payload.byteLength, 5);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

export function decodeFrameHeader(header: Uint8Array): { channel: number; kind: number; length: number } {
  if (header.byteLength < FRAME_HEADER_BYTES) {
    throw new FrameError("bad_channel", `frame header needs ${FRAME_HEADER_BYTES} bytes, got ${header.byteLength}`);
  }
  const view = Buffer.isBuffer(header) ? header : Buffer.from(header.buffer, header.byteOffset, header.byteLength);
  const channel = view.readUInt32LE(0);
  const kind = view.readUInt8(4);
  const length = view.readUInt32LE(5);
  if (length > MAX_FRAME_PAYLOAD) {
    throw new FrameError("oversized", `frame of ${length} bytes exceeds ${MAX_FRAME_PAYLOAD}`);
  }
  return { channel, kind, length };
}

/**
 * Turns arbitrary stream chunks into whole frames. A read never respects a
 * frame boundary, so a header or payload may arrive in pieces.
 */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  /** Bytes held back waiting for the rest of a frame. */
  get buffered(): number {
    return this.#buffer.byteLength;
  }

  push(chunk: Uint8Array): Frame[] {
    this.#buffer = this.#buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
    const frames: Frame[] = [];
    let offset = 0;
    while (this.#buffer.byteLength - offset >= FRAME_HEADER_BYTES) {
      const { channel, kind, length } = decodeFrameHeader(this.#buffer.subarray(offset, offset + FRAME_HEADER_BYTES));
      const total = FRAME_HEADER_BYTES + length;
      if (this.#buffer.byteLength - offset < total) break;
      frames.push({
        channel,
        kind,
        payload: this.#buffer.subarray(offset + FRAME_HEADER_BYTES, offset + total),
      });
      offset += total;
    }
    this.#buffer = offset === 0 ? this.#buffer : this.#buffer.subarray(offset);
    return frames;
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
  }
}

export function creditPayload(bytes: number): Buffer {
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > 0xffff_ffff) {
    throw new RangeError(`credit ${bytes} is not a u32`);
  }
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32LE(bytes, 0);
  return out;
}

export function readCredit(payload: Uint8Array): number | null {
  if (payload.byteLength !== 4) return null;
  const view = Buffer.isBuffer(payload) ? payload : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  return view.readUInt32LE(0);
}

export function resizePayload(cols: number, rows: number): Buffer {
  for (const [name, value] of [
    ["cols", cols],
    ["rows", rows],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new RangeError(`${name} ${value} is not a u16`);
    }
  }
  const out = Buffer.allocUnsafe(4);
  out.writeUInt16LE(cols, 0);
  out.writeUInt16LE(rows, 2);
  return out;
}

export function readResize(payload: Uint8Array): { cols: number; rows: number } | null {
  if (payload.byteLength !== 4) return null;
  const view = Buffer.isBuffer(payload) ? payload : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  return { cols: view.readUInt16LE(0), rows: view.readUInt16LE(2) };
}

export function focusPayload(focused: boolean): Buffer {
  return Buffer.from([focused ? 1 : 0]);
}

/** The JSON reason a core puts on CLOSE; empty from a viewer. */
export function encodeCloseReason(reason: unknown): Buffer {
  return reason === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(reason), "utf8");
}

export function decodeCloseReason(payload: Uint8Array): unknown {
  if (payload.byteLength === 0) return null;
  const text = Buffer.from(payload).toString("utf8").trim();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
