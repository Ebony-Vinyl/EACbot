import { z } from "zod";

import { parseSemVer, validSemVerRange } from "./semver.ts";

export const PLUGIN_EFFECTS = ["read", "draft", "control", "write", "send", "delete", "financial", "security"] as const;
export type PluginEffect = (typeof PLUGIN_EFFECTS)[number];

export const PLUGIN_HOSTS = ["server", "desktop", "web"] as const;
export type PluginHost = (typeof PLUGIN_HOSTS)[number];

export const PLUGIN_RUNTIME_MODES = ["declarative", "process", "external"] as const;
export type PluginRuntimeMode = (typeof PLUGIN_RUNTIME_MODES)[number];

export const PLUGIN_ACTIVATIONS = ["manual", "on-demand"] as const;
export type PluginActivation = (typeof PLUGIN_ACTIVATIONS)[number];

const pluginIdPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}$/;
const serviceNamePattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)*$/;
const eventNamePattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){1,4}$/;
const exactVersion = z.string().max(120).refine((value) => parseSemVer(value) !== null, "must be an exact SemVer version");
const versionRange = z.string().max(200).refine(validSemVerRange, "must be a supported SemVer range");
const nonEmpty = (max: number) => z.string().trim().min(1).max(max);
const stringList = (maxItems: number, maxLength: number) => z.array(z.string().trim().min(1).max(maxLength)).max(maxItems);

/** Package-relative paths only: no absolute path, drive letter, backslash, empty or parent segment. */
export function isSafePackagePath(value: string): boolean {
  if (!value || value.length > 240 || value.includes("\0") || value.includes("\\") || value.includes(":")) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const packagePath = z.string().max(240).refine(isSafePackagePath, "must be a package-relative path");

const scopeTargets = z.union([
  z.literal("selected"),
  z.array(z.string().trim().min(1).max(128)).min(1).max(50),
]);

const permissionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, "must be a lowercase permission id"),
  capability: z.string().max(120).regex(serviceNamePattern, "must be a dotted capability name"),
  effect: z.enum(PLUGIN_EFFECTS),
  scope: z.object({
    accounts: scopeTargets.optional(),
    devices: scopeTargets.optional(),
    memorySpaces: scopeTargets.optional(),
    resources: scopeTargets.optional(),
    domains: stringList(50, 253).optional(),
    paths: stringList(50, 512).optional(),
  }).strict(),
  reason: nonEmpty(500),
}).strict();

const toolContribution = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  entry: packagePath,
  effect: z.enum(PLUGIN_EFFECTS),
  /** The permission a call consumes; absent means the host matches one permission with the same effect. */
  permission: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).optional(),
  description: nonEmpty(500).optional(),
}).strict();

const panelContribution = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  title: nonEmpty(80),
  entry: packagePath,
  mode: z.enum(["declarative", "sandbox"]),
}).strict();

const themeContribution = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  title: nonEmpty(80),
  entry: packagePath,
}).strict();

const layoutContribution = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  title: nonEmpty(80),
  entry: packagePath,
}).strict();

const modelContribution = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  title: nonEmpty(80),
  entry: packagePath,
}).strict();

const contributesSchema = z.object({
  tools: z.union([packagePath, z.array(toolContribution).max(64)]).optional(),
  panels: z.array(panelContribution).max(32).optional(),
  themes: z.array(themeContribution).max(16).optional(),
  layouts: z.array(layoutContribution).max(16).optional(),
  models: z.array(modelContribution).max(16).optional(),
  events: z.object({
    emits: z.array(z.string().regex(eventNamePattern)).max(50).optional(),
    subscribes: z.array(z.string().regex(eventNamePattern)).max(50).optional(),
  }).strict().optional(),
  settings: packagePath.optional(),
  skills: z.array(packagePath).max(64).optional(),
}).strict();

const runtimeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("declarative") }).strict(),
  z.object({
    mode: z.literal("process"),
    entry: packagePath,
    isolation: z.enum(["required", "preferred", "none"]),
  }).strict(),
  z.object({
    mode: z.literal("external"),
    protocol: z.enum(["http", "ws", "mcp"]),
    isolation: z.enum(["required", "preferred", "none"]),
  }).strict(),
]);

