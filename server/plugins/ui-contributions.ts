import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { panelSpecSchema, sandboxPanelSpecSchema, layoutSpecSchema, type UiPanelSpec, type LayoutSpec } from "../../shared/plugins/panels.ts";
import { themeSpecSchema, type ThemeSpec } from "../../shared/plugins/themes.ts";
import type { PluginRegistry } from "./registry.ts";

export interface PluginUiContribution<T> {
  key: string;
  installationId: string;
  title: string;
  spec: T;
}

export interface PluginUiCatalog {
  panels: Array<PluginUiContribution<UiPanelSpec>>;
  themes: Array<PluginUiContribution<ThemeSpec>>;
  layouts: Array<PluginUiContribution<LayoutSpec>>;
  errors: Array<{ key: string; error: string }>;
}

function readPackageJson(root: string, entry: string): unknown {
  const base = realpathSync(root);
  const target = resolve(base, entry);
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("The contribution leaves its package.");
  let path = base;
  for (const segment of rel.split(/[\\/]/)) {
    path = join(path, segment);
    if (lstatSync(path).isSymbolicLink()) throw new Error("Contribution paths must not contain links.");
  }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > 128 * 1024) throw new Error("The contribution must be a JSON file of at most 128 KiB.");
  return JSON.parse(readFileSync(target, "utf8"));
}

export function readPluginUi(registry: PluginRegistry): PluginUiCatalog {
  const result: PluginUiCatalog = { panels: [], themes: [], layouts: [], errors: [] };
  for (const plugin of registry.list()) {
    if (plugin.state !== "active") continue;
    const record = registry.store.get(plugin.installationId)!;
    for (const kind of ["panels", "themes", "layouts"] as const) {
      for (const contribution of record.manifest.contributes[kind] ?? []) {
        const key = `${record.pluginId}:${contribution.id}`;
        try {
          if (!record.packageDir) throw new Error("The installed plugin has no package directory.");
          const raw = readPackageJson(record.packageDir, contribution.entry);
          const common = { key, installationId: record.installationId, title: contribution.title };
          if (kind === "panels") {
            const schema = "mode" in contribution && contribution.mode === "sandbox" ? sandboxPanelSpecSchema : panelSpecSchema;
            result.panels.push({ ...common, spec: schema.parse(raw) });
          }
          if (kind === "themes") result.themes.push({ ...common, spec: themeSpecSchema.parse(raw) });
          if (kind === "layouts") result.layouts.push({ ...common, spec: layoutSpecSchema.parse(raw) });
        } catch (error) {
          result.errors.push({ key, error: error instanceof Error ? error.message.slice(0, 500) : "Invalid UI contribution." });
        }
      }
    }
  }
  const panelKeys = new Set(result.panels.map((panel) => panel.key));
  result.layouts = result.layouts.filter((layout) => {
    if (layout.spec.panels.every((key) => panelKeys.has(key))) return true;
    result.errors.push({ key: layout.key, error: "A panel required by this layout is unavailable." });
    return false;
  });
  return result;
}
