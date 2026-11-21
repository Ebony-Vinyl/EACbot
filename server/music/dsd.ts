// DSF and DFF are 1-bit DSD containers no browser can decode. This module reads
// the container and converts DSD to 16-bit PCM with a proper decimation filter,
// so a DSF track streams through the same path as any other file.
//
// The conversion is the standard one: each DSD byte holds eight 1-bit samples;
// a windowed-sinc low-pass removes the enormous ultrasonic noise a naive average
// would alias straight into the audible band, then the signal is decimated to
// 44.1 kHz. A simple box average is not used because it leaves audible aliasing.
import { readFileSync } from "node:fs";

import { stripPadding } from "./tags.ts";

/** What a container declared, before any conversion. */
export interface DsdInfo {
  format: "dsf" | "dff";
  /** DSD bit rate in Hz: 2 822 400 for DSD64, 5 644 800 for DSD128. */
  bitRate: number;
  channels: number;
  /** The DSD64/128/256 multiplier: 64, 128, 256. */
  dsdRate: number;
  /** Total sample frames per channel. */
  frames: number;
  /** True when the payload is DST-compressed, which this decoder does not expand. */
  compressed: boolean;
  /** Where the audio payload starts and how many bytes it is. */
  dataOffset: number;
  dataBytes: number;
  /**
   * How the payload interleaves. A DSF file stores each channel's data in its own
   * run of 4096-byte blocks (`blocked`); a DFF file interleaves one byte per
   * channel (`interleaved`). Reading one as the other swaps the channels' samples.
   */
  layout: "blocked" | "interleaved";
  /** The tag block, when the container carries one. */
  title: string | null;
  artist: string | null;
  album: string | null;
}

export class DsdError extends Error {
  readonly code: "unsupported_format" | "invalid_input";
  constructor(code: DsdError["code"], message: string) {
    super(message);
    this.name = "DsdError";
    this.code = code;
  }
}

function fourcc(buffer: Buffer, offset: number): string {
  return buffer.subarray(offset, offset + 4).toString("ascii");
}

function readUInt64LE(buffer: Buffer, offset: number): number {
  // Node has no 64-bit LE read; the high word of a sane file is small.
  const low = buffer.readUInt32LE(offset);
  const high = buffer.readUInt32LE(offset + 4);
  return high * 0x1_0000_0000 + low;
}

/** Reads a DSF header: `DSD ` container, `fmt ` block, then the `data` block. */
export function readDsfInfo(buffer: Buffer): DsdInfo {
  if (buffer.length < 28 || fourcc(buffer, 0) !== "DSD ") throw new DsdError("invalid_input", "not a DSF file");
  if (fourcc(buffer, 28) !== "fmt ") throw new DsdError("invalid_input", "the DSF file has no fmt block");
  // A chunk id and its 8-byte size sit before the payload, so the fields start at 40.
  const formatId = buffer.readUInt32LE(44);
  const channelType = buffer.readUInt32LE(48);
  const channels = buffer.readUInt32LE(52);
  const sampleRate = buffer.readUInt32LE(56);
  const bitsPerSample = buffer.readUInt32LE(60);
  const sampleCount = readUInt64LE(buffer, 64);
  if (formatId !== 0) throw new DsdError("unsupported_format", "this DSF file uses a format other than DSD");
  if (bitsPerSample !== 1) throw new DsdError("unsupported_format", `DSF with ${bitsPerSample}-bit samples is not DSD`);
  if (channels < 1 || channels > 6) throw new DsdError("unsupported_format", `a DSF file with ${channels} channels is not supported`);
  if (!sampleRate) throw new DsdError("invalid_input", "the DSF file declares no sample rate");
  void channelType;

  // The fmt chunk declares its own size, and the data chunk starts right after it.
  const fmtSize = readUInt64LE(buffer, 32);
  const dataStart = 28 + Number(fmtSize);
  if (dataStart + 12 > buffer.length) throw new DsdError("invalid_input", "the DSF file is truncated before its data block");
  if (fourcc(buffer, dataStart) !== "data") throw new DsdError("invalid_input", "the DSF file has no data block");
  const dataSize = readUInt64LE(buffer, dataStart + 4);
  const dataOffset = dataStart + 12;
  const available = Math.max(0, Math.min(dataSize, buffer.length - dataOffset));

  // A DSF sample rate is the DSD byte rate; the bit rate is eight times it.
  const bitRate = sampleRate * 8;
  return {
    format: "dsf",
    bitRate,
    channels,
    dsdRate: Math.round(bitRate / 44_100),
    // A DSF file's channel data is one 4096-byte block per channel, round-robin.
    layout: "blocked",
    frames: sampleCount,
    compressed: false,
    dataOffset,
    dataBytes: available,
    title: null,
    artist: null,
    album: null,
  };
}