function isBoundedJson(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 2_000;
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => isBoundedJson(item, depth + 1));
  if (typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 100 && entries.every(([key, item]) => key.length <= 100 && isBoundedJson(item, depth + 1));
}

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  pluginId: z.string().max(100).regex(pluginIdPattern, "must be a lowercase dotted plugin id"),
  version: exactVersion,
  apiVersion: versionRange,
  name: nonEmpty(80),
  description: nonEmpty(500),
  publisher: nonEmpty(120),
  license: nonEmpty(120),
  source: z.object({
    repository: z.string().url().max(500).refine((value) => value.startsWith("https://"), "must use https"),
    revision: z.string().regex(/^[0-9a-f]{40}$/, "must be a full lowercase git revision"),
  }).strict(),
  compatibility: z.object({
    hostVersion: versionRange,
    hosts: z.array(z.enum(PLUGIN_HOSTS)).min(1).max(3),
    platforms: z.array(z.string().regex(/^[a-z0-9]+-[a-z0-9]+$/, "must be an OS-arch pair")).min(1).max(12),
  }).strict(),
  runtime: runtimeSchema,
  activation: z.array(z.enum(PLUGIN_ACTIVATIONS)).min(1).max(2),
  provides: z.record(z.string().regex(serviceNamePattern), exactVersion).optional(),
  requires: z.record(z.string().regex(serviceNamePattern), versionRange).optional(),
  optionalRequires: z.record(z.string().regex(serviceNamePattern), versionRange).optional(),
  permissions: z.array(permissionSchema).max(64),
  contributes: contributesSchema,
  configSchema: packagePath.optional(),
  locales: z.record(z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/), packagePath).optional(),
  stateVersion: z.number().int().min(0).max(1_000_000),
  extensions: z.record(z.string().max(100), z.unknown()).optional(),
}).strict().superRefine((manifest, context) => {
  const permissionIds = new Set<string>();
  for (const permission of manifest.permissions) {
    if (permissionIds.has(permission.id)) {
      context.addIssue({ code: "custom", path: ["permissions"], message: `duplicate permission id: ${permission.id}` });
    }
    permissionIds.add(permission.id);
  }
  if (new Set(manifest.compatibility.hosts).size !== manifest.compatibility.hosts.length) {
    context.addIssue({ code: "custom", path: ["compatibility", "hosts"], message: "hosts must be unique" });
  }
  if (new Set(manifest.activation).size !== manifest.activation.length) {
    context.addIssue({ code: "custom", path: ["activation"], message: "activation modes must be unique" });
  }
  const declaredEffects = new Set(manifest.permissions.map((permission) => permission.effect));
  const tools = Array.isArray(manifest.contributes.tools) ? manifest.contributes.tools : [];
  for (const tool of tools) {
    if (!declaredEffects.has(tool.effect)) {
      context.addIssue({ code: "custom", path: ["contributes", "tools"], message: `tool ${tool.id} uses an undeclared effect: ${tool.effect}` });
    }
    if (tool.permission) {
      const permission = manifest.permissions.find((candidate) => candidate.id === tool.permission);
      if (!permission) {
        context.addIssue({ code: "custom", path: ["contributes", "tools"], message: `tool ${tool.id} names an unknown permission: ${tool.permission}` });
      } else if (permission.effect !== tool.effect) {
        context.addIssue({ code: "custom", path: ["contributes", "tools"], message: `tool ${tool.id} effect does not match permission ${tool.permission}` });
      }
    }
  }
  if (manifest.extensions && !isBoundedJson(manifest.extensions)) {
    context.addIssue({ code: "custom", path: ["extensions"], message: "extensions must be bounded JSON" });
  }
  const provided = Object.keys(manifest.provides ?? {});
  if (new Set(provided).size !== provided.length) {
    context.addIssue({ code: "custom", path: ["provides"], message: "service names must be unique" });
  }
});

export const pluginManifestSchema = manifestSchema;
export type PluginManifest = z.infer<typeof manifestSchema>;
export type PluginPermission = PluginManifest["permissions"][number];

export type PluginManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string; issues: string[] };

export function parsePluginManifest(input: unknown): PluginManifestResult {
  const parsed = manifestSchema.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`);
  return { ok: false, error: issues[0] ?? "invalid plugin manifest", issues };
}
