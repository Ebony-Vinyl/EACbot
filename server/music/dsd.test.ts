import { describe, expect, it } from "vitest";

import { dsdToPcm16, pcm16ToWav, readDsdInfo, DSD_OUTPUT_RATE, DsdError } from "./dsd.ts";

/** A DSF file with a given DSD payload, laid out as the format specifies. */
function buildDsf(input: { channels: number; bitRate: number; payload: Buffer; bitsPerSample?: number }): Buffer {
  // The container header is 28 bytes, then the fmt chunk (12-byte header + 40-byte
  // payload = 52), then the data chunk.
  const header = Buffer.alloc(28);
  header.write("DSD ", 0, "ascii");
  header.writeUInt32LE(28, 4);        // size of the container header
  header.writeUInt32LE(0, 8);         // total file size, unused by the reader
  header.writeUInt32LE(0, 12);        // metadata offset

  const fmt = Buffer.alloc(52);
  fmt.write("fmt ", 0, "ascii");
  // A DSF chunk size is a 64-bit field: its low word, then its high word.
  fmt.writeUInt32LE(52, 4);
  fmt.writeUInt32LE(0, 8);
  fmt.writeUInt32LE(1, 12);           // format version
  fmt.writeUInt32LE(0, 16);           // format id: 0 is DSD
  fmt.writeUInt32LE(2, 20);           // channel type: 2 is stereo
  fmt.writeUInt32LE(input.channels, 24);
  // A DSF sample rate field is the DSD byte rate, one eighth of the bit rate.
  fmt.writeUInt32LE(input.bitRate / 8, 28);
  fmt.writeUInt32LE(input.bitsPerSample ?? 1, 32);
  fmt.writeUInt32LE(0, 36);           // sample count low
  fmt.writeUInt32LE(0, 40);           // sample count high

  const data = Buffer.alloc(12);
  data.write("data", 0, "ascii");
  data.writeUInt32LE(input.payload.length, 4);
  data.writeUInt32LE(0, 8);

  return Buffer.concat([header, fmt, data, input.payload]);
}

