// The values a person fills into a plugin's work directory, and the live status a bridge reports. Both live next to
// the plugin process: the config file is the one the plugin reads, and the status is asked of the process itself with
// a method that grants do not gate (a broken bridge must be diagnosable without handing a bot a permission).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { parsePluginConfigSchema, pluginConfigView, pluginConfigWrite, undeclaredKeys, type PluginConfigView } from "../../shared/plugins/config.ts";
import type { PluginInstallRecord } from "./store.ts";

export const PLUGIN_CONFIG_FILE = "config.json";

export type PluginConfigErrorCode = "not-found" | "no-schema" | "invalid" | "unreadable";

export class PluginConfigError extends Error {
  readonly code: PluginConfigErrorCode;
  constructor(code: PluginConfigErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A plugin process answers `status` with a small, free-form object; the bridge shows it verbatim. */
export interface PluginStatusView {
  fields: Array<{ key: string; type: "string" | "number" | "boolean" }>;
  values: Record<string, string | number | boolean>;
  /** Why the plugin could not report, when it could not. */
  error?: string;
}

export interface PluginConfigHostDeps {
  dataDir: string;
  /** The supervisor's `call`, when this build can run process plugins. */
  call?(installationId: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  isRunning?(installationId: string): boolean;
}

function readSchema(record: PluginInstallRecord): ReturnType<typeof parsePluginConfigSchema> {
  const declared = record.manifest.configSchema;
  if (!declared) throw new PluginConfigError("no-schema", "this plugin declares no configuration");
  if (!record.packageDir) throw new PluginConfigError("unreadable", "this installation has no local package directory");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(record.packageDir, declared), "utf8"));
  } catch {
    throw new PluginConfigError("unreadable", `the plugin's ${declared} could not be read`);
  }
  const parsed = parsePluginConfigSchema(raw);
  if (!parsed.ok) throw new PluginConfigError("invalid", parsed.error);
  return parsed;
}

/** Where the plugin process looks for its config: the work directory the supervisor starts it in. */
export function pluginWorkDir(dataDir: string, installationId: string): string {
  return join(dataDir, "plugins", "runtime", installationId);
}

function storedConfig(dataDir: string, installationId: string): Record<string, unknown> {
  const file = join(pluginWorkDir(dataDir, installationId), PLUGIN_CONFIG_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new PluginConfigError("unreadable", `${PLUGIN_CONFIG_FILE} is not valid JSON; fix or remove it before saving from here`);
  }
}

export function createPluginConfigHost(deps: PluginConfigHostDeps) {
  return {
    /** The form's fields and current values. Secrets are reported as set, never in the clear. */
    read(record: PluginInstallRecord): PluginConfigView & { undeclared: string[] } {
      const parsed = readSchema(record);
      if (!parsed.ok) throw new PluginConfigError("invalid", parsed.error);
      const stored = storedConfig(deps.dataDir, record.installationId);
      return { ...pluginConfigView(parsed.schema, stored), undeclared: undeclaredKeys(parsed.schema, stored) };
    },

    /** Writes the file the plugin will read next time it starts. Returns the view a form can render at once. */
    write(record: PluginInstallRecord, submitted: unknown): PluginConfigView & { undeclared: string[]; restartRequired: boolean } {
      const parsed = readSchema(record);
      if (!parsed.ok) throw new PluginConfigError("invalid", parsed.error);
      if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
        throw new PluginConfigError("invalid", "a configuration object is required");
      }
      const stored = storedConfig(deps.dataDir, record.installationId);
      const written = pluginConfigWrite(parsed.schema, stored, submitted as Record<string, unknown>);
      if (!written.ok) throw new PluginConfigError("invalid", written.error);
      const dir = pluginWorkDir(deps.dataDir, record.installationId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(join(dir, PLUGIN_CONFIG_FILE), `${JSON.stringify(written.config, null, 2)}\n`, { mode: 0o600 });
      const running = deps.isRunning?.(record.installationId) === true;
      return {
        ...pluginConfigView(parsed.schema, written.config),
        undeclared: undeclaredKeys(parsed.schema, written.config),
        // A process reads its config at start; a person has to disable and enable it to connect with new values.
        restartRequired: running,
      };
    },

    /**
     * The plugin's own status report. This is a host method, not a tool, so seeing whether a bridge is connected
     * needs no grant and no bot: otherwise the one person who could fix a broken bridge would first have to
     * authorise a bot to look at it.
     */
    async status(record: PluginInstallRecord): Promise<PluginStatusView> {
      if (record.manifest.runtime.mode === "declarative") return { fields: [], values: {}, error: "this plugin has no process to report" };
      if (!deps.call) return { fields: [], values: {}, error: "this build has no plugin runtime" };
      if (deps.isRunning?.(record.installationId) !== true) {
        return { fields: [], values: {}, error: "the plugin is not running; enable it to see its status" };
      }
      let reported: unknown;
      try {
        reported = await deps.call(record.installationId, "status", {}, 5_000);
      } catch (error) {
        return { fields: [], values: {}, error: error instanceof Error ? error.message : String(error) };
      }
      const values: PluginStatusView["values"] = {};
      if (reported && typeof reported === "object" && !Array.isArray(reported)) {
        for (const [key, value] of Object.entries(reported as Record<string, unknown>)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") values[key] = value;
        }
      }
      return { fields: [], values };
    },
  };
}

export type PluginConfigHost = ReturnType<typeof createPluginConfigHost>;
