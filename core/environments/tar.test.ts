import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { InstallFailedError, extractMember, findProgramMember, readTar, readTarGz, safeMemberName } from "./index.ts";
import { buildTar, buildTarGz } from "./testing/build-tar.ts";

const BINARY = Buffer.from("#!/bin/sh\necho herdr-core\n");

function read(entries: Parameters<typeof buildTar>[0]) {
  return readTarGz(buildTarGz(entries));
}

describe("a release archive this layer reads", () => {
  it("finds every regular file and keeps its bytes", () => {
    const members = read([
      { name: "pkg/herdr-core", bytes: BINARY },
      { name: "pkg/README.md", bytes: Buffer.from("readme\n") },
    ]);
    expect(members.map((member) => member.name)).toEqual(["pkg/herdr-core", "pkg/README.md"]);
    expect(members[0]!.bytes.toString()).toBe(BINARY.toString());
  });

  it("finds the program by its last path segment, wherever the archive nests it", () => {
    const members = read([{ name: "herdr-core-0.1.21/bin/herdr-core", bytes: BINARY }]);
    expect(findProgramMember(members, "herdr-core").name).toBe("herdr-core-0.1.21/bin/herdr-core");
  });

  it("refuses a second file with the same name rather than picking one", () => {
    const members = read([
      { name: "a/herdr-core", bytes: BINARY },
      { name: "b/herdr-core", bytes: BINARY },
    ]);
    expect(() => findProgramMember(members, "herdr-core")).toThrow(/holds 2 files/);
  });

  it("extracts one named member", () => {
    const archive = buildTarGz([{ name: "pkg/herdr-core", bytes: BINARY }]);
    expect(extractMember(archive, "pkg/herdr-core").toString()).toBe(BINARY.toString());
  });

  it("skips a directory entry, which a real archive carries", () => {
    const members = read([
      { name: "pkg/", bytes: Buffer.alloc(0), type: "5" },
      { name: "pkg/herdr-core", bytes: BINARY },
    ]);
    expect(members.map((member) => member.name)).toEqual(["pkg/herdr-core"]);
  });

  it("stops at the end-of-archive marker", () => {
    const tar = buildTar([{ name: "a", bytes: Buffer.from("x") }]);
    expect(readTar(Buffer.concat([tar, Buffer.from("trailing junk")]))).toHaveLength(1);
  });
});

describe("an archive that tries to escape", () => {
  it("refuses a member that climbs out with ..", () => {
    expect(() => read([{ name: "../../etc/passwd", bytes: BINARY }])).toThrow(/leaves the target directory/);
  });

  it("refuses an absolute member", () => {
    expect(() => read([{ name: "/etc/passwd", bytes: BINARY }])).toThrow(/not a relative path/);
  });

  it("refuses a Windows absolute member", () => {
    expect(() => read([{ name: "C:/Windows/System32/evil", bytes: BINARY }])).toThrow(/not a relative path/);
  });

  it("refuses a member with a backslash separator", () => {
    expect(() => read([{ name: "pkg\\..\\evil", bytes: BINARY }])).toThrow(/separator/);
  });

  it("refuses a symlink entry", () => {
    expect(() => read([{ name: "link", bytes: Buffer.alloc(0), type: "2", linkName: "/etc/passwd" }])).toThrow(/symlink/);
  });

  it("refuses a hard link entry", () => {
    expect(() => read([{ name: "link", bytes: Buffer.alloc(0), type: "1", linkName: "target" }])).toThrow(/hard link/);
  });

  it("refuses a fifo entry", () => {
    expect(() => read([{ name: "pipe", bytes: Buffer.alloc(0), type: "6" }])).toThrow(/fifo/);
  });

  it("refuses a member with an empty path segment", () => {
    expect(() => safeMemberName("pkg//herdr-core")).toThrow(/path segment/);
  });

  it("refuses an entry name that is only a dot", () => {
    expect(() => safeMemberName("./")).toThrow(/not a relative path/);
  });

  it("accepts a normal nested name and strips a leading ./", () => {
    expect(safeMemberName("./pkg/bin/herdr-core")).toBe("pkg/bin/herdr-core");
  });
});

describe("a damaged archive", () => {
  it("refuses bytes that are not gzip", () => {
    expect(() => readTarGz(Buffer.from("not gzip at all"))).toThrow(InstallFailedError);
  });

  it("refuses a header whose checksum is wrong", () => {
    const tar = buildTar([{ name: "a", bytes: Buffer.from("x") }]);
    tar[10] = 0x41;
    expect(() => readTar(tar)).toThrow(/checksum/);
  });

  it("refuses an archive truncated mid-member", () => {
    const tar = buildTar([{ name: "a", bytes: Buffer.from("0123456789") }]);
    const truncated = tar.subarray(0, 512 + 4);
    expect(() => readTar(truncated)).toThrow(/truncated/);
  });

  it("refuses an archive with no files at all", () => {
    expect(() => readTar(Buffer.alloc(1024))).toThrow(/holds no files/);
  });

  it("refuses a member larger than the cap", () => {
    const tar = buildTar([{ name: "big", bytes: Buffer.alloc(2048) }]);
    expect(() => readTar(tar, { maxMemberBytes: 1024 })).toThrow(/larger than this layer will read/);
  });

  it("refuses a gzip bomb past the decompressed cap", () => {
    const archive = buildTarGz([{ name: "a", bytes: Buffer.alloc(4 * 1024 * 1024) }]);
    expect(archive.byteLength).toBeLessThan(100_000);
    expect(() => readTarGz(archive, { maxArchiveBytes: 1024 * 1024 })).toThrow(InstallFailedError);
  });
});

describe("the reader against a real archive", () => {
  it("reads what the system tar wrote, when a system tar is available", () => {
    const gz = buildTarGz([{ name: "pkg/herdr-core", bytes: BINARY }]);
    expect(gunzipSync(gz).subarray(257, 262).toString()).toBe("ustar");
    expect(readTarGz(gz)[0]!.bytes.toString()).toBe(BINARY.toString());
  });
});
