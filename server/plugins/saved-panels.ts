import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { panelSpecSchema, savedPanelInputSchema, type SavedPanel } from "../../shared/plugins/panels.ts";
import { writeFileAtomic } from "../atomic.ts";

const panelRecord = savedPanelInputSchema.omit({ expectedRevision: true }).extend({ revision: z.number().int().positive(), updatedAt: z.string().datetime() });
const fileSchema = z.object({ schemaVersion: z.literal(1), panels: z.array(z.object({ current: panelRecord, history: z.array(panelRecord).max(10) })).max(100) });

export class SavedPanels {
  private readonly file: string;
  constructor(dataDir: string) { this.file = join(dataDir, "plugin-panels.json"); }

  private read(): z.infer<typeof fileSchema> {
    return existsSync(this.file) ? fileSchema.parse(JSON.parse(readFileSync(this.file, "utf8"))) : { schemaVersion: 1, panels: [] };
  }

  list(): SavedPanel[] { return this.read().panels.map((panel) => panel.current); }

  history(panelId: string): SavedPanel[] {
    const panel = this.read().panels.find((candidate) => candidate.current.panelId === panelId);
    return panel ? [panel.current, ...panel.history] : [];
  }

  save(raw: unknown): SavedPanel {
    const input = savedPanelInputSchema.parse(raw);
    const state = this.read();
    const existing = state.panels.find((panel) => panel.current.panelId === input.panelId);
    if ((existing?.current.revision ?? 0) !== input.expectedRevision) throw Object.assign(new Error("The panel changed. Read its current revision before saving."), { status: 409 });
    if (!existing && state.panels.length >= 100) throw Object.assign(new Error("At most 100 custom panels may be saved."), { status: 409 });
    const current: SavedPanel = { panelId: input.panelId, spec: panelSpecSchema.parse(input.spec), revision: input.expectedRevision + 1, updatedAt: new Date().toISOString() };
    if (existing) {
      existing.history = [existing.current, ...existing.history].slice(0, 10);
      existing.current = current;
    } else state.panels.push({ current, history: [] });
    writeFileAtomic(this.file, JSON.stringify(state), { mode: 0o600 });
    return current;
  }

  rollback(panelId: string, expectedRevision: number, revision: number): SavedPanel {
    const version = this.history(panelId).find((panel) => panel.revision === revision);
    if (!version) throw Object.assign(new Error("That panel version is unavailable."), { status: 404 });
    return this.save({ panelId, expectedRevision, spec: version.spec });
  }

  remove(panelId: string, expectedRevision: number): boolean {
    const state = this.read();
    const panel = state.panels.find((candidate) => candidate.current.panelId === panelId);
    if (!panel) return false;
    if (panel.current.revision !== expectedRevision) throw Object.assign(new Error("The panel changed. Read its current revision before deleting."), { status: 409 });
    state.panels = state.panels.filter((candidate) => candidate !== panel);
    writeFileAtomic(this.file, JSON.stringify(state), { mode: 0o600 });
    return true;
  }
}