/** Reads the ID3v2 tag a DSF file may carry after its header, for title/artist/album. */
export function readDsfTags(buffer: Buffer): { title: string | null; artist: string | null; album: string | null } {
  const at = buffer.indexOf(Buffer.from("ID3"));
  if (at < 0 || at + 10 > buffer.length) return { title: null, artist: null, album: null };
  const size = ((buffer[at + 6]! & 0x7f) << 21) | ((buffer[at + 7]! & 0x7f) << 14) | ((buffer[at + 8]! & 0x7f) << 7) | (buffer[at + 9]! & 0x7f);
  const body = buffer.subarray(at + 10, Math.min(at + 10 + size, buffer.length));
  const find = (frameId: string): string | null => {
    let cursor = 0;
    while (cursor + 10 <= body.length) {
      const id = body.subarray(cursor, cursor + 4).toString("ascii");
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const frameSize = body.readUInt32BE(cursor + 4);
      if (frameSize <= 0 || cursor + 10 + frameSize > body.length) break;
      if (id === frameId) {
        const payload = body.subarray(cursor + 10, cursor + 10 + frameSize);
        // A text frame starts with an encoding byte.
        const encoding = payload[0];
        const text = payload.subarray(1);
        if (encoding === 1 || encoding === 2) {
          try { return stripPadding(text.toString("utf16le")) || null; } catch { return null; }
        }
        return stripPadding(text.toString("utf8")) || null;
      }
      cursor += 10 + frameSize;
    }
    return null;
  };
  return { title: find("TIT2"), artist: find("TPE1"), album: find("TALB") };
}

/** Reads a DFF header: an `FRM8` container with `PROP`/`SND ` and a `DSD ` or `DST ` chunk. */
export function readDffInfo(buffer: Buffer): DsdInfo {
  if (buffer.length < 16 || fourcc(buffer, 0) !== "FRM8") throw new DsdError("invalid_input", "not a DFF file");
  const formType = fourcc(buffer, 12);
  if (formType !== "DSD ") throw new DsdError("unsupported_format", `this DFF file's form type "${formType}" is not DSD`);

  let cursor = 16;
  let bitRate = 2_822_400;
  let channels = 2;
  let compressed = false;
  let dataOffset = 0;
  let dataBytes = 0;

  while (cursor + 12 <= buffer.length) {
    const id = fourcc(buffer, cursor);
    const size = readUInt64BE(buffer, cursor + 4);
    const body = cursor + 12;
    if (id === "PROP") {
      let inner = body + 4;
      const end = Math.min(body + size, buffer.length);
      while (inner + 12 <= end) {
        const propId = fourcc(buffer, inner);
        const propSize = readUInt64BE(buffer, inner + 4);
        const propBody = inner + 12;
        if (propId === "FS  ") bitRate = buffer.readUInt32BE(propBody);
        if (propId === "CHNL") channels = buffer.readUInt16BE(propBody);
        if (propId === "CMPR") {
          const code = fourcc(buffer, propBody + 4);
          compressed = code === "DST ";
        }
        inner = propBody + propSize + (propSize % 2);
      }
    } else if (id === "DSD " || id === "DST ") {
      compressed = compressed || id === "DST ";
      dataOffset = body;
      dataBytes = Math.min(size, buffer.length - body);
      break;
    }
    cursor = body + size + (size % 2);
  }

  if (!dataOffset) throw new DsdError("invalid_input", "the DFF file has no DSD audio chunk");
  const frames = Math.floor(dataBytes / Math.max(channels, 1));
  return {
    format: "dff",
    bitRate,
    channels,
    dsdRate: Math.round(bitRate / 44_100),
    layout: "interleaved",
    frames,
    compressed,
    dataOffset,
    dataBytes,
    title: null,
    artist: null,
    album: null,
  };
}

function readUInt64BE(buffer: Buffer, offset: number): number {
  const high = buffer.readUInt32BE(offset);
  const low = buffer.readUInt32BE(offset + 4);
  return high * 0x1_0000_0000 + low;
}

/** Detects the container by its magic, so a caller does not have to trust an extension. */
export function readDsdInfo(buffer: Buffer): DsdInfo {
  if (buffer.length >= 4 && fourcc(buffer, 0) === "DSD ") {
    const info = readDsfInfo(buffer);
    return { ...info, ...readDsfTags(buffer) };
  }
  if (buffer.length >= 4 && fourcc(buffer, 0) === "FRM8") return readDffInfo(buffer);
  throw new DsdError("invalid_input", "not a DSF or DFF file");
}

/** The output rate every DSD file is converted to, so the client's audio graph is one graph. */
export const DSD_OUTPUT_RATE = 44_100;

/** A DSF file's channel data is stored in blocks of this size, one block per channel in turn. */
const DSF_BLOCK_BYTES = 4_096;
const DSF_BLOCK_BITS = DSF_BLOCK_BYTES * 8;

/**
 * A windowed-sinc low-pass, precomputed once per decimation ratio. `taps` grows
 * with the ratio so the transition band stays proportional to the source rate.
 */
