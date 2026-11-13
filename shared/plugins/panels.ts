import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const text = z.string().trim().min(1).max(2_000);

export const PANEL_SLOTS = ["workspace", "bot"] as const;
export type PanelSlot = (typeof PANEL_SLOTS)[number];

const panelItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text }).strict(),
  z.object({ type: z.literal("list"), title: text.optional(), items: z.array(text).max(30) }).strict(),
  z.object({ type: z.literal("data"), source: z.enum(["tasks", "usage", "platforms"]), title: text.optional() }).strict(),
]);

export const panelSpecSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(120),
  slot: z.enum(PANEL_SLOTS),
  items: z.array(panelItemSchema).min(1).max(24),
}).strict();
export type PanelSpec = z.infer<typeof panelSpecSchema>;

/** 高级面板在不透明来源 frame 中运行，只可请求宿主提供的只读数据。 */
export const sandboxPanelSpecSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(120),
  slot: z.enum(PANEL_SLOTS),
  html: z.string().trim().min(1).max(100_000),
}).strict();
export type SandboxPanelSpec = z.infer<typeof sandboxPanelSpecSchema>;
export type UiPanelSpec = PanelSpec | SandboxPanelSpec;

export const layoutSpecSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(120),
  panels: z.array(z.string().regex(/^[a-z][a-z0-9.-]{1,99}:[a-z][a-z0-9-]{1,63}$/)).min(1).max(12),
  columns: z.union([z.literal(1), z.literal(2)]),
}).strict();
export type LayoutSpec = z.infer<typeof layoutSpecSchema>;

export const savedPanelInputSchema = z.object({
  panelId: identifier,
  expectedRevision: z.number().int().nonnegative(),
  spec: panelSpecSchema,
}).strict();

export interface SavedPanel {
  panelId: string;
  revision: number;
  spec: PanelSpec;
  updatedAt: string;
}
