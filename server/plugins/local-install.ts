import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { parsePluginManifest, type PluginManifest } from "../../shared/plugins/manifest.ts";
import type { PluginRegistry, PluginSummary } from "./registry.ts";

const MANIFEST = "eac-plugin.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

export type LocalInstallErrorCode =
  | "invalid-path"
  | "manifest-missing"
  | "manifest-too-large"
  | "manifest-invalid"
  | "entry-missing"
  | "entry-unsafe";

export class LocalInstallError extends Error {
  readonly code: LocalInstallErrorCode;
  readonly status: number;

  constructor(code: LocalInstallErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = code === "manifest-missing" || code === "entry-missing" ? 404 : code === "manifest-too-large" ? 413 : 422;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface LocalPluginPackage {
  manifest: PluginManifest;
  packageDir: string;
}

/** JSON.parse keeps the last duplicate key; a manifest must not hide one security field behind another. */
function hasDuplicateJsonKeys(text: string): boolean {
  const stack: Array<{ object: boolean; keys: Set<string>; expectingKey: boolean }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "{") {
      stack.push({ object: true, keys: new Set(), expectingKey: true });
    } else if (char === "[") {
      stack.push({ object: false, keys: new Set(), expectingKey: false });
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === "," && stack.at(-1)?.object) {
      stack.at(-1)!.expectingKey = true;
    } else if (char === ":" && stack.at(-1)?.object) {
      stack.at(-1)!.expectingKey = false;
    } else if (char === '"') {
      const start = index;
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === "\\") index += 1;
        else if (text[index] === '"') break;
      }
      const frame = stack.at(-1);
      if (frame?.object && frame.expectingKey) {
        let key: string;
        try { key = JSON.parse(text.slice(start, index + 1)); } catch { return false; }
        if (frame.keys.has(key)) return true;
        frame.keys.add(key);
        frame.expectingKey = false;
      }
    }
  }
  return false;
}

function declaredEntries(manifest: PluginManifest): string[] {
  const entries = new Set<string>();
  if (manifest.runtime.mode === "process") entries.add(manifest.runtime.entry);
  if (manifest.configSchema) entries.add(manifest.configSchema);
  for (const path of Object.values(manifest.locales ?? {})) entries.add(path);
  const tools = manifest.contributes.tools;
  if (typeof tools === "string") entries.add(tools);
  else for (const tool of tools ?? []) entries.add(tool.entry);
  for (const panel of manifest.contributes.panels ?? []) entries.add(panel.entry);
  for (const theme of manifest.contributes.themes ?? []) entries.add(theme.entry);
  for (const layout of manifest.contributes.layouts ?? []) entries.add(layout.entry);
  for (const model of manifest.contributes.models ?? []) entries.add(model.entry);
  if (manifest.contributes.settings) entries.add(manifest.contributes.settings);
  return [...entries];
}

function checkEntry(packageDir: string, entry: string, allowDirectory = false): void {
  const absolute = resolve(packageDir, entry);
  if (!inside(packageDir, absolute)) throw new LocalInstallError("entry-unsafe", `${entry} escapes the plugin package`);
  let current = packageDir;
  for (const segment of entry.split("/")) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new LocalInstallError("entry-unsafe", `${entry} runs through a link`);
      }
    } catch (error) {
      if (error instanceof LocalInstallError) throw error;
      throw new LocalInstallError("entry-missing", `${entry} does not exist`);
    }
  }
  let stat: Stats;
  let real: string;
  try {
    stat = lstatSync(absolute);
    real = realpathSync(absolute);
  } catch {
    throw new LocalInstallError("entry-missing", `${entry} does not exist`);
  }
  if (!inside(packageDir, real)) throw new LocalInstallError("entry-unsafe", `${entry} escapes the plugin package`);
  if (!stat.isFile() && !(allowDirectory && stat.isDirectory())) {
    throw new LocalInstallError("entry-unsafe", `${entry} must be a regular file${allowDirectory ? " or directory" : ""}, not a link`);
  }
  if (stat.isFile() && stat.size > MAX_ENTRY_BYTES) throw new LocalInstallError("entry-unsafe", `${entry} is larger than 512 MiB`);
}

/**
 * A local package is for development and owner-installed plugins. It is read in place; installation copies no code and
 * does not execute it. The caller must still activate it explicitly.
 */
export function readLocalPluginPackage(input: string): LocalPluginPackage {
  if (!input || input.length > 4_096 || input.includes("\0") || !isAbsolute(input)) {
    throw new LocalInstallError("invalid-path", "plugin path must be an absolute directory path");
  }
  let packageDir: string;
  try {
    packageDir = realpathSync(resolve(input));
  } catch {
    throw new LocalInstallError("manifest-missing", "that plugin directory does not exist");
  }
  try {
    if (!statSync(packageDir).isDirectory()) throw new LocalInstallError("invalid-path", "plugin path must be a directory");
  } catch (error) {
    if (error instanceof LocalInstallError) throw error;
    throw new LocalInstallError("invalid-path", "plugin path could not be read");
  }

  const manifestPath = join(packageDir, MANIFEST);
  let manifestStat: Stats;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch {
    throw new LocalInstallError("manifest-missing", `plugin directory has no ${MANIFEST}`);
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new LocalInstallError("entry-unsafe", `${MANIFEST} must be a regular file inside the package, not a link`);
  }
  if (manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new LocalInstallError("manifest-too-large", `${MANIFEST} is larger than 256 KiB`);
  }
  let raw: unknown;
  const manifestText = readFileSync(manifestPath, "utf8");
  if (hasDuplicateJsonKeys(manifestText)) throw new LocalInstallError("manifest-invalid", `${MANIFEST} contains a duplicate key`);
  try {
    raw = JSON.parse(manifestText);
  } catch {
    throw new LocalInstallError("manifest-invalid", `${MANIFEST} is not valid JSON`);
  }
  const parsed = parsePluginManifest(raw);
  if (!parsed.ok) throw new LocalInstallError("manifest-invalid", parsed.error);

  for (const entry of declaredEntries(parsed.manifest)) checkEntry(packageDir, entry);
  for (const skill of parsed.manifest.contributes.skills ?? []) checkEntry(packageDir, skill, true);
  return { manifest: parsed.manifest, packageDir };
}

export function installLocalPlugin(registry: PluginRegistry, input: string, sourceId = "local"): PluginSummary {
  const local = readLocalPluginPackage(input);
  return registry.install(local.manifest, sourceId, { packageDir: local.packageDir });
}