function designLowPass(cutoffNormalised: number, taps: number): Float64Array {
  const kernel = new Float64Array(taps);
  const midpoint = (taps - 1) / 2;
  let sum = 0;
  for (let index = 0; index < taps; index++) {
    const n = index - midpoint;
    const sinc = n === 0 ? 2 * cutoffNormalised : Math.sin(2 * Math.PI * cutoffNormalised * n) / (Math.PI * n);
    // A Blackman window keeps the stop-band deep enough that 1-bit noise never folds back.
    const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * index) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * index) / (taps - 1));
    kernel[index] = sinc * window;
    sum += kernel[index]!;
  }
  for (let index = 0; index < taps; index++) kernel[index] = kernel[index]! / sum;
  return kernel;
}

/**
 * Converts interleaved 1-bit DSD bytes to interleaved 16-bit PCM at 44.1 kHz.
 * `bits` are read MSB first, as both DSF and DFF store them.
 *
 * A single FIR at DSD64's 64:1 ratio would need thousands of taps to keep the
 * ultrasonic 1-bit noise from folding back, so the decimation runs in two stages:
 * a boxcar CIC first (cheap, and it already kills most of the band), then a short
 * windowed-sinc FIR at the much lower intermediate rate.
 */
export function dsdToPcm16(input: Uint8Array, info: Pick<DsdInfo, "bitRate" | "channels" | "layout">, outputRate = DSD_OUTPUT_RATE): Int16Array {
  const decimation = Math.max(1, Math.round(info.bitRate / outputRate));
  const channels = Math.max(1, info.channels);
  const bitsPerChannel = Math.floor((input.length * 8) / channels);
  if (bitsPerChannel < decimation) return new Int16Array(0);

  // Stage one: a boxcar of `stageOne` bits per output, the classic CIC first stage.
  const stageOne = decimation >= 8 ? 8 : 1;
  const stageOneFrames = Math.floor(bitsPerChannel / stageOne);
  const stageOneRate = info.bitRate / stageOne;

  // Stage two: a short FIR at the intermediate rate. Its cutoff is relative to that
  // rate, so a few dozen taps give a transition band this stage can resolve.
  const stageTwo = Math.max(1, Math.round(stageOneRate / outputRate));
  const outputFrames = Math.floor(stageOneFrames / stageTwo);
  if (outputFrames <= 0) return new Int16Array(0);
  const taps = Math.max(31, Math.min(stageTwo * 4 + 1, 255));
  const kernel = designLowPass(0.45 / stageTwo, taps);
  const half = (taps - 1) / 2;

  const out = new Int16Array(outputFrames * channels);

  /** Reads one DSD bit at an absolute per-channel bit position; 1 = +1, 0 = -1. */
  const bitAt = (channel: number, position: number): number => {
    if (position < 0 || position >= bitsPerChannel) return 0;
    let byteOffset: number;
    let shift: number;
    if (info.layout === "blocked") {
      // DSF: each channel owns a run of 4096-byte blocks, one block per channel in turn.
      const blockIndex = Math.floor(position / DSF_BLOCK_BITS);
      const withinBlock = position % DSF_BLOCK_BITS;
      byteOffset = (blockIndex * channels + channel) * DSF_BLOCK_BYTES + (withinBlock >> 3);
      shift = 7 - (withinBlock & 7);
    } else {
      // DFF: one byte per channel, interleaved sample by sample.
      const bitIndex = position * channels + channel;
      byteOffset = bitIndex >> 3;
      shift = 7 - (bitIndex & 7);
    }
    const byte = input[byteOffset];
    if (byte === undefined) return 0;
    return ((byte >> shift) & 1) ? 1 : -1;
  };

  /** The stage-one average for one intermediate sample: a boxcar over `stageOne` bits. */
  const intermediate = (channel: number, index: number): number => {
    const start = index * stageOne;
    let sum = 0;
    for (let offset = 0; offset < stageOne; offset++) sum += bitAt(channel, start + offset);
    return sum / stageOne;
  };

  for (let frame = 0; frame < outputFrames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      let acc = 0;
      for (let tap = 0; tap < taps; tap++) {
        const position = frame * stageTwo + tap - half;
        if (position < 0 || position >= stageOneFrames) continue;
        acc += intermediate(channel, position) * kernel[tap]!;
      }
      // `acc` is already a mean of ±1, so it sits in -1..1 without scaling.
      out[frame * channels + channel] = Math.round(Math.max(-1, Math.min(1, acc)) * 32_767);
    }
  }
  return out;
}

/** Wraps PCM in a 44-byte WAV header, so a browser can play it without a decoder. */
export function pcm16ToWav(pcm: Int16Array, sampleRate = DSD_OUTPUT_RATE, channels = 2): Buffer {
  const dataBytes = pcm.byteLength;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

/** The whole file, decoded. Callers stream the WAV bytes through the normal range path. */
export function decodeDsdFile(path: string): { wav: Buffer; info: DsdInfo } {
  const buffer = readFileSync(path);
  const info = readDsdInfo(buffer);
  if (info.compressed) {
    throw new DsdError("unsupported_format", "this DFF file is DST-compressed, which this decoder does not expand");
  }
  const payload = buffer.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
  const pcm = dsdToPcm16(payload, info);
  return { wav: pcm16ToWav(pcm, DSD_OUTPUT_RATE, info.channels), info };
}
