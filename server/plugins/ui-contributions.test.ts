import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { panelSpecSchema } from "../../shared/plugins/panels.ts";
import { themeSpecSchema } from "../../shared/plugins/themes.ts";
import { PluginInstallStore } from "./store.ts";
import { PluginRegistry } from "./registry.ts";
import { manifest } from "./test-fixtures.ts";
import { readPluginUi } from "./ui-contributions.ts";
import { SavedPanels } from "./saved-panels.ts";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const spec = { schemaVersion: 1, title: "Tasks", slot: "workspace", items: [{ type: "data", source: "tasks" }] } as const;
const theme = { schemaVersion: 1, title: "Paper", tokens: { app: "#ffffff", panel: "#ffffff", ink: "#111111", secondary: "#333333", accent: "#111111", accentInk: "#ffffff" } };

function folder() {
  const root = mkdtempSync(join(tmpdir(), "eac-plugin-ui-"));
  folders.push(root);
  return root;
}

describe("plugin UI contributions", () => {
  it("loads namespaced contributions only while active and isolates invalid panels", async () => {
    const root = folder();
    const packageDir = join(root, "package");
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, "panel.json"), JSON.stringify(spec));
    writeFileSync(join(packageDir, "bad.json"), JSON.stringify({ ...spec, html: "<script>unsafe</script>" }));
    writeFileSync(join(packageDir, "theme.json"), JSON.stringify(theme));
    writeFileSync(join(packageDir, "sandbox.json"), JSON.stringify({ schemaVersion: 1, title: "Sandbox", slot: "bot", html: "<p>Read-only panel</p>" }));
    writeFileSync(join(packageDir, "layout.json"), JSON.stringify({ schemaVersion: 1, title: "Workspace", panels: ["eac.test:tasks"], columns: 2 }));
    const registry = new PluginRegistry(new PluginInstallStore(root), { hostVersion: "0.1.146", host: "server", platform: "win32-x64" });
    const installed = registry.install(manifest({ contributes: {
      panels: [{ id: "tasks", title: "Tasks", entry: "panel.json", mode: "declarative" }, { id: "broken", title: "Broken", entry: "bad.json", mode: "declarative" }, { id: "sandbox", title: "Sandbox", entry: "sandbox.json", mode: "sandbox" }],
      themes: [{ id: "paper", title: "Paper", entry: "theme.json" }],
      layouts: [{ id: "workspace", title: "Workspace", entry: "layout.json" }],
    } }), "local", { packageDir });
    expect(readPluginUi(registry).panels).toEqual([]);
    await registry.activate(installed.installationId);
    const loaded = readPluginUi(registry);
    expect(loaded.panels.map((panel) => panel.key)).toEqual(["eac.test:tasks", "eac.test:sandbox"]);
    expect(loaded.themes).toHaveLength(1);
    expect(loaded.layouts).toHaveLength(1);
    expect(loaded.errors[0]!.key).toBe("eac.test:broken");
    await registry.deactivate(installed.installationId);
    expect(readPluginUi(registry)).toMatchObject({ panels: [], themes: [], layouts: [] });
  });

  it("rejects arbitrary components, data sources, CSS and insufficient contrast", () => {
    expect(panelSpecSchema.safeParse({ ...spec, items: [{ type: "data", source: "private-sql" }] }).success).toBe(false);
    expect(panelSpecSchema.safeParse({ ...spec, items: [{ type: "script", text: "alert(1)" }] }).success).toBe(false);
    expect(themeSpecSchema.safeParse({ ...theme, tokens: { ...theme.tokens, ink: "#ffffff" } }).success).toBe(false);
    expect(themeSpecSchema.safeParse({ ...theme, css: "body { display:none }" }).success).toBe(false);
  });

  it("persists panel versions, refuses stale writes and rolls back through a new revision", () => {
    const root = folder();
    const panels = new SavedPanels(root);
    panels.save({ panelId: "my-panel", expectedRevision: 0, spec });
    panels.save({ panelId: "my-panel", expectedRevision: 1, spec: { ...spec, title: "Changed" } });
    expect(() => panels.save({ panelId: "my-panel", expectedRevision: 1, spec })).toThrow(/changed/);
    const restored = new SavedPanels(root);
    expect(restored.list()[0]!.spec.title).toBe("Changed");
    expect(restored.rollback("my-panel", 2, 1)).toMatchObject({ revision: 3, spec: { title: "Tasks" } });
    expect(restored.history("my-panel")).toHaveLength(3);
    expect(restored.remove("my-panel", 3)).toBe(true);
    expect(restored.list()).toEqual([]);
  });
});
