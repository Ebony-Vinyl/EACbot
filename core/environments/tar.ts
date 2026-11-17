/**
 * A tar reader for one trusted file: a release archive this layer downloaded
 * and checked against a pinned sha256.
 *
 * It reads ustar/pax headers and gzip, both from `node:zlib`, and it extracts
 * exactly one member. Nothing here runs a remote `tar`, so no remote flag can
 * be wrong and no archive path is handed to another program.
 *
 * An entry's name is refused when it is absolute, when any segment is `..`,
 * when it is a symlink or hard link, or when it is a device or fifo. A release
 * archive has no business carrying any of those, and a member this reader will
 * not place is a member it will not silently skip either.
 */

import { gunzipSync } from "node:zlib";

import { InstallFailedError } from "./errors.ts";

const BLOCK = 512;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_MEMBER_BYTES = 128 * 1024 * 1024;

/** Header types a release archive may carry: a regular file, a pax header, a
 * GNU long name, and the end-of-archive marker. */
const TYPE_FILE = "0";
const TYPE_FILE_LEGACY = "\0";
const TYPE_PAX = "x";
const TYPE_GNU_LONG_NAME = "L";
const TYPE_GNU_LONG_LINK = "K";
const TYPE_DIRECTORY = "5";

export interface TarMember {
  readonly name: string;
  readonly bytes: Buffer;
}

export interface TarOptions {
  /** Refuse an archive larger than this many bytes after decompression. */
  readonly maxArchiveBytes?: number;
  readonly maxMemberBytes?: number;
}

/** Every regular file in the archive, keyed by its normalised name. */
export function readTarGz(archive: Uint8Array, options: TarOptions = {}): TarMember[] {
  if (archive.byteLength > (options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES) * 2) {
    throw new InstallFailedError("the release archive is larger than this layer will read");
  }
  let raw: Buffer;
  try {
    raw = gunzipSync(archive, { maxOutputLength: options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES });
  } catch (error) {
    throw new InstallFailedError(`the release archive is not valid gzip: ${(error as Error).message}`, { cause: error });
  }
  return readTar(raw, options);
}

export function readTar(raw: Buffer, options: TarOptions = {}): TarMember[] {
  const maxMember = options.maxMemberBytes ?? MAX_MEMBER_BYTES;
  const members: TarMember[] = [];
  let at = 0;
  let pendingName: string | null = null;

  while (at + BLOCK <= raw.byteLength) {
    const header = raw.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;

    assertChecksum(header, at);
    const type = String.fromCharCode(header[156]!);
    const size = readSize(header);
    const bodyAt = at + BLOCK;
    if (size > maxMember) throw new InstallFailedError(`a member at offset ${at} is larger than this layer will read`);
    if (bodyAt + size > raw.byteLength) throw new InstallFailedError(`the archive is truncated at offset ${at}`);
    const body = raw.subarray(bodyAt, bodyAt + size);
    at = bodyAt + Math.ceil(size / BLOCK) * BLOCK;

    if (type === TYPE_PAX) {
      pendingName = readPaxPath(body.toString("utf8")) ?? pendingName;
      continue;
    }
    if (type === TYPE_GNU_LONG_NAME) {
      pendingName = cString(body);
      continue;
    }
    if (type === TYPE_GNU_LONG_LINK) continue;
    if (type === TYPE_DIRECTORY) continue;

    const name = pendingName ?? readName(header);
    pendingName = null;

    if (type !== TYPE_FILE && type !== TYPE_FILE_LEGACY) {
      throw new InstallFailedError(`the archive carries a ${describeType(type)} entry (${name}); a release archive holds regular files only`);
    }
    members.push({ name: safeMemberName(name), bytes: Buffer.from(body) });
  }

  if (members.length === 0) throw new InstallFailedError("the release archive holds no files");
  return members;
}

/**
 * The one member the caller named, or a refusal. The member must be a plain
 * relative name; a path with a directory in it is still allowed, because a
 * release may nest its binary, but it can never escape upward.
 */
export function extractMember(archive: Uint8Array, name: string, options: TarOptions = {}): Buffer {
  const wanted = safeMemberName(name);
  const members = readTarGz(archive, options);
  const found = members.find((member) => member.name === wanted);
  if (!found) {
    const names = members.map((member) => member.name).slice(0, 10).join(", ");
    throw new InstallFailedError(`the release archive has no ${wanted} (it holds ${names})`);
  }
  return found.bytes;
}

/** The binary member of a herdr-core release: the last path segment matches. */
export function findProgramMember(members: readonly TarMember[], program: string): TarMember {
  const matches = members.filter((member) => member.name.split("/").at(-1) === program);
  if (matches.length === 0) {
    throw new InstallFailedError(`the release archive has no ${program} (it holds ${members.map((member) => member.name).join(", ")})`);
  }
  if (matches.length > 1) {
    throw new InstallFailedError(`the release archive holds ${matches.length} files named ${program}`);
  }
  return matches[0]!;
}

function readName(header: Buffer): string {
  const name = cString(header.subarray(0, 100));
  const prefix = cString(header.subarray(345, 500));
  if (prefix === "") return name;
  return `${prefix}/${name}`;
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

/** An octal size field, as ustar writes it, with the GNU base-256 form allowed. */
function readSize(header: Buffer): number {
  const field = header.subarray(124, 136);
  if ((field[0]! & 0x80) !== 0) {
    let value = 0;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = cString(field).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new InstallFailedError(`the archive has a size that is not octal: ${JSON.stringify(text)}`);
  return Number.parseInt(text, 8);
}

/** The header checksum, which is what tells a real header from zero padding. */
function assertChecksum(header: Buffer, offset: number): void {
  const stored = Number.parseInt(cString(header.subarray(148, 156)).trim() || "-1", 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (!Number.isSafeInteger(stored) || stored !== sum) {
    throw new InstallFailedError(`the archive header at offset ${offset} fails its checksum`);
  }
}

/** `path=...` from a pax extended header, when it carries one. */
function readPaxPath(text: string): string | null {
  for (const record of text.split("\n")) {
    if (record === "") continue;
    const space = record.indexOf(" ");
    if (space === -1) continue;
    const length = Number(record.slice(0, space));
    if (!Number.isSafeInteger(length) || length <= 0) continue;
    const payload = record.slice(space + 1, space + 1 + length - space - 2);
    if (payload.startsWith("path=")) return payload.slice("path=".length);
  }
  return null;
}

function describeType(type: string): string {
  if (type === "1") return "hard link";
  if (type === "2") return "symlink";
  if (type === "3" || type === "4") return "device";
  if (type === "6") return "fifo";
  return `type ${JSON.stringify(type)}`;
}

/**
 * A member name that cannot escape the directory it is extracted into: relative,
 * no `..` segment, no empty segment and no backslash. This is the only thing
 * standing between a crafted archive and a write outside the staging directory.
 */
export function safeMemberName(name: string): string {
  const normalised = name.replace(/^\.\//, "");
  if (normalised === "" || normalised.startsWith("/") || /^[A-Za-z]:/.test(normalised)) {
    throw new InstallFailedError(`the archive entry ${JSON.stringify(name)} is not a relative path`);
  }
  if (normalised.includes("\\") || normalised.includes("\0")) {
    throw new InstallFailedError(`the archive entry ${JSON.stringify(name)} has a separator this reader does not accept`);
  }
  const segments = normalised.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new InstallFailedError(`the archive entry ${JSON.stringify(name)} has a path segment that leaves the target directory`);
  }
  return normalised;
}