/** A DFF file with a PROP/SND chunk chain and a DSD audio chunk. */
function buildDff(input: { channels: number; bitRate: number; payload: Buffer; compressed?: boolean }): Buffer {
  const chunk = (id: string, payload: Buffer): Buffer => {
    const head = Buffer.alloc(12);
    head.write(id, 0, "ascii");
    // A DFF chunk size is a 64-bit big-endian field: high word first.
    head.writeUInt32BE(0, 4);
    head.writeUInt32BE(payload.length, 8);
    // Every DFF chunk is padded to an even length.
    return Buffer.concat([head, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };

  const fs = Buffer.alloc(4);
  fs.writeUInt32BE(input.bitRate, 0);
  const chnl = Buffer.alloc(4);
  chnl.writeUInt16BE(input.channels, 0);
  const cmpr = Buffer.alloc(8);
  cmpr.write("DSD ", 0, "ascii");
  cmpr.write(input.compressed ? "DST " : "DSD ", 4, "ascii");

  const snd = Buffer.concat([chunk("FS  ", fs), chunk("CHNL", chnl), chunk("CMPR", cmpr)]);
  const prop = chunk("PROP", Buffer.concat([Buffer.from("SND ", "ascii"), snd]));
  const audio = chunk(input.compressed ? "DST " : "DSD ", input.payload);

  const body = Buffer.concat([prop, audio]);
  const header = Buffer.alloc(16);
  header.write("FRM8", 0, "ascii");
  header.writeUInt32BE(body.length, 4);
  header.write("DSD ", 12, "ascii");
  return Buffer.concat([header, body]);
}

describe("readDsdInfo", () => {
  it("reads a DSF header's channels, bit rate and payload", () => {
    const info = readDsdInfo(buildDsf({ channels: 2, bitRate: 2_822_400, payload: Buffer.alloc(64, 0x69) }));
    expect(info.format).toBe("dsf");
    expect(info.channels).toBe(2);
    expect(info.bitRate).toBe(2_822_400);
    expect(info.dsdRate).toBe(64);
    expect(info.dataBytes).toBe(64);
    expect(info.compressed).toBe(false);
  });

  it("reads a DFF header through its PROP chunk chain", () => {
    const info = readDsdInfo(buildDff({ channels: 2, bitRate: 5_644_800, payload: Buffer.alloc(64, 0x69) }));
    expect(info.format).toBe("dff");
    expect(info.channels).toBe(2);
    expect(info.bitRate).toBe(5_644_800);
    expect(info.dsdRate).toBe(128);
  });

  it("marks a DST-compressed DFF as compressed", () => {
    const info = readDsdInfo(buildDff({ channels: 2, bitRate: 2_822_400, payload: Buffer.alloc(16), compressed: true }));
    expect(info.compressed).toBe(true);
  });

  it("refuses a file that is neither container", () => {
    expect(() => readDsdInfo(Buffer.from("RIFF....WAVE"))).toThrow(DsdError);
  });

  it("refuses a DSF that declares something other than one bit per sample", () => {
    const file = buildDsf({ channels: 2, bitRate: 2_822_400, payload: Buffer.alloc(16), bitsPerSample: 8 });
    expect(() => readDsdInfo(file)).toThrow(/not DSD/);
  });
});

/** One second of stereo DSD64: 2 822 400 bits per channel, packed eight to a byte. */
function oneSecondStereo64(fill: number): Buffer {
  return Buffer.alloc((2_822_400 / 8) * 2, fill);
}

describe("dsdToPcm16", () => {
  it("decimates DSD64 to 44.1 kHz at the expected frame count", () => {
    const pcm = dsdToPcm16(oneSecondStereo64(0x69), { bitRate: 2_822_400, channels: 2, layout: "interleaved" });
    // One second of output at 44.1 kHz, two channels.
    expect(pcm.length).toBe(DSD_OUTPUT_RATE * 2);
  });

  it("returns nothing for a payload too short to produce a frame", () => {
    expect(dsdToPcm16(Buffer.alloc(2), { bitRate: 2_822_400, channels: 2, layout: "interleaved" }).length).toBe(0);
  });

  it("reads an all-zeros payload as the negative rail, not as silence", () => {
    // Every bit is 0, which is full negative deflection in DSD: a decoder that
    // treated 0 as "no sample" would output zeros here instead.
    const pcm = dsdToPcm16(Buffer.alloc(2_822_400 / 8, 0x00), { bitRate: 2_822_400, channels: 1, layout: "interleaved" });
    // The first frames are attenuated by edge padding, so the steady state is what counts.
    const steady = pcm.subarray(400);
    expect(new Set(steady).size).toBe(1);
    expect(steady[0]).toBeLessThan(-20_000);
  });

  it("produces a loud signal from an all-ones pattern", () => {
    const pcm = dsdToPcm16(oneSecondStereo64(0xff), { bitRate: 2_822_400, channels: 2, layout: "interleaved" });
    const peak = pcm.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    expect(peak).toBeGreaterThan(20_000);
  });

  it("keeps each channel on its own samples when the payload interleaves", () => {
    // In an interleaved stereo payload the even bits are the left channel and the
    // odd bits the right, so 0xAA (10101010) is left at the positive rail and right
    // at the negative one. A decoder that ignored the layout would mix them.
    const pcm = dsdToPcm16(oneSecondStereo64(0xaa), { bitRate: 2_822_400, channels: 2, layout: "interleaved" });
    const left = pcm[10_000]!;
    const right = pcm[10_001]!;
    expect(left).toBeGreaterThan(20_000);
    expect(right).toBeLessThan(-20_000);
  });

  it("never exceeds full scale: the filter is normalised", () => {
    const pcm = dsdToPcm16(oneSecondStereo64(0xff), { bitRate: 2_822_400, channels: 2, layout: "interleaved" });
    expect(Math.max(...pcm)).toBeLessThanOrEqual(32_767);
    expect(Math.min(...pcm)).toBeGreaterThanOrEqual(-32_768);
  });

  it("filters out a bit stream that alternates every sample", () => {
    // In a mono payload 0xAA is 10101010: the highest frequency DSD can carry. The
    // low-pass must reject nearly all of it, so the output sits near zero. A
    // decoder that aliased would show a full-scale tone instead.
    const pcm = dsdToPcm16(Buffer.alloc(2_822_400 / 8, 0xaa), { bitRate: 2_822_400, channels: 1, layout: "interleaved" });
    const steady = pcm.subarray(400);
    const peak = steady.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    expect(peak).toBeLessThan(1_000);
  });

  it("keeps the DSF channels apart when the payload is stored in blocks", () => {
    // A blocked DSF payload holds 4096 bytes of channel 0, then 4096 of channel 1.
    // The first block is all ones and the second all zeros, so left and right must
    // land on opposite rails; reading the payload as interleaved would average them.
    const payload = Buffer.concat([Buffer.alloc(4_096, 0xff), Buffer.alloc(4_096, 0x00)]);
    const pcm = dsdToPcm16(payload, { bitRate: 2_822_400, channels: 2, layout: "blocked" });
    const left = pcm[1_000]!;
    const right = pcm[1_001]!;
    expect(left).toBeGreaterThan(20_000);
    expect(right).toBeLessThan(-20_000);
  });
});

describe("pcm16ToWav", () => {
  it("writes a 44-byte RIFF header that matches the payload", () => {
    const pcm = new Int16Array([0, 1_000, -1_000, 2_000]);
    const wav = pcm16ToWav(pcm, 44_100, 2);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wav.readUInt32LE(24)).toBe(44_100);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(pcm.byteLength);
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
  });
});
