import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactError, downloadPluginArtifact, validateArchivePath } from "./artifact.ts";
import { manifestInput } from "./test-fixtures.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function artifact() {
  const root = mkdtempSync(join(tmpdir(), "eac-plugin-artifact-"));
  folders.push(root);
  const packageDir = join(root, "package");
  const archive = join(root, "artifact.tgz");
  const source = join(root, "pkg");
  mkdirSync(source);
  writeFileSync(join(source, "eac-plugin.json"), JSON.stringify(manifestInput()));
  writeFileSync(join(source, "server.mjs"), "process.stdin.resume();");
  await tar.c({ gzip: true, file: archive, cwd: root }, ["pkg"]);
  const bytes = readFileSync(archive);
  return { root, packageDir, bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

const response = (bytes: Uint8Array, type = "application/octet-stream") => new Response(bytes, {
  status: 200,
  headers: { "content-type": type, "content-length": String(bytes.byteLength) },
});

describe("plugin artifact download", () => {
  it("verifies the digest and extracts one package directory", async () => {
    const item = await artifact();
    await downloadPluginArtifact("https://example.com/eac-test.tgz", item.sha, item.packageDir, {
      fetch: async () => response(item.bytes),
    });
    expect(JSON.parse(readFileSync(join(item.packageDir, "eac-plugin.json"), "utf8")).pluginId).toBe("eac.test");
    expect(readFileSync(join(item.packageDir, "server.mjs"), "utf8")).toContain("stdin");
  });

  it("refuses a mismatched digest and an oversized artifact", async () => {
    const item = await artifact();
    await expect(downloadPluginArtifact("https://example.com/eac-test.tgz", "0".repeat(64), item.packageDir, {
      fetch: async () => response(item.bytes),
    })).rejects.toMatchObject({ code: "digest" });
    await expect(downloadPluginArtifact("https://example.com/eac-test.tgz", item.sha, item.packageDir, {
      fetch: async () => response(item.bytes), maxBytes: 10,
    })).rejects.toBeInstanceOf(ArtifactError);
  });

  it("rejects unsafe archive paths", () => {
    for (const path of ["../x", "/x", "a/../../x", "C:/x", "a\\b", "a//b", "./x", ""]) {
      expect(validateArchivePath(path), path).toBe(false);
    }
    expect(validateArchivePath("pkg/eac-plugin.json")).toBe(true);
    expect(validateArchivePath("pkg/")).toBe(true);
  });
});
