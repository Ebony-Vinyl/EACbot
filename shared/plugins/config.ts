// A plugin's `config.schema.json` is the contract for the values a person fills in its work directory. The host
// reads and writes that one file; this module is the whole of what a schema may ask for, so the form and the
// server agree on the same subset instead of drifting apart.
import { z } from "zod";

/** The JSON Schema subset every bundled plugin uses: flat keys, string/number/boolean, no nesting. */
const fieldSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().max(2_000).optional(),
  /** Never echoed back once saved: the form shows a placeholder and an empty box means "keep what is there". */
  secret: z.boolean().optional(),
  enum: z.array(z.union([z.string(), z.number()])).max(100).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict();

export const pluginConfigSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), fieldSchema).default({}),
  required: z.array(z.string()).max(64).optional(),
  additionalProperties: z.literal(false).optional(),
}).strict();

export type PluginConfigSchema = z.infer<typeof pluginConfigSchema>;
export type PluginConfigField = z.infer<typeof fieldSchema>;

export type PluginConfigParse = { ok: true; schema: PluginConfigSchema } | { ok: false; error: string };

export function parsePluginConfigSchema(input: unknown): PluginConfigParse {
  const parsed = pluginConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") || "schema"}: ${issue?.message ?? "invalid config schema"}` };
  }
  const required = parsed.data.required ?? [];
  const declared = new Set(Object.keys(parsed.data.properties));
  const unknown = required.find((key) => !declared.has(key));
  if (unknown) return { ok: false, error: `required names ${unknown}, which properties does not declare` };
  return { ok: true, schema: parsed.data };
}

export interface PluginConfigView {
  /** Field names and their descriptions, in the order the schema lists them. */
  fields: Array<{ key: string } & PluginConfigField>;
  /** What is set, with every secret replaced by whether it has a value. */
  values: Record<string, string | number | boolean | { set: true }>;
  /** Required fields with no value yet. */
  missing: string[];
}

/**
 * What the form shows. A secret's value never leaves the server: it is reported as `{set: true}`, so a saved token
 * cannot be read back out of the UI, a log, or a paired phone.
 */
export function pluginConfigView(schema: PluginConfigSchema, stored: Record<string, unknown>): PluginConfigView {
  const fields = Object.entries(schema.properties).map(([key, field]) => ({ key, ...field }));
  const values: PluginConfigView["values"] = {};
  const missing: string[] = [];
  for (const field of fields) {
    const value = stored[field.key];
    const has = value !== undefined && value !== null && value !== "";
    if (!has) {
      if ((schema.required ?? []).includes(field.key)) missing.push(field.key);
      continue;
    }
    if (field.secret) {
      values[field.key] = { set: true };
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") values[field.key] = value;
  }
  return { fields, values, missing };
}

export type PluginConfigWrite = { ok: true; config: Record<string, string | number | boolean> } | { ok: false; error: string };

/**
 * The next file contents from what the form submitted. A value the schema does not declare is refused rather than
 * kept: an unknown key would reach the plugin unread, and could only ever be a mistake or an attempt to smuggle one.
 * An empty string for a secret keeps the stored value, which is how a form avoids echoing a token back and forth.
 */
export function pluginConfigWrite(
  schema: PluginConfigSchema,
  stored: Record<string, unknown>,
  submitted: Record<string, unknown>,
): PluginConfigWrite {
  const next: Record<string, string | number | boolean> = {};
  // Only keys this schema declares survive: a stored value nothing reads is either stale or smuggled in.
  for (const key of Object.keys(stored)) {
    if (!(key in schema.properties)) continue;
    const value = stored[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") next[key] = value;
  }
  for (const [key, raw] of Object.entries(submitted)) {
    const field = schema.properties[key];
    if (!field) return { ok: false, error: `"${key}" is not a field of this plugin's configuration` };
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "string" && raw === "") {
      // Empty means "unchanged" for a secret and "cleared" for anything else.
      if (field.secret) continue;
      delete next[key];
      continue;
    }
    if (field.type === "number") {
      const value = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) return { ok: false, error: `${key} must be a number` };
      next[key] = value;
      continue;
    }
    if (field.type === "boolean") {
      if (typeof raw !== "boolean") return { ok: false, error: `${key} must be true or false` };
      next[key] = raw;
      continue;
    }
    if (typeof raw !== "string") return { ok: false, error: `${key} must be text` };
    if (raw.length > 4_000) return { ok: false, error: `${key} is limited to 4000 characters` };
    if (field.enum && !field.enum.some((allowed) => String(allowed) === raw)) {
      return { ok: false, error: `${key} must be one of ${field.enum.map(String).join(", ")}` };
    }
    next[key] = raw;
  }
  const missing = (schema.required ?? []).filter((key) => next[key] === undefined);
  if (missing.length) return { ok: false, error: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required` };
  return { ok: true, config: next };
}

/** Values a stored file has that this schema does not declare, so a form can say what it will drop. */
export function undeclaredKeys(schema: PluginConfigSchema, stored: Record<string, unknown>): string[] {
  return Object.keys(stored).filter((key) => !(key in schema.properties));
}
