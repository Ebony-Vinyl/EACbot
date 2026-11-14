import { z } from "zod";

import { PLATFORM_IDS } from "./accounts.ts";

/**
 * The platform board contract: one snapshot a platform plugin answers with, drawn by one renderer.
 *
 * A board is data, never markup: a plugin picks section kinds and supplies rows, so the host needs no
 * branch per platform and a plugin cannot inject markup or script into the page. Every capability a
 * board claims carries `production`, `experimental` or `unavailable` and a reason when it is not
 * production: a section the upstream cannot support says so instead of showing invented numbers.
 */

export const BOARD_SECTION_KINDS = ["list", "timeline", "table", "queue", "chart", "form", "notice"] as const;
export type BoardSectionKind = (typeof BOARD_SECTION_KINDS)[number];

export const BOARD_CAPABILITY_STATES = ["production", "experimental", "unavailable"] as const;
export type BoardCapabilityState = (typeof BOARD_CAPABILITY_STATES)[number];

/** `manual` waits for the person in the board; `auto` runs as soon as its own limits allow. */
export const BOARD_ACTION_MODES = ["manual", "auto"] as const;
export type BoardActionMode = (typeof BOARD_ACTION_MODES)[number];

const nonEmpty = (max: number) => z.string().trim().min(1).max(max);
const rowKey = z.string().min(1).max(200);

/**
 * A row's cells are text or a small typed value. A cell never carries HTML: the renderer decides how
 * `status`, `count` and `money` look, so every platform's rows read the same way.
 */
export const boardCellSchema = z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.object({
    kind: z.enum(["text", "status", "count", "money", "time", "link", "badge"]),
    value: z.string().max(2_000),
    tone: z.enum(["normal", "accent", "warning", "danger", "muted"]).optional(),
    href: z.string().url().max(2_000).optional(),
  }).strict(),
]);
export type BoardCell = z.infer<typeof boardCellSchema>;

export const boardColumnSchema = z.object({
  key: rowKey,
  label: nonEmpty(80),
  align: z.enum(["start", "end"]).optional(),
  /** Columns a narrow screen drops first; the first column never hides. */
  priority: z.enum(["primary", "secondary"]).optional(),
}).strict();
export type BoardColumn = z.infer<typeof boardColumnSchema>;

export const boardRowSchema = z.object({
  id: rowKey,
  cells: z.record(rowKey, boardCellSchema),
  /** Where a row leads inside the board, such as a conversation to open. */
  opens: nonEmpty(200).optional(),
  tone: z.enum(["normal", "warning", "danger"]).optional(),
}).strict();
export type BoardRow = z.infer<typeof boardRowSchema>;

export const boardHeadlineSchema = z.object({
  key: rowKey,
  label: nonEmpty(60),
  value: z.string().max(120),
  hint: z.string().max(200).optional(),
  tone: z.enum(["normal", "accent", "warning", "danger"]).optional(),
}).strict();
export type BoardHeadline = z.infer<typeof boardHeadlineSchema>;

export const boardLimitSchema = z.object({
  key: rowKey,
  label: nonEmpty(80),
  used: z.number().int().min(0),
  cap: z.number().int().min(1),
  window: nonEmpty(40),
}).strict();
export type BoardLimit = z.infer<typeof boardLimitSchema>;

export const boardActionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  label: nonEmpty(80),
  effect: z.enum(["read", "draft", "control", "write", "send", "delete", "financial", "security"]),
  mode: z.enum(BOARD_ACTION_MODES),
  available: z.boolean(),
  /** Why the action is unavailable, or what it will do; shown as-is. */
  reason: z.string().max(400).optional(),
  /** A person must confirm each run even in `auto` mode. */
  confirm: z.boolean().optional(),
}).strict();
export type BoardAction = z.infer<typeof boardActionSchema>;

export const boardCapabilitySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  label: nonEmpty(80),
  state: z.enum(BOARD_CAPABILITY_STATES),
  reason: z.string().max(400).optional(),
}).strict().superRefine((capability, context) => {
  if (capability.state !== "production" && !capability.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "a capability that is not production says why" });
  }
});
export type BoardCapability = z.infer<typeof boardCapabilitySchema>;

export const boardNoticeSchema = z.object({
  tone: z.enum(["info", "warning", "danger"]),
  text: nonEmpty(1_000),
  action: z.object({ id: nonEmpty(64), label: nonEmpty(80) }).strict().optional(),
}).strict();
export type BoardNotice = z.infer<typeof boardNoticeSchema>;

export const boardFormFieldSchema = z.object({
  key: rowKey,
  label: nonEmpty(80),
  type: z.enum(["text", "number", "boolean", "select", "secret"]),
  value: z.union([z.string().max(20_000), z.number().finite(), z.boolean()]).optional(),
  placeholder: z.string().max(200).optional(),
  options: z.array(z.object({ value: nonEmpty(200), label: nonEmpty(80) }).strict()).max(100).optional(),
  help: z.string().max(400).optional(),
  secretSet: z.boolean().optional(),
}).strict().superRefine((field, context) => {
  if (field.type === "select" && !field.options?.length) {
    context.addIssue({ code: "custom", path: ["options"], message: "a select field lists its options" });
  }
});
export type BoardFormField = z.infer<typeof boardFormFieldSchema>;

