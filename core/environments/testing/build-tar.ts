/**
 * Builds a real ustar archive in memory, so a test can exercise the reader
 * against the byte layout a release actually ships rather than a mock of it.
 */

import { gzipSync } from "node:zlib";

export interface TarInput {
  readonly name: string;
  readonly bytes: Buffer;
  /** `0` regular file (default), `2` symlink, `5` directory. */
  readonly type?: string;
  readonly linkName?: string;
}

const BLOCK = 512;

export function buildTarGz(entries: readonly TarInput[]): Buffer {
  return gzipSync(buildTar(entries));
}

export function buildTar(entries: readonly TarInput[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "0";
    const header = Buffer.alloc(BLOCK);
    header.write(entry.name, 0, 100, "utf8");
    header.write(octal(0o644, 8), 100, 8, "utf8");
    header.write(octal(0, 8), 108, 8, "utf8");
    header.write(octal(0, 8), 116, 8, "utf8");
    header.write(octal(type === "0" ? entry.bytes.byteLength : 0, 12), 124, 12, "utf8");
    header.write(octal(0, 12), 136, 12, "utf8");
    header.write("        ", 148, 8, "utf8");
    header.write(type, 156, 1, "utf8");
    if (entry.linkName) header.write(entry.linkName, 157, 100, "utf8");
    header.write("ustar\0" + "00", 257, 8, "utf8");
    header.write(octal(checksum(header), 8), 148, 8, "utf8");
    blocks.push(header);
    if (type === "0" && entry.bytes.byteLength > 0) {
      blocks.push(entry.bytes);
      const padding = (BLOCK - (entry.bytes.byteLength % BLOCK)) % BLOCK;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

/** The checksum field is computed with its own eight bytes read as spaces. */
function checksum(header: Buffer): number {
  let sum = 0;
  for (let at = 0; at < BLOCK; at += 1) sum += at >= 148 && at < 156 ? 0x20 : header[at]!;
  return sum;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}