const sectionBase = { id: rowKey, title: nonEmpty(80), hint: z.string().max(400).optional() };

export const boardSectionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...sectionBase,
    kind: z.literal("list"),
    items: z.array(z.object({
      id: rowKey,
      title: nonEmpty(200),
      subtitle: z.string().max(400).optional(),
      meta: z.string().max(200).optional(),
      tone: z.enum(["normal", "warning", "danger"]).optional(),
      opens: nonEmpty(200).optional(),
    }).strict()).max(200),
    empty: z.string().max(300).optional(),
  }).strict(),
  z.object({
    ...sectionBase,
    kind: z.literal("timeline"),
    entries: z.array(z.object({
      id: rowKey,
      at: z.string().datetime({ offset: true }),
      title: nonEmpty(200),
      detail: z.string().max(2_000).optional(),
      tone: z.enum(["normal", "warning", "danger"]).optional(),
    }).strict()).max(200),
    empty: z.string().max(300).optional(),
  }).strict(),
  z.object({
    ...sectionBase,
    kind: z.literal("table"),
    columns: z.array(boardColumnSchema).min(1).max(12),
    rows: z.array(boardRowSchema).max(500),
    empty: z.string().max(300).optional(),
  }).strict(),
  z.object({
    ...sectionBase,
    kind: z.literal("queue"),
    items: z.array(z.object({
      id: rowKey,
      title: nonEmpty(200),
      reason: nonEmpty(400),
      since: z.string().datetime({ offset: true }).optional(),
      actions: z.array(z.object({ id: nonEmpty(64), label: nonEmpty(80) }).strict()).max(4).optional(),
      tone: z.enum(["normal", "warning", "danger"]).optional(),
    }).strict()).max(200),
    empty: z.string().max(300).optional(),
  }).strict(),
  z.object({
    ...sectionBase,
    kind: z.literal("chart"),
    /** A Vega-Lite spec; the host renders it with its own theme and refuses anything it cannot draw. */
    spec: z.record(z.string(), z.unknown()),
    empty: z.string().max(300).optional(),
  }).strict(),
  z.object({
    ...sectionBase,
    kind: z.literal("form"),
    fields: z.array(boardFormFieldSchema).min(1).max(60),
    submitLabel: nonEmpty(80),
    action: nonEmpty(64),
    empty: z.string().max(300).optional(),
  }).strict(),
  z.object({
    ...sectionBase,
    kind: z.literal("notice"),
    notices: z.array(boardNoticeSchema).min(1).max(20),
  }).strict(),
]);
export type BoardSection = z.infer<typeof boardSectionSchema>;

export const boardAccountSchema = z.object({
  id: z.string().uuid(),
  displayName: nonEmpty(120),
  status: z.enum(["connected", "expired", "revoked", "unavailable"]),
  boundBotId: z.string().max(120).optional(),
  boundBotName: z.string().max(120).optional(),
  /** Where the platform runs: the reply rules, the automation mode and its last sync. */
  autoMode: z.enum(["off", "assist", "auto"]).optional(),
  lastSyncAt: z.string().datetime({ offset: true }).optional(),
  paused: z.boolean().optional(),
}).strict();
export type BoardAccount = z.infer<typeof boardAccountSchema>;

export const platformBoardSchema = z.object({
  schemaVersion: z.literal(1),
  platform: z.enum(PLATFORM_IDS),
  generatedAt: z.string().datetime({ offset: true }),
  account: boardAccountSchema.nullable(),
  headline: z.array(boardHeadlineSchema).max(6),
  sections: z.array(boardSectionSchema).max(24),
  actions: z.array(boardActionSchema).max(24),
  limits: z.array(boardLimitSchema).max(12),
  capability: z.array(boardCapabilitySchema).max(40),
}).strict();
export type PlatformBoard = z.infer<typeof platformBoardSchema>;

/** What the platform list and the sidebar read: a board's identity and health without its rows. */
export const platformSummarySchema = z.object({
  platform: z.enum(PLATFORM_IDS),
  label: nonEmpty(80),
  installationId: z.string().max(120).nullable(),
  /** The plugin answered `board` within the cache window. */
  live: z.boolean(),
  account: boardAccountSchema.nullable(),
  headline: z.array(boardHeadlineSchema).max(6),
  /** Why there is no board, when there is none. */
  error: z.string().max(400).optional(),
  /** A plugin declares the platform but is not active. */
  state: z.enum(["ready", "installed-disabled", "failed", "missing", "unavailable"]),
  /** Every capability the platform cannot do, so the entry point never promises it. */
  blocked: z.array(z.object({ id: nonEmpty(64), label: nonEmpty(80), reason: nonEmpty(400) }).strict()).max(20),
}).strict();
export type PlatformSummary = z.infer<typeof platformSummarySchema>;

export function parsePlatformBoard(input: unknown): { ok: true; board: PlatformBoard } | { ok: false; error: string } {
  const parsed = platformBoardSchema.safeParse(input);
  if (parsed.success) return { ok: true, board: parsed.data };
  const first = parsed.error.issues[0];
  const path = first?.path.join(".") ?? "";
  return { ok: false, error: `${path ? `${path}: ` : ""}${first?.message ?? "the board does not match the contract"}` };
}
